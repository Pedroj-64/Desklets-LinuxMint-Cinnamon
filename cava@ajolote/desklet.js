// cava@ajolote — Visualizador de audio v3 para Cinnamon
//
// La primera versión ponía un St.Label por barra y les cambiaba el color con set_style().
// Con 32 barras a 25fps eso era 32 × 25 = 800 llamadas de estilo por segundo — horrible.
// Reescribí todo con St.DrawingArea + Cairo: una sola pasada de dibujo por frame,
// gradiente vertical por barra (#7aa2f7 → base oscuro), top redondeado estilo Hyprland,
// picos con hold+caída. Mucho más suave y sin tirones en el CPU.

const Desklet  = imports.ui.desklet;
const St       = imports.gi.St;
const GLib     = imports.gi.GLib;
const Gio      = imports.gi.Gio;
const Cairo    = imports.gi.cairo;
const Meta     = imports.gi.Meta;
const Settings = imports.ui.settings;

let GdkPixbuf = null;
try { GdkPixbuf = imports.gi.GdkPixbuf; } catch (e) {}

const CONFIG_PATH = GLib.get_tmp_dir() + '/cava_desklet.conf';
const PEAK_HOLD   = 22;
const PEAK_FALL   = 1.5;

// TextDecoder/TextEncoder se reutilizan en cada línea que llega de cava.
// si los creáramos dentro del callback estaríamos allocando objetos a 25fps, que es absurdo.
const _decoder = new TextDecoder('utf-8');
const _encoder = new TextEncoder();

// colores del gradiente vertical por barra.
// top: #7aa2f7 (tokyonight blue) — el color principal del tema.
// bottom: #1e3463 — mismo azul pero muy oscuro y casi transparente, así la barra se desvanece.
const BAR_TOP    = [0.478, 0.635, 0.969];
const BAR_BOTTOM = [0.118, 0.204, 0.388];

// necesitamos saber si hay algo en fullscreen para pausar el visualizador.
// la API cambió entre versiones de Cinnamon: las recientes tienen get_active_workspace()
// en global.screen; las viejas solo exponen get_tab_list() en global.display.
// de ahí los dos try/catch en lugar de un if/else simple.
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

