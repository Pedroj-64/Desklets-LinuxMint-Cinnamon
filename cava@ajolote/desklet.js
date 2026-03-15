// cava@ajolote — Visualizador de audio con barras para Cinnamon
// Corre cava como subproceso con salida ASCII; dibuja 32 barras
// Colores degradado tokyonight: #7aa2f7 → #9a7ecc

const Desklet = imports.ui.desklet;
const St = imports.gi.St;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Clutter = imports.gi.Clutter;

const NUM_BARS = 32;
const BAR_WIDTH = 7;        // px por barra
const BAR_GAP = 2;          // px entre barras
const DISPLAY_HEIGHT = 80;  // px altura del área
const CONFIG_PATH = GLib.get_tmp_dir() + '/cava_desklet.conf';

// Degradado tokyonight: azul → morado según posición de barra
function barColor(i, n) {
    let t = n <= 1 ? 0 : i / (n - 1);
    let r = Math.round(122 + (154 - 122) * t);
    let g = Math.round(162 + (126 - 162) * t);
    let b = Math.round(247 + (204 - 247) * t);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
}

function writeCavaConfig() {
    let config = [
        '[general]',
        'bars = ' + NUM_BARS,
        'framerate = 17',
        '',
        '[output]',
        'method = raw',
        'raw_target = /dev/stdout',
        'data_format = ascii',
        'ascii_max_range = 100',
        '',
        '[smoothing]',
        'noise_reduction = 77',
        '',
    ].join('\n');
    try {
        let file = Gio.File.new_for_path(CONFIG_PATH);
        let bytes = new TextEncoder().encode(config);
        file.replace_contents(bytes, null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    } catch (e) {}
}

function CavaDesklet(metadata, desklet_id) {
    this._init(metadata, desklet_id);
}

CavaDesklet.prototype = {
    __proto__: Desklet.Desklet.prototype,

    _values: null,
    _proc: null,
    _dataStream: null,

    _init: function (metadata, desklet_id) {
        Desklet.Desklet.prototype._init.call(this, metadata, desklet_id);
        this._values = new Array(NUM_BARS).fill(0);

        // Contenedor externo
        this._container = new St.Widget({
            style_class: 'cava-container',
            width: NUM_BARS * (BAR_WIDTH + BAR_GAP) + 16,
            height: DISPLAY_HEIGHT + 12,
        });

        // Área de barras: posicionamiento absoluto
        this._barsArea = new St.Widget({
            width: NUM_BARS * (BAR_WIDTH + BAR_GAP),
            height: DISPLAY_HEIGHT,
        });
        this._barsArea.set_position(8, 6);
        this._container.add_child(this._barsArea);

        // Crear barra widgets
        this._bars = [];
        for (let i = 0; i < NUM_BARS; i++) {
            let bar = new St.Widget({
                width: BAR_WIDTH,
                height: 2,
            });
            let color = barColor(i, NUM_BARS);
            bar.set_style(
                'background-color: ' + color + ';'
                + 'border-radius: 2px 2px 0 0;'
                + 'width: ' + BAR_WIDTH + 'px;'
                + 'height: 2px;'
            );
            bar.set_position(i * (BAR_WIDTH + BAR_GAP), DISPLAY_HEIGHT - 2);
            this._barsArea.add_child(bar);
            this._bars.push({ widget: bar, color: color });
        }

        this.setContent(this._container);
        this.setHeader('');

        writeCavaConfig();
        this._startCava();
    },

    _startCava: function () {
        try {
            this._proc = new Gio.Subprocess({
                argv: ['cava', '-p', CONFIG_PATH],
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
            });
            this._proc.init(null);

            let stdout = this._proc.get_stdout_pipe();
            this._dataStream = new Gio.DataInputStream({
                base_stream: stdout,
                buffer_size: 4096,
            });

            this._readLine();
        } catch (e) {
            // cava no disponible: animar con ceros
            this._fallbackTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
                this._renderBars();
                return GLib.SOURCE_CONTINUE;
            });
        }
    },

    _readLine: function () {
        this._dataStream.read_line_async(GLib.PRIORITY_DEFAULT, null, (source, res) => {
            try {
                let [lineBytes] = source.read_line_finish(res);
                if (lineBytes !== null) {
                    let line;
                    try { line = new TextDecoder('utf-8').decode(lineBytes); }
                    catch (e) { line = String(lineBytes); }

                    this._parseLine(line.trim());
                    this._renderBars();
                    // Continúa leyendo
                    this._readLine();
                }
                // Si lineBytes === null, cava terminó; no relanzar
            } catch (e) {
                // Reintenta tras 2 segundos si cava cae
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
                    this._startCava();
                    return GLib.SOURCE_REMOVE;
                });
            }
        });
    },

    _parseLine: function (line) {
        if (!line) return;
        // Formato: "val1;val2;...;valN;" (con posible ; final)
        let parts = line.split(';').filter(s => s !== '');
        for (let i = 0; i < NUM_BARS && i < parts.length; i++) {
            let v = parseInt(parts[i]);
            if (!isNaN(v)) this._values[i] = Math.max(0, Math.min(100, v));
        }
    },

    _renderBars: function () {
        for (let i = 0; i < NUM_BARS; i++) {
            let h = Math.max(2, Math.round(DISPLAY_HEIGHT * this._values[i] / 100));
            let y = DISPLAY_HEIGHT - h;
            let bar = this._bars[i];
            bar.widget.set_position(i * (BAR_WIDTH + BAR_GAP), y);
            bar.widget.set_style(
                'background-color: ' + bar.color + ';'
                + 'border-radius: 2px 2px 0 0;'
                + 'width: ' + BAR_WIDTH + 'px;'
                + 'height: ' + h + 'px;'
            );
        }
    },

    on_desklet_removed: function () {
        if (this._fallbackTimer) {
            GLib.source_remove(this._fallbackTimer);
            this._fallbackTimer = null;
        }
        if (this._proc) {
            try { this._proc.force_exit(); } catch (e) {}
            this._proc = null;
        }
        // Limpiar config temporal
        try {
            Gio.File.new_for_path(CONFIG_PATH).delete(null);
        } catch (e) {}
    },
};

function main(metadata, desklet_id) {
    return new CavaDesklet(metadata, desklet_id);
}
