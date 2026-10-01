// sysmonitor@ajolote — monitoreo de CPU, RAM y GPU para Cinnamon.
// nvidia-smi corre de forma async para no bloquear el hilo principal del escritorio.

const Desklet = imports.ui.desklet;
const St = imports.gi.St;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Clutter = imports.gi.Clutter;
const Meta = imports.gi.Meta;
const Settings = imports.ui.settings;

let GdkPixbuf = null;
try { GdkPixbuf = imports.gi.GdkPixbuf; } catch (e) {}

// ── Helpers ───────────────────────────────────────────────────────────────────

// _decoder se reutiliza en cada lectura de /proc para no crear un objeto nuevo por tick.
// con un intervalo de 2 segundos no es un problema grave, pero es una práctica decente.
const _decoder = new TextDecoder('utf-8');

function _str(bytes) {
    if (!bytes) return '';
    try { return _decoder.decode(bytes); }
    catch (e) { return String(bytes); }
}

function readFile(path) {
    try {
        let file = Gio.File.new_for_path(path);
        let [ok, contents] = file.load_contents(null);
        if (ok) return _str(contents);
    } catch (e) {}
    return null;
}

// por encima de este porcentaje la barra se pone roja
const HOT_PCT = 85;

// necesitamos saber si hay algo en fullscreen para saltarnos el update.
// la API cambió entre versiones de Cinnamon — de ahí los dos try/catch.
function _isAnyWindowFullscreen() {
    try {
        let ws = global.screen.get_active_workspace();
        let windows = ws.list_windows();
        for (let i = 0; i < windows.length; i++) {
            if (windows[i].is_fullscreen()) return true;
        }
        return false;
    } catch (e) {}
    try {
        let windows = global.display.get_tab_list(Meta.TabList.NORMAL, null);
        for (let i = 0; i < windows.length; i++) {
            if (windows[i].is_fullscreen()) return true;
        }
    } catch (e) {}
    return false;
}

// ── Desklet ───────────────────────────────────────────────────────────────────

function SysMonitorDesklet(metadata, desklet_id) {
    this._init(metadata, desklet_id);
}

