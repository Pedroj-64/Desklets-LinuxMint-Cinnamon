// weather@ajolote — clima via OpenWeatherMap para Cinnamon.
// Ojo: los emoji con variation selector (U+FE0F) crashean Pango en Cinnamon ≤ 6.2
// con un error críptico sin stack trace. Solo uso codepoints BMP simples para los íconos.

const Desklet   = imports.ui.desklet;
const St        = imports.gi.St;
const GLib      = imports.gi.GLib;
const Gio       = imports.gi.Gio;
const Meta      = imports.gi.Meta;
const Settings  = imports.ui.settings;

let GdkPixbuf = null;
try { GdkPixbuf = imports.gi.GdkPixbuf; } catch (e) {}

const UPDATE_INTERVAL_MS = 600000; // 10 minutos

// ── Helpers ───────────────────────────────────────────────────────────────────

function _str(bytes) {
    if (!bytes) return '';
    try { return new TextDecoder('utf-8').decode(bytes); }
    catch (e) { return String(bytes); }
}

// necesitamos saber si hay algo en fullscreen para saltarnos el fetch de clima.
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

// metadata.path no siempre existe en todas las versiones de Cinnamon,
// así que si no está lo construimos a mano desde el home del usuario
function _deskletDir(metadata) {
    if (metadata.path) return metadata.path;
    let p = GLib.get_home_dir()
          + '/.local/share/cinnamon/desklets/' + metadata.uuid;
    if (Gio.File.new_for_path(p).query_exists(null)) return p;
    return null;
}

function loadConfig(metadata) {
    let dir = _deskletDir(metadata);
    if (!dir) return null;
    try {
        let file = Gio.File.new_for_path(dir + '/config.json');
        let [ok, contents] = file.load_contents(null);
        if (ok) return JSON.parse(_str(contents));
    } catch (e) {}
    return null;
}

// solo codepoints BMP de un codepoint — los variation selectors (U+FE0F) crashean
// Pango en Cinnamon ≤ 6.2, así que ni los ponemos. Para niebla/mist usamos ASCII '~'
// directamente, que es menos bonito pero 100% seguro.
const WEATHER_ICONS = {
    '01': '☀',   // sun          U+2600
    '02': '⛅',  // partly       U+26C5
    '03': '☁',   // cloudy       U+2601
    '04': '☁',   // broken       U+2601
    '09': '☂',   // drizzle      U+2602
    '10': '☔',  // rain          U+2614
    '11': '⛈',  // thunderstorm  U+26C8
    '13': '❄',   // snow         U+2744
    '50': '~',   // mist         ASCII
};

function _icon(code) {
    if (!code || code.length < 2) return '?';
    return WEATHER_ICONS[code.slice(0, 2)] || '?';
}

// ── Desklet ───────────────────────────────────────────────────────────────────

function WeatherDesklet(metadata, desklet_id) {
    this._init(metadata, desklet_id);
}

