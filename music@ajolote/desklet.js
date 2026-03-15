// music@ajolote — widget de música para Cinnamon con controles MPRIS.
// la primera versión spawneaba playerctl 4 veces por tick (status, título, artista, portada)
// y se notaba en el CPU. ahora todo cae en un solo sh con printf, mucho más limpio.

const Desklet   = imports.ui.desklet;
const St        = imports.gi.St;
const GLib      = imports.gi.GLib;
const Gio       = imports.gi.Gio;
const Clutter   = imports.gi.Clutter;
const Meta      = imports.gi.Meta;
const Settings  = imports.ui.settings;
const ByteArray = imports.byteArray;
// GdkPixbuf solo para leer píxeles del wallpaper — nada más.
// intenté usarlo para renderizar la portada en St.Icon y Cinnamon crasheó de inmediato.
// la única forma segura de mostrar imágenes en desklets es Gio.FileIcon + St.Icon.
let GdkPixbuf = null;
try { GdkPixbuf = imports.gi.GdkPixbuf; } catch (e) {}

// Cinnamon recarga los desklets bastante seguido (especialmente cuando estás editando),
// y el widget arrancaba en blanco aunque la música siguiera sonando. incómodo.
// solución: guardamos el último estado conocido en disco y lo restauramos al instante.
const CACHE_FILE = GLib.get_user_cache_dir() + '/music@ajolote-state.json';

// ── Helpers ───────────────────────────────────────────────────────────────────

function spawnAsync(cmd) {
    try { GLib.spawn_command_line_async(cmd); } catch (e) {}
}

