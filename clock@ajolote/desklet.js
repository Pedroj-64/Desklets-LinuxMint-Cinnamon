// clock@ajolote — Reloj minimal tokyonight para Cinnamon
// Formato: HH:MM grande + "DiaSemana DD Mes" debajo

const Desklet = imports.ui.desklet;
const St = imports.gi.St;
const GLib = imports.gi.GLib;
const Clutter = imports.gi.Clutter;

const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

function ClockDesklet(metadata, desklet_id) {
    this._init(metadata, desklet_id);
}

ClockDesklet.prototype = {
    __proto__: Desklet.Desklet.prototype,

    _init: function (metadata, desklet_id) {
        Desklet.Desklet.prototype._init.call(this, metadata, desklet_id);

        this._container = new St.BoxLayout({
            vertical: true,
            style_class: 'clock-container',
            x_align: Clutter.ActorAlign.CENTER,
        });

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

        this._update();
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            this._update();
            return GLib.SOURCE_CONTINUE;
        });
    },

    _update: function () {
        let now = new Date();
        let h = String(now.getHours()).padStart(2, '0');
        let m = String(now.getMinutes()).padStart(2, '0');
        this._timeLabel.set_text(h + ':' + m);

        let dia = DIAS[now.getDay()];
        let fecha = now.getDate();
        let mes = MESES[now.getMonth()];
        this._dateLabel.set_text(dia + ' ' + fecha + ' ' + mes);
    },

    on_desklet_removed: function () {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
    },
};

function main(metadata, desklet_id) {
    return new ClockDesklet(metadata, desklet_id);
}