SysMonitorDesklet.prototype = {
    __proto__: Desklet.Desklet.prototype,

    _prevCpu: null,
    _gpuText: 'N/A',
    _gpuPct: 0,

    _init: function (metadata, desklet_id) {
        Desklet.Desklet.prototype._init.call(this, metadata, desklet_id);
        this._prevCpu = null;
        this._gpuText = 'N/A';
        this._gpuPct = 0;
        this._gpuFetching = false;

        // ── Settings ──────────────────────────────────────────────────────────
        this._updateMs        = 2000;
        this._showGpu         = true;
        this._widgetMinWidth  = 260;
        this._widgetMinHeight = 120;
        this._gpuSource       = 'auto';
        this._bgOpacity       = 55;
        this._autoOpacity     = false;
        this._wallpaperAlpha  = 55;
        this._pauseOnFullscreen = true;
        try {
            this._settings = new Settings.DeskletSettings(this, metadata.uuid, desklet_id);
            // estilo visual (tamaño, opacidad) — no necesita reconstruir widgets, solo refrescar el style
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'widget_min_width',    '_widgetMinWidth',    this._onStyleChanged,    null);
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'widget_min_height',   '_widgetMinHeight',   this._onStyleChanged,    null);
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'bg_opacity',          '_bgOpacity',         this._onStyleChanged,    null);
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'auto_opacity',        '_autoOpacity',       this._onAutoOpacityChanged, null);
            // intervalo del timer — solo hay que matar y recrear el timeout
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'update_ms',           '_updateMs',          this._onTimerChanged,    null);
            // fuente de GPU — el próximo _update() la usará automáticamente
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'gpu_source',          '_gpuSource',         this._onGpuSourceChanged, null);
            // visibilidad de la fila GPU — solo show/hide, sin reconstruir
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'show_gpu',            '_showGpu',           this._onGpuToggled,      null);
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'pause_on_fullscreen', '_pauseOnFullscreen', null,                    null);
        } catch (e) {}

        this._buildWidget();
        this._wallpaperAlpha = this._bgOpacity;
        this._initWallpaperReactivity();
        this._startTimer();
    },

    _buildWidget: function () {
        this._container = new St.BoxLayout({
            vertical: true,
            style_class: 'sysmon-container',
        });
        this._applyContainerStyle();

        this._cpuRow    = this._makeRow('CPU', '0%');
        this._cpuBar    = this._makeBar('sysmon-fill-cpu');
        this._ramRow    = this._makeRow('RAM', '0.0 / 0.0 GB');
        this._ramBar    = this._makeBar('sysmon-fill-ram');
        this._gpuRow    = this._makeRow('GPU', 'N/A');
        this._gpuBar    = this._makeBar('sysmon-fill-gpu');

        this._container.add_child(this._cpuRow.box);
        this._container.add_child(this._cpuBar.track);
        this._container.add_child(this._ramRow.box);
        this._container.add_child(this._ramBar.track);
        this._container.add_child(this._gpuRow.box);
        this._container.add_child(this._gpuBar.track);
        if (!this._showGpu) {
            this._gpuRow.box.hide();
            this._gpuBar.track.hide();
        }

        this.setContent(this._container);
        this.setHeader('');
    },

    _applyContainerStyle: function () {
        let opacityVal = this._autoOpacity ? this._wallpaperAlpha : this._bgOpacity;
        let alpha = Math.min(Math.max(opacityVal, 0), 100) / 100;
        this._container.set_style(
            'background-color: rgba(26, 27, 38, ' + alpha + ');' +
            'width: '        + this._widgetMinWidth  + 'px;'     +
            'min-width: '    + this._widgetMinWidth  + 'px;'     +
            'min-height: '   + this._widgetMinHeight + 'px;'     +
            'border-radius: 14px;'                               +
            'border: 1px solid rgba(65, 72, 104, 0.5);');
    },

    _startTimer: function () {
        if (this._timer) { GLib.source_remove(this._timer); this._timer = null; }
        this._update();
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._updateMs, () => {
            this._update();
            return GLib.SOURCE_CONTINUE;
        });
    },

    _makeRow: function (label, value) {
        let box = new St.BoxLayout({ style_class: 'sysmon-row' });
        let lbl = new St.Label({ text: label, style_class: 'sysmon-label' });
        let spacer = new St.Widget();
        spacer.set_x_expand(true);
        let val = new St.Label({ text: value, style_class: 'sysmon-value' });
        box.add_child(lbl);
        box.add_child(spacer);
        box.add_child(val);
        return { box: box, val: val };
    },

    // barra de progreso real: un track con un relleno cuyo ancho se calcula en px.
    // reemplaza las barras de ▓░ (un label de texto que se re-layouteaba en cada tick).
    _makeBar: function (fillClass) {
        let track = new St.Widget({ style_class: 'sysmon-track', clip_to_allocation: true });
        let fill  = new St.Widget({ style_class: fillClass });
        fill.set_width(0);
        track.add_child(fill);
        return { track: track, fill: fill, pct: -1, hot: false };
    },

    _setBar: function (bar, pct) {
        pct = Math.max(0, Math.min(100, pct));
        if (pct === bar.pct) return;
        bar.pct = pct;
        // ancho útil = ancho del widget menos el padding horizontal (14px × 2)
        bar.fill.set_width(Math.round((this._widgetMinWidth - 28) * pct / 100));
        let hot = pct >= HOT_PCT;
        if (hot !== bar.hot) {
            bar.hot = hot;
            if (hot) bar.fill.add_style_class_name('sysmon-hot');
            else bar.fill.remove_style_class_name('sysmon-hot');
        }
    },

    _setText: function (label, text) {
        if (label.get_text() !== text) label.set_text(text);
    },

    // CPU — lee /proc/stat y calcula el porcentaje comparando los deltas entre dos ticks.
    // el primer tick siempre devuelve 0 porque no tenemos un valor previo con qué comparar.
    _getCpuUsage: function () {
        let contents = readFile('/proc/stat');
        if (!contents) return 0;
        let parts = contents.split('\n')[0].trim().split(/\s+/);
        let user    = parseInt(parts[1]) || 0;
        let nice    = parseInt(parts[2]) || 0;
        let system  = parseInt(parts[3]) || 0;
        let idle    = parseInt(parts[4]) || 0;
        let iowait  = parseInt(parts[5]) || 0;
        let irq     = parseInt(parts[6]) || 0;
        let softirq = parseInt(parts[7]) || 0;
        let steal   = parseInt(parts[8]) || 0;

        let totalIdle    = idle + iowait;
        let totalNonIdle = user + nice + system + irq + softirq + steal;
        let total        = totalIdle + totalNonIdle;
        let pct = 0;
        if (this._prevCpu) {
            let dTotal = total - this._prevCpu.total;
            let dIdle  = totalIdle - this._prevCpu.idle;
            if (dTotal > 0) pct = ((dTotal - dIdle) / dTotal) * 100;
        }
        this._prevCpu = { total: total, idle: totalIdle };
        return Math.round(Math.max(0, Math.min(100, pct)));
    },

    // RAM — usamos MemAvailable en vez de MemFree porque MemFree no incluye
    // la memoria que el kernel liberaría si la necesitara (caché, buffers, etc.)
    _getRamUsage: function () {
        let contents = readFile('/proc/meminfo');
        if (!contents) return { pct: 0, text: 'N/A' };
        let total = 0, available = 0;
        for (let line of contents.split('\n')) {
            if (line.startsWith('MemTotal:'))     total     = parseInt(line.split(/\s+/)[1]);
            if (line.startsWith('MemAvailable:')) available = parseInt(line.split(/\s+/)[1]);
        }
        if (total === 0) return { pct: 0, text: 'N/A' };
        let used = total - available;
        return {
            pct:  Math.round((used / total) * 100),
            text: (used / 1048576).toFixed(1) + ' / ' + (total / 1048576).toFixed(1) + ' GB',
        };
    },

    // GPU — es async porque nvidia-smi tarda unos 200-300ms en responder.
    // mostramos el resultado del tick anterior mientras el nuevo corre en background.
    // para AMD usamos sysfs (instantáneo); para NVIDIA lanzamos nvidia-smi como subprocess.
    // _gpuSource: 'auto' | 'amd' | 'nvidia'
    _fetchGpuAsync: function () {
        if (this._gpuFetching) return;
        this._gpuFetching = true;

        let src = this._gpuSource || 'auto';

        // ── AMD via sysfs ─────────────────────────────────────────────────────
        if (src === 'auto' || src === 'amd') {
            // recordamos qué cardN respondió para no probar las 5 en cada tick
            let cards = this._amdCard !== undefined ? [this._amdCard] : [0, 1, 2, 3, 4];
            for (let i of cards) {
                let amdLoad = readFile('/sys/class/drm/card' + i + '/device/gpu_busy_percent');
                let pct = amdLoad !== null ? parseInt(amdLoad.trim()) : NaN;
                if (!isNaN(pct)) {
                    this._amdCard = i;
                    this._gpuPct  = pct;
                    this._gpuText = pct + '% AMD';
                    this._gpuFetching = false;
                    return;
                }
            }
            this._amdCard = undefined;
            // if forced AMD and nothing found, give up — no tiene sentido caer al path de nvidia
            if (src === 'amd') {
                this._gpuText = 'N/A';
                this._gpuFetching = false;
                return;
            }
        }

        // ── NVIDIA via nvidia-smi async ───────────────────────────────────────
        try {
            let proc = new Gio.Subprocess({
                argv: ['nvidia-smi',
                       '--query-gpu=utilization.gpu,memory.used,memory.total',
                       '--format=csv,noheader,nounits'],
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
            });
            proc.init(null);
            proc.communicate_utf8_async(null, null, (p, res) => {
                this._gpuFetching = false;
                if (this._destroyed) return;
                try {
                    let [, stdout] = p.communicate_utf8_finish(res);
                    if (!stdout) { this._gpuText = 'N/A'; return; }
                    let parts = stdout.trim().split(',').map(s => s.trim());
                    let pct   = parseInt(parts[0]);
                    if (isNaN(pct)) { this._gpuText = 'N/A'; return; }
                    this._gpuPct = pct;
                    let memText = '';
                    if (parts.length >= 3) {
                        let usedMB  = parseInt(parts[1]);
                        let totalMB = parseInt(parts[2]);
                        if (!isNaN(usedMB) && !isNaN(totalMB))
                            memText = ' ' + (usedMB / 1024).toFixed(1)
                                    + '/' + (totalMB / 1024).toFixed(1) + 'G';
                    }
                    this._gpuText = pct + '%' + memText + ' NV';
                } catch (e) {
                    this._gpuText = 'N/A';
                }
            });
        } catch (e) {
            // nvidia-smi no existe: no tiene sentido relanzar el spawn cada 2s
            this._gpuFetching = false;
            this._gpuText = 'N/A';
            this._gpuDead = true;
        }
    },

    _update: function () {
        if (this._pauseOnFullscreen && _isAnyWindowFullscreen()) return;
        let cpu = this._getCpuUsage();
        this._setText(this._cpuRow.val, cpu + '%');
        this._setBar(this._cpuBar, cpu);

        let ram = this._getRamUsage();
        this._setText(this._ramRow.val, ram.text);
        this._setBar(this._ramBar, ram.pct);

        if (this._showGpu) {
            // mostramos el dato del ciclo anterior mientras el nuevo fetch corre async.
            // al usuario no le importa si el dato tiene 2 segundos de retraso.
            this._setText(this._gpuRow.val, this._gpuText);
            this._setBar(this._gpuBar, this._gpuPct);
            if (!this._gpuDead) this._fetchGpuAsync();
        }
    },

    _onStyleChanged: function () {
        this._applyContainerStyle();
        for (let b of [this._cpuBar, this._ramBar, this._gpuBar]) { let p = b.pct; b.pct = -1; this._setBar(b, p); }
    },

    _onAutoOpacityChanged: function () {
        if (this._autoOpacity) this._sampleWallpaper();
        this._applyContainerStyle();
    },

    _initWallpaperReactivity: function () {
        try {
            this._bgSettings = new Gio.Settings({ schema: 'org.cinnamon.desktop.background' });
            this._bgSignalId = this._bgSettings.connect('changed::picture-uri', () => {
                if (this._autoOpacity) {
                    this._sampleWallpaper();
                    this._applyContainerStyle();
                }
            });
            if (this._autoOpacity) this._sampleWallpaper();
        } catch (e) {
            this._bgSettings = null;
            this._bgSignalId = null;
        }
    },

    _sampleWallpaper: function () {
        if (!GdkPixbuf || !this._bgSettings) return;
        try {
            let uri = this._bgSettings.get_string('picture-uri');
            if (!uri) return;
            let path;
            try { path = GLib.filename_from_uri(uri)[0]; }
            catch (e) { path = uri.replace(/^file:\/\//, ''); }
            if (!path || !GLib.file_test(path, GLib.FileTest.EXISTS)) return;
            let pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 64, 64, false);
            let pixels = pixbuf.get_pixels();
            let n_chan  = pixbuf.get_n_channels();
            let total = 0, count = 0;
            for (let i = 0; i < pixbuf.get_width() * pixbuf.get_height(); i++) {
                let b = i * n_chan;
                total += 0.299 * pixels[b] + 0.587 * pixels[b + 1] + 0.114 * pixels[b + 2];
                count++;
            }
            if (count === 0) return;
            let brightness = (total / count) / 255;
            this._wallpaperAlpha = Math.round((0.30 + brightness * 0.55) * 100);
        } catch (e) {}
    },

    _onTimerChanged: function () {
        this._startTimer();
    },

    _onGpuToggled: function () {
        if (this._showGpu) {
            this._gpuRow.box.show();
            this._gpuBar.track.show();
        } else {
            this._gpuRow.box.hide();
            this._gpuBar.track.hide();
        }
    },

    // gpu_source cambió: reseteamos el caché para que el próximo fetch use la nueva fuente
    // sin mostrar datos obsoletos de la fuente anterior
    _onGpuSourceChanged: function () {
        this._gpuPct     = 0;
        this._gpuText    = 'N/A';
        this._gpuFetching = false;
        this._gpuDead     = false;
        this._amdCard     = undefined;
    },

    on_desklet_removed: function () {
        this._destroyed = true;
        if (this._bgSettings && this._bgSignalId) {
            try { this._bgSettings.disconnect(this._bgSignalId); } catch (e) {}
            this._bgSignalId = null;
        }
        if (this._timer) { GLib.source_remove(this._timer); this._timer = null; }
        if (this._settings) { try { this._settings.finalize(); } catch (e) {} }
    },
};

function main(metadata, desklet_id) {
    return new SysMonitorDesklet(metadata, desklet_id);
}
