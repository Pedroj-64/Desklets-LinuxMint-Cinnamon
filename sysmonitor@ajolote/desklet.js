// sysmonitor@ajolote — Monitor de CPU/RAM/GPU para Cinnamon
// Lee /proc/stat, /proc/meminfo, nvidia-smi
// Se actualiza cada 2 segundos, barras con caracteres Unicode

const Desklet = imports.ui.desklet;
const St = imports.gi.St;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Clutter = imports.gi.Clutter;

// Convierte Uint8Array/ByteArray a string
function _str(bytes) {
    if (!bytes) return '';
    try {
        return new TextDecoder('utf-8').decode(bytes);
    } catch (e) {
        return String(bytes);
    }
}

function readFile(path) {
    try {
        let file = Gio.File.new_for_path(path);
        let [ok, contents] = file.load_contents(null);
        if (ok) return _str(contents);
    } catch (e) {}
    return null;
}

function spawnSync(cmd) {
    try {
        let [ok, stdout] = GLib.spawn_command_line_sync(cmd);
        if (ok) return _str(stdout).trim();
    } catch (e) {}
    return null;
}

// Barra ASCII: 20 bloques totales
function makeBar(pct, width) {
    width = width || 18;
    let filled = Math.round(width * Math.max(0, Math.min(100, pct)) / 100);
    let empty = width - filled;
    return '▓'.repeat(filled) + '░'.repeat(empty);
}

function SysMonitorDesklet(metadata, desklet_id) {
    this._init(metadata, desklet_id);
}

SysMonitorDesklet.prototype = {
    __proto__: Desklet.Desklet.prototype,

    _prevCpu: null,

    _init: function (metadata, desklet_id) {
        Desklet.Desklet.prototype._init.call(this, metadata, desklet_id);
        this._prevCpu = null;

        this._container = new St.BoxLayout({
            vertical: true,
            style_class: 'sysmon-container',
        });

        // CPU
        this._cpuRow = this._makeRow('CPU', '0%');
        this._cpuBarLabel = this._makeBarLabel();

        // RAM
        this._ramRow = this._makeRow('RAM', '0.0 / 0.0 GB');
        this._ramBarLabel = this._makeBarLabel();

        // GPU
        this._gpuRow = this._makeRow('GPU', 'N/A');
        this._gpuBarLabel = this._makeBarLabel();

        this._container.add_child(this._cpuRow.box);
        this._container.add_child(this._cpuBarLabel);
        this._container.add_child(this._ramRow.box);
        this._container.add_child(this._ramBarLabel);
        this._container.add_child(this._gpuRow.box);
        this._container.add_child(this._gpuBarLabel);

        this.setContent(this._container);
        this.setHeader('');

        this._update();
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
            this._update();
            return GLib.SOURCE_CONTINUE;
        });
    },

    _makeRow: function (label, value) {
        let box = new St.BoxLayout({ style_class: 'sysmon-row' });
        let lbl = new St.Label({ text: label, style_class: 'sysmon-label' });
        let spacer = new St.Widget({ x_expand: true });
        let val = new St.Label({ text: value, style_class: 'sysmon-value' });
        box.add_child(lbl);
        box.add_child(spacer);
        box.add_child(val);
        return { box, val };
    },

    _makeBarLabel: function () {
        return new St.Label({
            text: makeBar(0),
            style_class: 'sysmon-bar-bg',
        });
    },

    _getCpuUsage: function () {
        let contents = readFile('/proc/stat');
        if (!contents) return 0;
        let line = contents.split('\n')[0];
        let parts = line.trim().split(/\s+/);
        let user = parseInt(parts[1]) || 0;
        let nice = parseInt(parts[2]) || 0;
        let system = parseInt(parts[3]) || 0;
        let idle = parseInt(parts[4]) || 0;
        let iowait = parseInt(parts[5]) || 0;
        let irq = parseInt(parts[6]) || 0;
        let softirq = parseInt(parts[7]) || 0;
        let steal = parseInt(parts[8]) || 0;

        let totalIdle = idle + iowait;
        let totalNonIdle = user + nice + system + irq + softirq + steal;
        let total = totalIdle + totalNonIdle;

        let pct = 0;
        if (this._prevCpu) {
            let dTotal = total - this._prevCpu.total;
            let dIdle = totalIdle - this._prevCpu.idle;
            if (dTotal > 0) pct = ((dTotal - dIdle) / dTotal) * 100;
        }
        this._prevCpu = { total: total, idle: totalIdle };
        return Math.round(Math.max(0, Math.min(100, pct)));
    },

    _getRamUsage: function () {
        let contents = readFile('/proc/meminfo');
        if (!contents) return { pct: 0, text: 'N/A' };
        let total = 0, available = 0;
        for (let line of contents.split('\n')) {
            if (line.startsWith('MemTotal:')) total = parseInt(line.split(/\s+/)[1]);
            if (line.startsWith('MemAvailable:')) available = parseInt(line.split(/\s+/)[1]);
        }
        if (total === 0) return { pct: 0, text: 'N/A' };
        let used = total - available;
        let pct = Math.round((used / total) * 100);
        let usedGB = (used / 1024 / 1024).toFixed(1);
        let totalGB = (total / 1024 / 1024).toFixed(1);
        return { pct: pct, text: usedGB + ' / ' + totalGB + ' GB' };
    },

    _getGpuUsage: function () {
        // NVIDIA
        let nvidia = spawnSync('nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits 2>/dev/null');
        if (nvidia !== null && nvidia !== '' && !isNaN(parseInt(nvidia))) {
            let pct = parseInt(nvidia);
            let mem = spawnSync('nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null');
            let memText = '';
            if (mem) {
                let parts = mem.split(',').map(s => s.trim());
                if (parts.length === 2) {
                    let usedMB = parseInt(parts[0]);
                    let totalMB = parseInt(parts[1]);
                    memText = ' ' + (usedMB / 1024).toFixed(1) + '/' + (totalMB / 1024).toFixed(1) + 'G';
                }
            }
            return { pct: pct, text: pct + '%' + memText };
        }
        // AMD via sysfs
        let amdLoad = readFile('/sys/class/drm/card0/device/gpu_busy_percent');
        if (amdLoad) {
            let pct = parseInt(amdLoad.trim());
            if (!isNaN(pct)) return { pct: pct, text: pct + '% AMD' };
        }
        return { pct: 0, text: 'N/A' };
    },

    _update: function () {
        let cpu = this._getCpuUsage();
        this._cpuRow.val.set_text(cpu + '%');
        this._cpuBarLabel.set_text(makeBar(cpu));

        let ram = this._getRamUsage();
        this._ramRow.val.set_text(ram.text);
        this._ramBarLabel.set_text(makeBar(ram.pct));

        let gpu = this._getGpuUsage();
        this._gpuRow.val.set_text(gpu.text);
        this._gpuBarLabel.set_text(makeBar(gpu.pct));
    },

    on_desklet_removed: function () {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
    },
};

function main(metadata, desklet_id) {
    return new SysMonitorDesklet(metadata, desklet_id);
}