function writeCavaConfig(numBars, framerate, noiseReduction) {
    let cfg = [
        '[general]',
        'bars = ' + numBars,
        'framerate = ' + framerate,
        '',
        '[output]',
        'method = raw',
        'raw_target = /dev/stdout',
        'data_format = ascii',
        'ascii_max_range = 100',
        '',
        '[smoothing]',
        'noise_reduction = ' + noiseReduction,
        '',
    ].join('\n');
    try {
        Gio.File.new_for_path(CONFIG_PATH).replace_contents(
            _encoder.encode(cfg), null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    } catch (e) {}
}

// ── Desklet ───────────────────────────────────────────────────────────────────

function CavaDesklet(metadata, desklet_id) {
    this._init(metadata, desklet_id);
}

CavaDesklet.prototype = {
    __proto__: Desklet.Desklet.prototype,

    _init: function (metadata, desklet_id) {
        Desklet.Desklet.prototype._init.call(this, metadata, desklet_id);
        this._cavaDead = true;

        // valores por defecto — los settings los pisan al arrancar, pero necesitamos
        // algo sensato antes de que el binding de propiedades se inicialice
        this._numBars        = 32;
        this._barHeight      = 100;
        this._barWidth       = 5;
        this._barGap         = 3;
        this._showPeaks      = true;
        this._mirror         = false;
        this._sidePadding    = 8;
        this._framerate      = 25;
        this._noiseReduction = 66;
        this._bgOpacity      = 55;
        this._autoOpacity    = false;
        this._wallpaperAlpha = 55;
        this._pauseOnFullscreen  = true;
        this._pausedByFullscreen = false;

        try {
            this._settings = new Settings.DeskletSettings(this, metadata.uuid, desklet_id);

            // cambios de layout (número de barras, ancho, alto, gap, padding) implican
            // destruir y reconstruir el DrawingArea y reiniciar cava con la config nueva
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'num_bars',    '_numBars',     this._onLayoutChanged, null);
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'bar_height',  '_barHeight',   this._onLayoutChanged, null);
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'bar_width',   '_barWidth',    this._onLayoutChanged, null);
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'bar_gap',     '_barGap',      this._onLayoutChanged, null);
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'side_padding','_sidePadding', this._onLayoutChanged, null);

            // apariencia: solo un repaint, no hace falta reiniciar cava ni reconstruir nada
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'show_peaks',  '_showPeaks',   this._onAppearanceChanged, null);
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'mirror',      '_mirror',      this._onAppearanceChanged, null);
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'bg_opacity',  '_bgOpacity',   this._onAppearanceChanged, null);
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'auto_opacity','_autoOpacity', this._onAutoOpacityChanged, null);

            // rendimiento: hay que regenerar la config de cava en disco y reiniciarlo
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'framerate',         '_framerate',        this._onCavaConfigChanged, null);
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'noise_reduction',   '_noiseReduction',   this._onCavaConfigChanged, null);

            // pausa en fullscreen — solo lo lee en el poll de 3 segundos, no necesita callback
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'pause_on_fullscreen', '_pauseOnFullscreen', null, null);
        } catch (e) {}

        this._proc       = null;
        this._dataStream = null;
        this._initArrays();
        this._buildWidget();
        this._wallpaperAlpha = this._bgOpacity;
        this._initWallpaperReactivity();
        this._applyContainerStyle();
        writeCavaConfig(this._numBars, this._framerate, this._noiseReduction);
        this._startCava();
        this._startFullscreenPoll();
    },

    _initArrays: function () {
        let n = this._numBars;
        this._values   = new Array(n).fill(0);
        this._display  = new Array(n).fill(0);
        this._peaks    = new Array(n).fill(0);
        this._peakHold = new Array(n).fill(0);
    },

    // ── UI ────────────────────────────────────────────────────────────────────

    _buildWidget: function () {
        let n   = this._numBars;
        let bw  = this._barWidth;
        let bg  = this._barGap;
        let bh  = this._barHeight;
        let pad = this._sidePadding;
        let totalW = n * (bw + bg) - bg;

        this._container = new St.Widget({ style_class: 'cava-container' });
        this._applyContainerStyle();

        // St.DrawingArea es donde Cairo dibuja cada frame — no hay widgets hijo por barra,
        // todo el dibujo pasa en _onRepaint() con una sola llamada de Cairo
        this._area = new St.DrawingArea({ width: totalW, height: bh });
        this._area.set_position(pad, pad);
        this._repaintId = this._area.connect('repaint', (a) => this._onRepaint(a));

        this._container.add_child(this._area);
        this.setContent(this._container);
        this.setHeader('');
    },

    // ── Repaint (Cairo) ───────────────────────────────────────────────────────

    _onRepaint: function (area) {
        let cr  = area.get_context();
        let n   = this._numBars;
        let bw  = this._barWidth;
        let bg  = this._barGap;
        let bh  = this._barHeight;
        let mi  = this._mirror;
        let sp  = this._showPeaks;

        // limpiamos el área con transparente total para que el fondo del container
        // (que viene del inline style) se vea a través
        cr.setSourceRGBA(0, 0, 0, 0);
        cr.paint();

        // radio del redondeo en el top de cada barra — máximo 5px para que no se vea burdo
        let rad = Math.min(Math.floor(bw / 2), 5);

        for (let i = 0; i < n; i++) {
            let raw = this._values[i];
            let d   = this._display[i];

            // interpolación asimétrica: sube rápido (60%) y baja despacio (25%).
            // se ve mucho más fluido y "vivo" que una interpolación lineal uniforme.
            this._display[i] = (raw >= d)
                ? d * 0.40 + raw * 0.60
                : d * 0.75 + raw * 0.25;

            let dv = Math.max(0, Math.min(100, this._display[i]));
            if (dv < 1) continue;

            let x = i * (bw + bg);
            let h = Math.max(2, Math.round(bh * dv / 100));
            let y = mi ? Math.floor((bh - h) / 2) : bh - h;

            // gradiente vertical: tokyonight blue arriba, oscuro casi transparente abajo.
            // el stop de abajo tiene alpha 0.25 así las barras se "funden" con el fondo.
            let grad = new Cairo.LinearGradient(x, y, x, y + h);
            grad.addColorStopRGBA(0.0, BAR_TOP[0],    BAR_TOP[1],    BAR_TOP[2],    0.92);
            grad.addColorStopRGBA(1.0, BAR_BOTTOM[0], BAR_BOTTOM[1], BAR_BOTTOM[2], 0.25);
            cr.setSource(grad);

            // top redondeado solo en modo normal (barras crecen hacia arriba).
            // en modo espejo (crecen desde el centro) queda raro con redondeo, así que va recto.
            if (!mi && h > rad * 2 && rad > 1) {
                cr.newPath();
                cr.moveTo(x,        y + h);
                cr.lineTo(x,        y + rad);
                cr.arc(x + rad, y + rad, rad, Math.PI, 0);
                cr.lineTo(x + bw, y + h);
                cr.closePath();
            } else {
                cr.rectangle(x, y, bw, h);
            }
            cr.fill();

            // ── Pico ──────────────────────────────────────────────────────────
            if (sp) {
                if (raw >= this._peaks[i]) {
                    this._peaks[i]    = raw;
                    this._peakHold[i] = PEAK_HOLD;  // mantiene el pico fijo N frames
                } else if (this._peakHold[i] > 0) {
                    this._peakHold[i]--;
                } else {
                    this._peaks[i] = Math.max(0, this._peaks[i] - PEAK_FALL);
                }

                if (this._peaks[i] > 3) {
                    let ph = Math.round(bh * this._peaks[i] / 100);
                    let py = mi
                        ? Math.max(0, Math.floor((bh - ph) / 2) - 3)
                        : Math.max(0, bh - ph - 3);
                    // línea del pico: mismo azul pero más tenue (alpha 0.5) para que no compita con la barra
                    cr.setSourceRGBA(BAR_TOP[0], BAR_TOP[1], BAR_TOP[2], 0.5);
                    cr.rectangle(x, py, bw, 2);
                    cr.fill();
                }
            }
        }

        // hay que hacer dispose() del context de Cairo o GJS acumula objetos en memoria.
        // en versiones viejas de GJS $dispose no existe, de ahí el try/catch.
        try { cr.$dispose(); } catch (e) {}
    },

    // ── cava subprocess ───────────────────────────────────────────────────────

    _startCava: function () {
        this._stopCava();
        this._cavaDead = false;
        this._initArrays();

        try {
            this._proc = new Gio.Subprocess({
                argv:  ['cava', '-p', CONFIG_PATH],
                flags: Gio.SubprocessFlags.STDOUT_PIPE
                     | Gio.SubprocessFlags.STDERR_SILENCE,
            });
            this._proc.init(null);
            this._dataStream = new Gio.DataInputStream({
                base_stream:  this._proc.get_stdout_pipe(),
                buffer_size:  4096,
            });
            this._readLine();
        } catch (e) {
            // si cava no está instalado, el área simplemente queda vacía y ya
        }
    },

    _stopCava: function () {
        this._cavaDead   = true;
        this._dataStream = null;
        if (this._proc) {
            try { this._proc.force_exit(); } catch (e) {}
            this._proc = null;
        }
    },

    _readLine: function () {
        if (this._cavaDead || !this._dataStream) return;
        let ds = this._dataStream;
        ds.read_line_async(GLib.PRIORITY_DEFAULT, null, (source, res) => {
            if (this._cavaDead || this._dataStream !== ds) return;
            try {
                let [lineBytes] = source.read_line_finish(res);
                if (lineBytes === null) {
                    // cava se cayó (EOF en stdout) — esperamos 2 segundos y reintentamos
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
                        if (!this._cavaDead) this._startCava();
                        return GLib.SOURCE_REMOVE;
                    });
                    return;
                }
                let line;
                try { line = _decoder.decode(lineBytes); }
                catch (e) { line = String(lineBytes); }

                this._parseLine(line.trim());
                if (this._area) this._area.queue_repaint();
                this._readLine();
            } catch (e) {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
                    if (!this._cavaDead) this._startCava();
                    return GLib.SOURCE_REMOVE;
                });
            }
        });
    },

    _parseLine: function (line) {
        if (!line) return;
        let parts = line.split(';');
        let n = Math.min(this._numBars, parts.length);
        for (let i = 0; i < n; i++) {
            let v = parseInt(parts[i]);
            if (!isNaN(v)) this._values[i] = Math.max(0, Math.min(100, v));
        }
    },

    // ── Settings change: reconstruye todo ────────────────────────────────────

    // cambió algo del layout — hay que tirar el widget y reconstruirlo desde cero.
    // también desconectamos el repaint antes de destruir el área vieja para no dejar
    // señales colgadas que apunten a un objeto muerto.
    _onLayoutChanged: function () {
        this._stopCava();
        // soltamos el repaint antes de tirar el área vieja
        if (this._area && this._repaintId) {
            try { this._area.disconnect(this._repaintId); } catch (e) {}
            this._repaintId = null;
        }
        this._buildWidget();
        writeCavaConfig(this._numBars, this._framerate, this._noiseReduction);
        // solo reinicia cava si no estamos pausados por fullscreen
        if (!this._pausedByFullscreen) this._startCava();
    },

    _applyContainerStyle: function () {
        if (!this._container) return;
        let n   = this._numBars;
        let bw  = this._barWidth;
        let bg  = this._barGap;
        let bh  = this._barHeight;
        let pad = this._sidePadding;
        let totalW = n * (bw + bg) - bg;
        let opacityVal = this._autoOpacity ? this._wallpaperAlpha : this._bgOpacity;
        let alpha  = (opacityVal !== undefined ? opacityVal : 55) / 100;
        this._container.set_style(
            'width: '  + (totalW + pad * 2) + 'px;' +
            'height: ' + (bh + pad * 2)     + 'px;' +
            'background-color: rgba(26,27,38,' + alpha + ');' +
            'border-radius: 14px;' +
            'border: 1px solid rgba(65,72,104,0.5);'
        );
    },

    // show_peaks, mirror, bg_opacity solo afectan cómo se dibuja — no hace falta
    // reiniciar cava ni reconstruir widgets, solo un repaint
    _onAppearanceChanged: function () {
        this._applyContainerStyle();
        if (this._area) this._area.queue_repaint();
    },

    _onAutoOpacityChanged: function () {
        if (this._autoOpacity) this._sampleWallpaper();
        this._applyContainerStyle();
        if (this._area) this._area.queue_repaint();
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

    // framerate y noise_reduction van directo a la config de cava en disco;
    // hay que reiniciarlo para que lea los nuevos valores
    _onCavaConfigChanged: function () {
        writeCavaConfig(this._numBars, this._framerate, this._noiseReduction);
        if (!this._pausedByFullscreen) {
            this._stopCava();
            this._startCava();
        }
    },

    // ── Fullscreen poll ───────────────────────────────────────────────────────

    _startFullscreenPoll: function () {
        if (this._fullscreenTimer) return;
        // cada 3 segundos — baratísimo: solo itera la lista de ventanas del workspace
        this._fullscreenTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
            this._checkFullscreen();
            return GLib.SOURCE_CONTINUE;
        });
    },

    _checkFullscreen: function () {
        let fs = this._pauseOnFullscreen && _isAnyWindowFullscreen();
        if (fs && !this._pausedByFullscreen) {
            // acaba de entrar a fullscreen → matamos cava para no desperdiciar CPU
            this._pausedByFullscreen = true;
            this._stopCava();
        } else if (!fs && this._pausedByFullscreen) {
            // salió de fullscreen → retomamos cava
            this._pausedByFullscreen = false;
            this._startCava();
        }
    },

    on_desklet_removed: function () {
        this._stopCava();
        if (this._bgSettings && this._bgSignalId) {
            try { this._bgSettings.disconnect(this._bgSignalId); } catch (e) {}
            this._bgSignalId = null;
        }
        if (this._fullscreenTimer) {
            GLib.source_remove(this._fullscreenTimer);
            this._fullscreenTimer = null;
        }
        if (this._area && this._repaintId) {
            try { this._area.disconnect(this._repaintId); } catch (e) {}
        }
        // limpiamos el archivo de config temporal — no tiene sentido dejarlo en /tmp
        try { Gio.File.new_for_path(CONFIG_PATH).delete(null); } catch (e) {}
        if (this._settings) { try { this._settings.finalize(); } catch (e) {} }
    },
};

function main(metadata, desklet_id) {
    return new CavaDesklet(metadata, desklet_id);
}
