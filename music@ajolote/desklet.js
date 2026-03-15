// music@ajolote — Player MPRIS para Cinnamon
// Usa playerctl para leer estado e info de cualquier player MPRIS
// Controles: anterior / play·pause / siguiente

const Desklet = imports.ui.desklet;
const St = imports.gi.St;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Clutter = imports.gi.Clutter;

function _str(bytes) {
    if (!bytes) return '';
    try { return new TextDecoder('utf-8').decode(bytes); }
    catch (e) { return String(bytes); }
}

function spawnSync(cmd) {
    try {
        let [ok, stdout] = GLib.spawn_command_line_sync(cmd);
        if (ok) return _str(stdout).trim();
    } catch (e) {}
    return null;
}

function spawnAsync(cmd) {
    try { GLib.spawn_command_line_async(cmd); } catch (e) {}
}

// Trunca string con ellipsis
function truncate(str, max) {
    if (!str) return '';
    return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

function MusicDesklet(metadata, desklet_id) {
    this._init(metadata, desklet_id);
}

MusicDesklet.prototype = {
    __proto__: Desklet.Desklet.prototype,

    _init: function (metadata, desklet_id) {
        Desklet.Desklet.prototype._init.call(this, metadata, desklet_id);

        this._container = new St.BoxLayout({
            vertical: true,
            style_class: 'music-container',
        });

        // Fila superior: carátula + info
        let topRow = new St.BoxLayout({ vertical: false, spacing: 10 });

        // Carátula (placeholder inicial)
        this._cover = new St.Icon({
            icon_name: 'audio-x-generic',
            icon_size: 60,
            style_class: 'music-cover',
        });

        // Info textual
        let infoBox = new St.BoxLayout({ vertical: true, x_expand: true });
        this._titleLabel = new St.Label({
            text: 'Sin reproducción',
            style_class: 'music-title',
        });
        this._artistLabel = new St.Label({
            text: '---',
            style_class: 'music-artist',
        });
        this._statusLabel = new St.Label({
            text: '⏹',
            style_class: 'music-status',
        });
        infoBox.add_child(this._titleLabel);
        infoBox.add_child(this._artistLabel);
        infoBox.add_child(this._statusLabel);

        topRow.add_child(this._cover);
        topRow.add_child(infoBox);

        // Controles
        let controlsRow = new St.BoxLayout({
            style_class: 'music-controls',
            x_align: Clutter.ActorAlign.CENTER,
        });

        this._prevBtn = this._makeBtn('⏮', () => spawnAsync('playerctl previous'));
        this._playBtn = this._makeBtn('▶', () => spawnAsync('playerctl play-pause'), 'music-btn-play');
        this._nextBtn = this._makeBtn('⏭', () => spawnAsync('playerctl next'));

        controlsRow.add_child(this._prevBtn);
        controlsRow.add_child(this._playBtn);
        controlsRow.add_child(this._nextBtn);

        this._container.add_child(topRow);
        this._container.add_child(controlsRow);

        this.setContent(this._container);
        this.setHeader('');

        this._update();
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
            this._update();
            return GLib.SOURCE_CONTINUE;
        });
    },

    _makeBtn: function (label, callback, styleClass) {
        let btn = new St.Button({
            label: label,
            style_class: styleClass || 'music-btn',
            reactive: true,
            can_focus: true,
            track_hover: true,
        });
        btn.connect('clicked', callback);
        return btn;
    },

    _update: function () {
        let status = spawnSync('playerctl status 2>/dev/null');
        let title = spawnSync('playerctl metadata title 2>/dev/null');
        let artist = spawnSync('playerctl metadata artist 2>/dev/null');
        let artUrl = spawnSync('playerctl metadata mpris:artUrl 2>/dev/null');

        if (!status || status === '') {
            this._titleLabel.set_text('Sin reproducción');
            this._artistLabel.set_text('---');
            this._statusLabel.set_text('⏹');
            this._playBtn.set_label('▶');
            return;
        }

        this._titleLabel.set_text(truncate(title || 'Desconocido', 28));
        this._artistLabel.set_text(truncate(artist || '---', 28));

        if (status === 'Playing') {
            this._statusLabel.set_text('▶ reproduciendo');
            this._playBtn.set_label('⏸');
        } else if (status === 'Paused') {
            this._statusLabel.set_text('⏸ pausado');
            this._playBtn.set_label('▶');
        } else {
            this._statusLabel.set_text('⏹ ' + status.toLowerCase());
            this._playBtn.set_label('▶');
        }

        // Carátula: si es archivo local, cargarlo como imagen
        if (artUrl && artUrl.startsWith('file://')) {
            let path = artUrl.replace('file://', '');
            try {
                let texture = new Clutter.Image();
                let file = Gio.File.new_for_path(path);
                let [ok, contents] = file.load_contents(null);
                if (ok) {
                    let pixbuf = imports.gi.GdkPixbuf.Pixbuf.new_from_file_at_size(path, 60, 60);
                    texture.set_bytes(
                        pixbuf.get_pixels(),
                        pixbuf.get_has_alpha()
                            ? imports.gi.Cogl.PixelFormat.RGBA_8888
                            : imports.gi.Cogl.PixelFormat.RGB_888,
                        pixbuf.get_width(),
                        pixbuf.get_height(),
                        pixbuf.get_rowstride()
                    );
                    this._cover.set_content(texture);
                    this._cover.set_icon_name('');
                }
            } catch (e) {
                this._cover.set_icon_name('audio-x-generic');
            }
        } else {
            this._cover.set_icon_name('audio-x-generic');
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
    return new MusicDesklet(metadata, desklet_id);
}
