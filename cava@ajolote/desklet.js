// cava@ajolote — Visualizador de audio v3 para Cinnamon
//
// Reescribí esto con St.DrawingArea + Cairo porque tener 32 widgets
// haciendo set_style() por frame era un desastre. Ahora todo el dibujo
// pasa en una sola pasada de Cairo con estilo Hyprland: barras con top
// redondeado, gradiente vertical por barra (#7aa2f7 → base oscuro),
// fondo semi-transparente, sin glow, picos con hold+caída.

const Desklet  = imports.ui.desklet;
const St       = imports.gi.St;
const GLib     = imports.gi.GLib;
const Gio      = imports.gi.Gio;
const Cairo    = imports.gi.cairo;
const Settings = imports.ui.settings;

const CONFIG_PATH = GLib.get_tmp_dir() + '/cava_desklet.conf';
const PEAK_HOLD   = 22;
const PEAK_FALL   = 1.5;

// colores del gradiente vertical por barra
// top: #7aa2f7 (tokyonight blue)  bottom: #1e3463 (base oscuro)
const BAR_TOP    = [0.478, 0.635, 0.969];
const BAR_BOTTOM = [0.118, 0.204, 0.388];

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
            new TextEncoder().encode(cfg), null, false,
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

        // defaults — los settings los pisan al arrancar
        this._numBars        = 32;
        this._barHeight      = 100;
        this._barWidth       = 5;
        this._barGap         = 3;
        this._showPeaks      = true;
        this._mirror         = false;
        this._sidePadding    = 8;
        this._framerate      = 25;
        this._noiseReduction = 66;

        try {
            this._settings = new Settings.DeskletSettings(this, metadata.uuid, desklet_id);

            // cambios de layout: reconstruyen el widget y reinician cava
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

            // apariencia: solo un repaint, sin reiniciar cava
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'show_peaks',  '_showPeaks',   this._onAppearanceChanged, null);
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'mirror',      '_mirror',      this._onAppearanceChanged, null);

            // rendimiento: regenera la config de cava y lo reinicia
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'framerate',       '_framerate',      this._onCavaConfigChanged, null);
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'noise_reduction', '_noiseReduction', this._onCavaConfigChanged, null);
        } catch (e) {}

        this._proc       = null;
        this._dataStream = null;
        this._initArrays();
        this._buildWidget();
        writeCavaConfig(this._numBars, this._framerate, this._noiseReduction);
        this._startCava();
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

        this._container = new St.Widget({
            style_class: 'cava-container',
            width:  totalW + pad * 2,
            height: bh + pad * 2,
        });

        // St.DrawingArea — acá pasa todo el dibujo con Cairo
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

        // el fondo viene del CSS, acá solo limpiamos el área
        cr.setSourceRGBA(0, 0, 0, 0);
        cr.paint();

        // radio del redondeo en el top de cada barra (máx 5px)
        let rad = Math.min(Math.floor(bw / 2), 5);

        for (let i = 0; i < n; i++) {
            let raw = this._values[i];
            let d   = this._display[i];

            // sube rápido y baja despacio — se ve más fluido que lineal
            this._display[i] = (raw >= d)
                ? d * 0.40 + raw * 0.60
                : d * 0.75 + raw * 0.25;

            let dv = Math.max(0, Math.min(100, this._display[i]));
            if (dv < 1) continue;

            let x = i * (bw + bg);
            let h = Math.max(2, Math.round(bh * dv / 100));
            let y = mi ? Math.floor((bh - h) / 2) : bh - h;

            // gradiente: tokyonight arriba, oscuro casi transparente abajo
            let grad = new Cairo.LinearGradient(x, y, x, y + h);
            grad.addColorStopRGBA(0.0, BAR_TOP[0],    BAR_TOP[1],    BAR_TOP[2],    0.92);
            grad.addColorStopRGBA(1.0, BAR_BOTTOM[0], BAR_BOTTOM[1], BAR_BOTTOM[2], 0.25);
            cr.setSource(grad);

            // top redondeado solo en modo normal — en espejo va recto
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
                    this._peakHold[i] = PEAK_HOLD;
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
                    // línea del pico, mismo azul pero más tenue
                    cr.setSourceRGBA(BAR_TOP[0], BAR_TOP[1], BAR_TOP[2], 0.5);
                    cr.rectangle(x, py, bw, 2);
                    cr.fill();
                }
            }
        }

        // hay que hacer dispose del context o hay memory leak
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
            // si no está cava instalado, el área queda vacía y ya
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
                    // se cayó cava, reintentamos en 2 segundos
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
                        if (!this._cavaDead) this._startCava();
                        return GLib.SOURCE_REMOVE;
                    });
                    return;
                }
                let line;
                try { line = new TextDecoder('utf-8').decode(lineBytes); }
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

    // cambió el tamaño del widget, hay que tirar todo y reconstruir
    _onLayoutChanged: function () {
        this._stopCava();
        // soltamos el repaint antes de tirar el área vieja
        if (this._area && this._repaintId) {
            try { this._area.disconnect(this._repaintId); } catch (e) {}
            this._repaintId = null;
        }
        this._buildWidget();
        writeCavaConfig(this._numBars, this._framerate, this._noiseReduction);
        this._startCava();
    },

    // show_peaks, mirror — solo afectan el dibujo, no hace falta reiniciar cava
    _onAppearanceChanged: function () {
        if (this._area) this._area.queue_repaint();
    },

    // framerate, noise_reduction — solo hay que regenerar la config y reiniciar cava
    _onCavaConfigChanged: function () {
        writeCavaConfig(this._numBars, this._framerate, this._noiseReduction);
        this._stopCava();
        this._startCava();
    },

    on_desklet_removed: function () {
        this._stopCava();
        if (this._area && this._repaintId) {
            try { this._area.disconnect(this._repaintId); } catch (e) {}
        }
        try { Gio.File.new_for_path(CONFIG_PATH).delete(null); } catch (e) {}
        if (this._settings) { try { this._settings.finalize(); } catch (e) {} }
    },
};

function main(metadata, desklet_id) {
    return new CavaDesklet(metadata, desklet_id);
}
