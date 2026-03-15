// clock@ajolote — reloj minimal tokyonight para Cinnamon.
// formato 12/24h y segundos opcionales, configurables desde los ajustes del desklet

const Desklet   = imports.ui.desklet;
const St        = imports.gi.St;
const GLib      = imports.gi.GLib;
const Clutter   = imports.gi.Clutter;
const Meta      = imports.gi.Meta;
const Settings  = imports.ui.settings;
let GdkPixbuf = null;
try { GdkPixbuf = imports.gi.GdkPixbuf; } catch (e) {}

const DIAS  = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

// necesitamos saber si hay algo en fullscreen para saltarnos el tick del reloj.
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

function ClockDesklet(metadata, desklet_id) {
    this._init(metadata, desklet_id);
}

ClockDesklet.prototype = {
    __proto__: Desklet.Desklet.prototype,

    _init: function (metadata, desklet_id) {
        Desklet.Desklet.prototype._init.call(this, metadata, desklet_id);

        // ── Settings ──────────────────────────────────────────────────────────
        this._use12h          = false;
        this._showSeconds     = false;
        this._widgetWidth     = 200;
        this._widgetMinHeight = 80;
        this._bgOpacity       = 55;
        this._autoOpacity     = false;
        this._wallpaperAlpha  = 55;
        this._pauseOnFullscreen = true;
        try {
            this._settings = new Settings.DeskletSettings(this, metadata.uuid, desklet_id);
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'use_12h',             '_use12h',             this._update,               null);
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'show_seconds',        '_showSeconds',        this._update,               null);
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'widget_width',        '_widgetWidth',        this._onSettingsChanged,    null);
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'widget_min_height',   '_widgetMinHeight',    this._onSettingsChanged,    null);
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'bg_opacity',          '_bgOpacity',          this._onSettingsChanged,    null);
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'auto_opacity',        '_autoOpacity',        this._onAutoOpacityChanged, null);
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'pause_on_fullscreen', '_pauseOnFullscreen',  null,                       null);
        } catch (e) {}

        this._wallpaperAlpha = this._bgOpacity;

        this._container = new St.BoxLayout({
            vertical: true,
            style_class: 'clock-container',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._applyContainerStyle();

        this._timeLabel = new St.Label({
            text: '--:--',
            style_class: 'clock-time',
            x_align: Clutter.ActorAlign.CENTER,
        });

        this._dateLabel = new St.Label({
            text: '--- -- ---',
            style_class: 'clock-date',
            x_align: Clutter.ActorAlign.CENTER,
        });

        this._container.add_child(this._timeLabel);
        this._container.add_child(this._dateLabel);

        this.setContent(this._container);
        this.setHeader('');

        this._initWallpaperReactivity();
        this._applyContainerStyle();
        this._update();
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            this._update();
            return GLib.SOURCE_CONTINUE;
        });
    },

    // ── Opacidad reactiva al wallpaper ────────────────────────────────────────
    // GSettings de Cinnamon dispara una señal cada vez que cambia el wallpaper.
    // nos enganchamos ahí para recalcular la opacidad óptima del widget automáticamente.
    // ojo: si no desconectamos la señal en on_desklet_removed puede dispararse después de
    // que el objeto esté destruido y crashear Cinnamon con un error muy críptico.

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

    _applyContainerStyle: function () {
        let opacityVal = this._autoOpacity ? this._wallpaperAlpha : this._bgOpacity;
        let alpha = Math.min(Math.max(opacityVal, 0), 100) / 100;
        this._container.set_style(
            'background-color: rgba(26, 27, 38, ' + alpha + ');' +
            'min-width: '    + this._widgetWidth     + 'px;'     +
            'min-height: '   + this._widgetMinHeight + 'px;'     +
            'border-radius: 14px;'                               +
            'border: 1px solid rgba(65, 72, 104, 0.5);');
    },

    _update: function () {
        if (this._pauseOnFullscreen && _isAnyWindowFullscreen()) return;
        let now = new Date();
        let m   = String(now.getMinutes()).padStart(2, '0');
        let s   = String(now.getSeconds()).padStart(2, '0');
        let timeStr;

        if (this._use12h) {
            let h    = now.getHours() % 12 || 12;
            let ampm = now.getHours() < 12 ? 'AM' : 'PM';
            timeStr  = h + ':' + m;
            if (this._showSeconds) timeStr += ':' + s;
            timeStr += ' ' + ampm;
        } else {
            let h   = String(now.getHours()).padStart(2, '0');
            timeStr = h + ':' + m;
            if (this._showSeconds) timeStr += ':' + s;
        }

        this._timeLabel.set_text(timeStr);

        let dia   = DIAS[now.getDay()];
        let fecha = now.getDate();
        let mes   = MESES[now.getMonth()];
        this._dateLabel.set_text(dia + ' ' + fecha + ' ' + mes);
    },

    _onSettingsChanged: function () {
        this._applyContainerStyle();
    },

    _onAutoOpacityChanged: function () {
        if (this._autoOpacity) this._sampleWallpaper();
        this._applyContainerStyle();
    },

    on_desklet_removed: function () {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
        if (this._bgSettings && this._bgSignalId) {
            try { this._bgSettings.disconnect(this._bgSignalId); } catch (e) {}
            this._bgSignalId = null;
        }
        if (this._settings) { try { this._settings.finalize(); } catch (e) {} }
    },
};

function main(metadata, desklet_id) {
    return new ClockDesklet(metadata, desklet_id);
}
