// weather@ajolote — Clima de Bogotá para Cinnamon
// API: OpenWeatherMap (gratuita) — edita API_KEY antes de activar
// Se actualiza cada 10 minutos usando curl via Gio.Subprocess

const Desklet = imports.ui.desklet;
const St = imports.gi.St;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Clutter = imports.gi.Clutter;
const Lang = imports.lang;

// ─── CONFIGURACIÓN ────────────────────────────────────────────────────────────
const API_KEY = 'TU_API_KEY_AQUI';   // ← pega tu key de openweathermap.org
const CITY_ID = '3688689';            // Bogotá
const UNITS = 'metric';               // Celsius
const LANG_OWM = 'es';
const UPDATE_INTERVAL_MS = 600000;    // 10 minutos
// ──────────────────────────────────────────────────────────────────────────────

function _str(bytes) {
    if (!bytes) return '';
    try { return new TextDecoder('utf-8').decode(bytes); }
    catch (e) { return String(bytes); }
}

// Íconos Unicode para códigos OWM
const WEATHER_ICONS = {
    '01': '☀️',  // cielo despejado día
    '02': '⛅',  // pocas nubes
    '03': '☁️',  // nubes dispersas
    '04': '☁️',  // nublado
    '09': '🌧️', // llovizna
    '10': '🌦️', // lluvia
    '11': '⛈️', // tormenta
    '13': '❄️', // nieve
    '50': '🌫️', // neblina
};

function getWeatherIcon(iconCode) {
    if (!iconCode || iconCode.length < 2) return '🌡️';
    let key = iconCode.slice(0, 2);
    return WEATHER_ICONS[key] || '🌡️';
}

function WeatherDesklet(metadata, desklet_id) {
    this._init(metadata, desklet_id);
}

WeatherDesklet.prototype = {
    __proto__: Desklet.Desklet.prototype,

    _init: function (metadata, desklet_id) {
        Desklet.Desklet.prototype._init.call(this, metadata, desklet_id);

        this._container = new St.BoxLayout({
            vertical: true,
            style_class: 'weather-container',
        });

        // Fila superior: ícono + temperatura
        let topRow = new St.BoxLayout({ vertical: false, spacing: 8 });

        this._iconLabel = new St.Label({
            text: '🌡️',
            style_class: 'weather-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._tempLabel = new St.Label({
            text: '--°C',
            style_class: 'weather-temp',
            y_align: Clutter.ActorAlign.CENTER,
        });

        topRow.add_child(this._iconLabel);
        topRow.add_child(this._tempLabel);

        // Descripción
        this._descLabel = new St.Label({
            text: 'Cargando...',
            style_class: 'weather-desc',
        });

        // Ciudad
        this._cityLabel = new St.Label({
            text: 'Bogotá, CO',
            style_class: 'weather-city',
        });

        // Detalles: humedad + viento
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

        // Primera actualización inmediata
        this._fetchWeather();
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, UPDATE_INTERVAL_MS, () => {
            this._fetchWeather();
            return GLib.SOURCE_CONTINUE;
        });
    },

    _fetchWeather: function () {
        if (API_KEY === 'TU_API_KEY_AQUI') {
            this._descLabel.set_text('Configura API_KEY en desklet.js');
            return;
        }

        let url = 'https://api.openweathermap.org/data/2.5/weather'
            + '?id=' + CITY_ID
            + '&appid=' + API_KEY
            + '&units=' + UNITS
            + '&lang=' + LANG_OWM;

        try {
            let proc = new Gio.Subprocess({
                argv: ['curl', '-s', '--max-time', '10', url],
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
            });
            proc.init(null);

            proc.communicate_utf8_async(null, null, (proc, res) => {
                try {
                    let [, stdout] = proc.communicate_utf8_finish(res);
                    if (stdout) this._parseWeather(stdout.trim());
                } catch (e) {
                    this._descLabel.set_text('Error de red');
                }
            });
        } catch (e) {
            this._descLabel.set_text('Error: curl no disponible');
        }
    },

    _parseWeather: function (json) {
        try {
            let data = JSON.parse(json);

            let temp = Math.round(data.main.temp);
            let feels = Math.round(data.main.feels_like);
            let desc = data.weather[0].description;
            // Capitalizar primera letra
            desc = desc.charAt(0).toUpperCase() + desc.slice(1);
            let iconCode = data.weather[0].icon;
            let humidity = data.main.humidity;
            let windMs = data.wind ? data.wind.speed : 0;
            let windKmh = Math.round(windMs * 3.6);

            this._tempLabel.set_text(temp + '°C');
            this._descLabel.set_text(desc + '  (sens. ' + feels + '°C)');
            this._iconLabel.set_text(getWeatherIcon(iconCode));
            this._detailsLabel.set_text('💧 ' + humidity + '%   💨 ' + windKmh + ' km/h');
            this._cityLabel.set_text(data.name + ', ' + data.sys.country);
        } catch (e) {
            this._descLabel.set_text('Error al parsear datos');
        }
    },

    on_desklet_removed: function () {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
    },
};

function main(metadata, desklet_id) {
    return new WeatherDesklet(metadata, desklet_id);
}