WeatherDesklet.prototype = {
    __proto__: Desklet.Desklet.prototype,

    _init: function (metadata, desklet_id) {
        Desklet.Desklet.prototype._init.call(this, metadata, desklet_id);
        this._cfg = loadConfig(metadata);

        // ── Settings ──────────────────────────────────────────────────────────
        this._widgetMinWidth  = 200;
        this._widgetMinHeight = 100;
        this._cityName        = 'Bogota';
        this._units           = 'metric';
        this._bgOpacity       = 55;
        this._autoOpacity     = false;
        this._wallpaperAlpha  = 55;
        this._pauseOnFullscreen = true;
        try {
            this._settings = new Settings.DeskletSettings(this, metadata.uuid, desklet_id);
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'widget_min_width',    '_widgetMinWidth',    this._onWidthChanged, null);
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'widget_min_height',   '_widgetMinHeight',   this._onWidthChanged, null);
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'bg_opacity',          '_bgOpacity',         this._onWidthChanged, null);
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'auto_opacity',        '_autoOpacity',       this._onAutoOpacityChanged, null);
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'city_name',           '_cityName',          this._onDataChanged,  null);
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'units',               '_units',             this._onDataChanged,  null);
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'pause_on_fullscreen', '_pauseOnFullscreen', null,                 null);
        } catch (e) {}

        // ── Widgets ───────────────────────────────────────────────────────────
        this._container = new St.BoxLayout({
            vertical: true,
            style_class: 'weather-container',
        });
        this._applyContainerStyle();

        // nombre de ciudad — mostramos un placeholder hasta que llegue la respuesta de la API
        this._cityLabel = new St.Label({
            text: 'Bogota, CO',
            style_class: 'weather-city',
        });

        // ícono del clima (emoji BMP) y temperatura lado a lado.
        // intenté alinearlos con y_align en el constructor pero en Cinnamon eso no funciona
        // bien para St.Label — el ajuste de alineación va mejor en el stylesheet.
        let topRow = new St.BoxLayout({ vertical: false });
        this._iconLabel = new St.Label({ text: '?', style_class: 'weather-icon' });
        this._tempLabel = new St.Label({ text: '--°C', style_class: 'weather-temp' });
        this._tempLabel.set_style('padding-left: 8px;');
        topRow.add_child(this._iconLabel);
        topRow.add_child(this._tempLabel);

        // descripción corta: viene de la API en el idioma configurado (default: español)
        this._descLabel = new St.Label({
            text: 'Cargando...',
            style_class: 'weather-desc',
        });

        // humedad y viento en texto plano — sin emoji aquí tampoco, por las mismas razones
        this._detailsLabel = new St.Label({
            text: '',
            style_class: 'weather-details',
        });

        this._container.add_child(this._cityLabel);
        this._container.add_child(topRow);
        this._container.add_child(this._descLabel);
        this._container.add_child(this._detailsLabel);

        this.setContent(this._container);
        this.setHeader('');

        this._wallpaperAlpha = this._bgOpacity;
        this._initWallpaperReactivity();
        this._applyContainerStyle();

        this._fetchWeather();
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, UPDATE_INTERVAL_MS, () => {
            this._fetchWeather();
            return GLib.SOURCE_CONTINUE;
        });
        this._destroyed = false;
    },

    _applyContainerStyle: function () {
        let opacityVal = this._autoOpacity ? this._wallpaperAlpha : this._bgOpacity;
        let alpha = Math.min(Math.max(opacityVal, 0), 100) / 100;
        this._container.set_style(
            'background-color: rgba(26, 27, 38, ' + alpha + ');' +
            'min-width: '    + this._widgetMinWidth  + 'px;'     +
            'min-height: '   + this._widgetMinHeight + 'px;'     +
            'border-radius: 14px;'                               +
            'border: 1px solid rgba(65, 72, 104, 0.5);');
    },

    _onWidthChanged: function () {
        this._applyContainerStyle();
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

    _onDataChanged: function () {
        this._applyContainerStyle();
        this._fetchWeather();
    },

    _fetchWeather: function () {
        if (this._pauseOnFullscreen && _isAnyWindowFullscreen()) return;
        if (!this._cfg || !this._cfg.api_key
                || this._cfg.api_key === 'TU_API_KEY_AQUI') {
            this._descLabel.set_text('Configura tu API key en config.json');
            return;
        }

        // city_name del setting tiene prioridad sobre el city_id del config.json.
        // si el usuario puso una ciudad en los ajustes, usamos &q=; si no, &id= con el valor del config.
        let city  = (this._cityName || '').trim();
        let units = (this._units || this._cfg.units || 'metric');
        let loc   = city
            ? ('&q='  + encodeURIComponent(city))
            : ('&id=' + encodeURIComponent(this._cfg.city_id || '3688689'));

        let url = 'https://api.openweathermap.org/data/2.5/weather'
            + '?appid=' + encodeURIComponent(this._cfg.api_key)
            + loc
            + '&units=' + encodeURIComponent(units)
            + '&lang='  + encodeURIComponent(this._cfg.lang || 'es');

        try {
            let proc = new Gio.Subprocess({
                argv:  ['curl', '-s', '--max-time', '10', url],
                flags: Gio.SubprocessFlags.STDOUT_PIPE
                     | Gio.SubprocessFlags.STDERR_SILENCE,
            });
            proc.init(null);
            proc.communicate_utf8_async(null, null, (p, res) => {
                if (this._destroyed) return;
                try {
                    let [, out] = p.communicate_utf8_finish(res);
                    if (out && out.trim()) this._parseWeather(out.trim());
                } catch (e) {
                    this._descLabel.set_text('Error de red');
                }
            });
        } catch (e) {
            this._descLabel.set_text('Error: instala curl');
        }
    },

    _parseWeather: function (json) {
        try {
            let d = JSON.parse(json);
            if (d.cod && d.cod !== 200) {
                this._descLabel.set_text('API: ' + (d.message || 'Error'));
                return;
            }
            let units  = (this._units || 'metric');
            let unit   = units === 'imperial' ? '°F' : '°C';
            let temp   = Math.round(d.main.temp);
            let feels  = Math.round(d.main.feels_like);
            let desc   = d.weather[0].description;
            desc = desc.charAt(0).toUpperCase() + desc.slice(1);
            let icon   = _icon(d.weather[0].icon);
            let humid  = d.main.humidity;
            let wind   = Math.round((d.wind ? d.wind.speed : 0) * 3.6);

            this._iconLabel.set_text(icon);
            this._tempLabel.set_text(temp + unit);
            this._descLabel.set_text(desc + '  (sens. ' + feels + unit + ')');
            this._detailsLabel.set_text(
                'Hum: ' + humid + '%   Viento: ' + wind + ' km/h');
            this._cityLabel.set_text(
                (d.name || '') + (d.sys ? ', ' + d.sys.country : ''));
        } catch (e) {
            this._descLabel.set_text('Error al parsear datos');
        }
    },

    on_desklet_removed: function () {
        this._destroyed = true;
        if (this._bgSettings && this._bgSignalId) {
            try { this._bgSettings.disconnect(this._bgSignalId); } catch (e) {}
            this._bgSignalId = null;
        }
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
        if (this._settings) { try { this._settings.finalize(); } catch (e) {} }
    },
};

function main(metadata, desklet_id) {
    return new WeatherDesklet(metadata, desklet_id);
}