function truncate(str, max) {
    if (!str) return '';
    return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

// necesitamos esto para pausar el polling cuando hay algo en fullscreen.
// la API de Cinnamon cambió entre versiones: en las recientes se puede preguntar
// al workspace directamente; en las viejas hay que iterar global.display.
// de ahí los dos try/catch anidados en lugar de un if/else simple.
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

function MusicDesklet(metadata, desklet_id) {
    this._init(metadata, desklet_id);
}

MusicDesklet.prototype = {
    __proto__: Desklet.Desklet.prototype,

    _init: function (metadata, desklet_id) {
        Desklet.Desklet.prototype._init.call(this, metadata, desklet_id);

        // ── Settings ──────────────────────────────────────────────────────────
        this._coverSize         = 60;
        this._maxChars          = 26;
        this._widgetWidth       = 300;
        this._widgetMinHeight   = 140;
        this._bgOpacity         = 55;
        this._titleFontSize     = 13;
        this._pauseOnFullscreen = true;
        this._autoOpacity       = false;
        this._wallpaperAlpha    = 55;   // calculado por _sampleWallpaper()
        try {
            this._settings = new Settings.DeskletSettings(this, metadata.uuid, desklet_id);
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'cover_size',          '_coverSize',          this._onSettingsChanged, null);
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'max_chars',           '_maxChars',           this._onSettingsChanged, null);
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'widget_width',        '_widgetWidth',        this._onSettingsChanged, null);
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'widget_min_height',   '_widgetMinHeight',    this._onSettingsChanged, null);
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'bg_opacity',          '_bgOpacity',          this._onSettingsChanged, null);
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'title_font_size',     '_titleFontSize',      this._onSettingsChanged, null);
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'auto_opacity',        '_autoOpacity',        this._onSettingsChanged, null);
            this._settings.bindProperty(Settings.BindingDirection.IN,
                'pause_on_fullscreen', '_pauseOnFullscreen',  null,                    null);
        } catch (e) {}

        // fallback seguro: si auto_opacity está activo pero _sampleWallpaper todavía
        // no corrió, mostramos la opacidad manual en lugar de un 0 inesperado
        this._wallpaperAlpha = this._bgOpacity;

        this._lastArtUrl  = null;
        this._fetching    = false;
        this._destroyed   = false;
        this._buildWidget();
        this._initWallpaperReactivity();    // conectar señal de cambio de wallpaper
        this._restoreFromCache();           // muestra el último estado antes del primer tick
        this._startTimer();
    },

    // ── Caché de estado ───────────────────────────────────────────────────────

    // GLib.file_set_contents es atómico: escribe a un temp y lo renombra.
    // así si Cinnamon se muere a mitad de escritura, el archivo anterior queda intacto.
    _saveCache: function (state) {
        try {
            GLib.file_set_contents(CACHE_FILE, JSON.stringify(state));
        } catch (e) {}
    },

    _loadCache: function () {
        try {
            let [ok, raw] = GLib.file_get_contents(CACHE_FILE);
            if (!ok) return null;
            // GJS moderno devuelve Uint8Array; versiones viejas devuelven string directo
            let str = (raw instanceof Uint8Array)
                ? ByteArray.toString(raw)
                : raw.toString();
            return JSON.parse(str);
        } catch (e) { return null; }
    },

    // el desklet tarda hasta 2 segundos en el primer tick del timer.
    // sin este restore, el widget aparece vacío aunque la música esté sonando.
    // mejor mostrar lo último conocido aunque esté un par de segundos desactualizado.
    _restoreFromCache: function () {
        let state = this._loadCache();
        if (!state || !state.title) return;

        this._titleLabel.set_text(truncate(state.title  || 'Desconocido', this._maxChars));
        this._artistLabel.set_text(truncate(state.artist || '---',         this._maxChars));

        let s = (state.status || '').trim();
        if (s === 'Playing') {
            this._statusLabel.set_text('[>] reproduciendo');
            this._playIcon.set_icon_name('media-playback-pause-symbolic');
        } else if (s === 'Paused') {
            this._statusLabel.set_text('[|] pausado');
            this._playIcon.set_icon_name('media-playback-start-symbolic');
        } else if (s) {
            this._statusLabel.set_text('[ ] ' + s.toLowerCase());
        }

        if (state.artUrl) {
            // forzamos recarga aunque coincida con _lastArtUrl (que es null al init)
            this._lastArtUrl = null;
            this._updateCover(state.artUrl);
        }
    },

    // ── Opacidad reactiva al wallpaper ────────────────────────────────────────

    // GSettings de Cinnamon dispara una señal cada vez que cambia el wallpaper.
    // nos enganchamos ahí para recalcular la opacidad óptima del widget automáticamente.
    // si el schema no existe (instalación atípica de Cinnamon) simplemente no hacemos nada.
    _initWallpaperReactivity: function () {
        try {
            this._bgSettings = new Gio.Settings({ schema: 'org.cinnamon.desktop.background' });
            this._bgSignalId = this._bgSettings.connect('changed::picture-uri', () => {
                if (this._autoOpacity) {
                    this._sampleWallpaper();
                    this._applyContainerStyle();
                }
            });
            // sample inicial
            if (this._autoOpacity) this._sampleWallpaper();
        } catch (e) {
            this._bgSettings = null;
            this._bgSignalId = null;
        }
    },

    // escalamos el wallpaper a 64×64 porque no necesitamos precisión, solo el brillo general.
    // es muchísimo más rápido que procesar la imagen completa y el resultado es igual de útil.
    // la fórmula de luma Rec.601 pesa más el verde porque el ojo lo percibe más brillante.
    // con ese brillo mapeamos la opacidad: wallpaper oscuro → widget casi transparente,
    // wallpaper claro → widget más sólido para que el texto siga legible.
    _sampleWallpaper: function () {
        if (!GdkPixbuf || !this._bgSettings) return;
        try {
            let uri = this._bgSettings.get_string('picture-uri');
            if (!uri) return;
            let path;
            try {
                path = GLib.filename_from_uri(uri)[0];
            } catch (e) {
                // raro, pero algunos temas ponen rutas en lugar de URIs
                path = uri.replace(/^file:\/\//, '');
            }
            if (!path || !GLib.file_test(path, GLib.FileTest.EXISTS)) return;

            // escalar a 64×64 para hacer el sampleo rápido
            let pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 64, 64, false);
            let pixels  = pixbuf.get_pixels();
            let n_chan   = pixbuf.get_n_channels();   // 3 = RGB, 4 = RGBA
            let width    = pixbuf.get_width();
            let height   = pixbuf.get_height();
            let total    = 0;
            let count    = 0;
            for (let i = 0; i < width * height; i++) {
                let base = i * n_chan;
                let r = pixels[base    ];
                let g = pixels[base + 1];
                let b = pixels[base + 2];
                // luma perceptual Rec.601
                total += 0.299 * r + 0.587 * g + 0.114 * b;
                count++;
            }
            if (count === 0) return;
            let brightness = (total / count) / 255;   // 0.0 (negro) → 1.0 (blanco)
            // rango [30, 85]: nunca completamente transparente ni completamente sólido
            this._wallpaperAlpha = Math.round((0.30 + brightness * 0.55) * 100);
        } catch (e) {
            // si algo falla (GdkPixbuf no disponible, imagen rota, etc.) usamos _bgOpacity
        }
    },

    // todo el estilo del contenedor va en inline style porque el CSS del desklet
    // no tiene acceso a los valores de configuración del usuario.
    // se llama al construir el widget y en cada cambio de setting.
    _applyContainerStyle: function () {
        let opacityVal = this._autoOpacity ? this._wallpaperAlpha : this._bgOpacity;
        let alpha = Math.min(Math.max(opacityVal, 0), 100) / 100;
        // el min-height crece junto con la carátula para que no haya espacio vacío
        // debajo de los controles. si el usuario puso un valor mayor en el slider, ese gana.
        let contentHeight = this._coverSize + 70;
        let minH = Math.max(this._widgetMinHeight, contentHeight);
        this._container.set_style(
            'background-color: rgba(26, 27, 38, ' + alpha + ');' +
            'width: '          + this._widgetWidth + 'px;'       +
            'min-width: '      + this._widgetWidth + 'px;'       +
            'min-height: '     + minH              + 'px;'       +
            'border-radius: 14px;'                               +
            'border: 1px solid rgba(65, 72, 104, 0.5);');
    },

    _buildWidget: function () {
        this._container = new St.BoxLayout({
            vertical: true,
            style_class: 'music-container',
        });
        this._applyContainerStyle();

        // ── Fila superior: carátula + info ────────────────────────────────────
        let topRow = new St.BoxLayout({ vertical: false });

        // Gio.FileIcon es la única opción viable para mostrar la portada.
        // GdkPixbuf crashea Cinnamon si lo usas para renderizar en St, y Cogl igual.
        // el icon_size lo reforzamos con min/max en CSS porque en un BoxLayout horizontal
        // a veces solo reserva espacio en un eje y la imagen queda torcida.
        this._cover = new St.Icon({
            icon_name: 'audio-x-generic',
            icon_size:  this._coverSize,
            style_class: 'music-cover',
        });
        this._cover.set_style(
            'min-width: '  + this._coverSize + 'px;' +
            'min-height: ' + this._coverSize + 'px;' +
            'max-width: '  + this._coverSize + 'px;' +
            'max-height: ' + this._coverSize + 'px;');

        let infoBox = new St.BoxLayout({ vertical: true });
        infoBox.set_x_expand(true);
        // sin y_align CENTER los labels flotan arriba y queda un hueco enorme
        // cuando la carátula es grande. así se ven centrados sin importar el tamaño.
        infoBox.set_y_align(Clutter.ActorAlign.CENTER);
        infoBox.set_style('padding-left: 10px;');

        this._titleLabel = new St.Label({
            text: 'Sin reproduccion',
            style_class: 'music-title',
        });
        this._titleLabel.set_style('font-size: ' + this._titleFontSize + 'px;');
        this._artistLabel = new St.Label({
            text: '---',
            style_class: 'music-artist',
        });
        this._statusLabel = new St.Label({
            text: '[ ]',
            style_class: 'music-status',
        });
        infoBox.add_child(this._titleLabel);
        infoBox.add_child(this._artistLabel);
        infoBox.add_child(this._statusLabel);

        topRow.add_child(this._cover);
        topRow.add_child(infoBox);

        // ── Controles ─────────────────────────────────────────────────────────
        let controlsRow = new St.BoxLayout({ style_class: 'music-controls' });
        controlsRow.set_x_align(Clutter.ActorAlign.CENTER);

        this._prevBtn = this._makeIconBtn(
            'media-skip-backward-symbolic', 16,
            () => spawnAsync('playerctl previous'));

        // guardamos _playIcon aparte para poder intercambiar play↔pause sin reconstruir el botón
        this._playIcon = new St.Icon({
            icon_name: 'media-playback-start-symbolic',
            icon_size: 20,
        });
        this._playBtn = new St.Button({
            style_class: 'music-btn-play',
            reactive:    true,
            can_focus:   true,
            track_hover: true,
        });
        this._playBtn.set_child(this._playIcon);
        this._playBtn.connect('clicked', () => spawnAsync('playerctl play-pause'));

        this._nextBtn = this._makeIconBtn(
            'media-skip-forward-symbolic', 16,
            () => spawnAsync('playerctl next'));

        controlsRow.add_child(this._prevBtn);
        controlsRow.add_child(this._playBtn);
        controlsRow.add_child(this._nextBtn);

        this._container.add_child(topRow);
        this._container.add_child(controlsRow);

        this.setContent(this._container);
        this.setHeader('');
    },

    _makeIconBtn: function (iconName, iconSize, callback, styleClass) {
        let btn = new St.Button({
            style_class: styleClass || 'music-btn',
            reactive:    true,
            can_focus:   true,
            track_hover: true,
        });
        btn.set_child(new St.Icon({ icon_name: iconName, icon_size: iconSize }));
        btn.connect('clicked', callback);
        return btn;
    },

    _startTimer: function () {
        if (this._timer) { GLib.source_remove(this._timer); this._timer = null; }
        this._update();
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
            this._update();
            return GLib.SOURCE_CONTINUE;
        });
    },

    // todo en un solo sh para no tener 4 procesos de playerctl corriendo al mismo tiempo.
    // printf los concatena separados por saltos de línea y los parseamos todos de una.
    _update: function () {
        if (this._pauseOnFullscreen && _isAnyWindowFullscreen()) return;
        if (this._fetching) return;
        this._fetching = true;

        let cmd = 'printf "%s\\n%s\\n%s\\n%s\\n"'
            + ' "$(playerctl status 2>/dev/null)"'
            + ' "$(playerctl metadata title 2>/dev/null)"'
            + ' "$(playerctl metadata artist 2>/dev/null)"'
            + ' "$(playerctl metadata mpris:artUrl 2>/dev/null)"';

        try {
            let proc = new Gio.Subprocess({
                argv:  ['/bin/sh', '-c', cmd],
                flags: Gio.SubprocessFlags.STDOUT_PIPE
                     | Gio.SubprocessFlags.STDERR_SILENCE,
            });
            proc.init(null);
            proc.communicate_utf8_async(null, null, (p, res) => {
                this._fetching = false;
                if (this._destroyed) return;
                try {
                    let [, out] = p.communicate_utf8_finish(res);
                    if (out) this._applyUpdate(out);
                } catch (e) {}
            });
        } catch (e) {
            this._fetching = false;
            this._titleLabel.set_text('playerctl no encontrado');
        }
    },

    _applyUpdate: function (data) {
        let lines  = data.split('\n');
        let status = (lines[0] || '').trim();
        let title  = (lines[1] || '').trim();
        let artist = (lines[2] || '').trim();
        let artUrl = (lines[3] || '').trim();

        if (!status || status === 'No players found') {
            this._titleLabel.set_text('Sin reproduccion');
            this._artistLabel.set_text('---');
            this._statusLabel.set_text('[ ]');
            this._playIcon.set_icon_name('media-playback-start-symbolic');
            this._setCoverFallback();
            return;
        }

        this._titleLabel.set_text(truncate(title  || 'Desconocido', this._maxChars));
        this._artistLabel.set_text(truncate(artist || '---',         this._maxChars));

        if (status === 'Playing') {
            this._statusLabel.set_text('[>] reproduciendo');
            this._playIcon.set_icon_name('media-playback-pause-symbolic');
        } else if (status === 'Paused') {
            this._statusLabel.set_text('[|] pausado');
            this._playIcon.set_icon_name('media-playback-start-symbolic');
        } else {
            this._statusLabel.set_text('[ ] ' + status.toLowerCase());
            this._playIcon.set_icon_name('media-playback-start-symbolic');
        }

        this._updateCover(artUrl);

        // escribimos en cada tick exitoso así siempre tenemos el estado más reciente
        this._saveCache({ status: status, title: title, artist: artist, artUrl: artUrl });
    },

    // ── Portada — solo Gio.FileIcon, sin GdkPixbuf ni Cogl ───────────────────
    _updateCover: function (artUrl) {
        if (!artUrl || artUrl === this._lastArtUrl) return;
        this._lastArtUrl = artUrl;

        if (artUrl.startsWith('file://')) {
            let path = artUrl.slice(7);
            try {
                let file = Gio.File.new_for_path(path);
                if (file.query_exists(null)) {
                    this._cover.set_gicon(new Gio.FileIcon({ file: file }));
                    this._cover.set_icon_size(this._coverSize);
                    return;
                }
            } catch (e) {}
        }
        this._setCoverFallback();
    },

    _setCoverFallback: function () {
        this._lastArtUrl = null;
        try {
            this._cover.set_gicon(null);
            this._cover.set_icon_name('audio-x-generic');
            this._cover.set_icon_size(this._coverSize);
        } catch (e) {}
    },

    _onSettingsChanged: function () {
        this._cover.set_icon_size(this._coverSize);
        // actualizamos el estilo cuadrado de la carátula cuando cambia su tamaño
        this._cover.set_style(
            'min-width: '  + this._coverSize + 'px;' +
            'min-height: ' + this._coverSize + 'px;' +
            'max-width: '  + this._coverSize + 'px;' +
            'max-height: ' + this._coverSize + 'px;');
        // si auto_opacity acaba de activarse, re-samplear el wallpaper ahora
        if (this._autoOpacity) this._sampleWallpaper();
        this._applyContainerStyle();
        this._titleLabel.set_style('font-size: ' + this._titleFontSize + 'px;');
        // forzamos refresh inmediato para que _maxChars se aplique sin esperar el timer
        this._fetching = false;
        this._update();
    },

    on_desklet_removed: function () {
        this._destroyed = true;
        if (this._timer) { GLib.source_remove(this._timer); this._timer = null; }
        // ojo: si no desconectamos la señal de GSettings puede dispararse después de que
        // el objeto esté destruido y crashear Cinnamon con un error muy críptico
        if (this._bgSettings && this._bgSignalId) {
            try { this._bgSettings.disconnect(this._bgSignalId); } catch (e) {}
            this._bgSignalId = null;
        }
        if (this._settings) { try { this._settings.finalize(); } catch (e) {} }
    },
};

function main(metadata, desklet_id) {
    return new MusicDesklet(metadata, desklet_id);
}
