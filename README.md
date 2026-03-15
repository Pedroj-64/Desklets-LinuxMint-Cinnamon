# Desklets for Linux Mint Cinnamon

A collection of custom desklets for Linux Mint Cinnamon with a clean Tokyo Night inspired aesthetic.

English | [Espanol](#espanol)

---

## Included desklets

| Desklet | Purpose |
|--------|---------|
| `clock@ajolote` | Minimal clock and date |
| `music@ajolote` | Music controls and now playing (MPRIS/playerctl) |
| `sysmonitor@ajolote` | CPU, RAM and GPU usage monitor |
| `cava@ajolote` | Audio visualizer powered by `cava` |
| `weather@ajolote` | Weather desklet using OpenWeatherMap |

---

## Requirements

- Linux Mint 22.x (Cinnamon)
- `cava` for `cava@ajolote`
- `playerctl` for `music@ajolote`
- OpenWeatherMap API key for `weather@ajolote`
- JetBrainsMono Nerd Font (recommended)

Install dependencies:

```bash
sudo apt update
sudo apt install -y cava playerctl
```

---

## Installation

```bash
git clone https://github.com/Pedroj-64/Desklets-LinuxMint-Cinnamon.git
mkdir -p ~/.local/share/cinnamon/desklets
cp -r Desklets-LinuxMint-Cinnamon/*@ajolote ~/.local/share/cinnamon/desklets/
```

Then open: System Settings > Desklets, and enable the desklets you want.

---

## Weather setup (important)

The weather desklet includes:

- `weather@ajolote/config.json.example`
- `weather@ajolote/config.json`

Recommended workflow:

```bash
cp ~/.local/share/cinnamon/desklets/weather@ajolote/config.json.example \
	~/.local/share/cinnamon/desklets/weather@ajolote/config.json
```

Edit `config.json` and set your OpenWeatherMap API key and location values.

---

## Project structure

```text
.
|- clock@ajolote/
|- music@ajolote/
|- sysmonitor@ajolote/
|- cava@ajolote/
`- weather@ajolote/
```

Each desklet folder contains:

- `desklet.js` (logic)
- `stylesheet.css` (styles)
- `metadata.json` (desklet metadata)
- `settings-schema.json` (Cinnamon settings)

---

## Technical notes

- Built with GJS (GNOME JavaScript), not browser JavaScript
- Timers use `GLib.timeout_add` instead of `setInterval`
- External commands run via `Gio.Subprocess`
- Visual style follows Tokyo Night colors

---

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test on Cinnamon
5. Open a pull request

---

#### 🏆 Lead Developer
**Pedro José Soto Rivera**
*Basic Java, JavaScript, Python, Elixir/Erlang, React, Spring (noob), Kotlin and Gradle, C#. Junior Cybersecurity Analyst*
Architecture, frontend & backend development, API integration, CI/CD

---

## Espanol

Coleccion de desklets personalizados para Linux Mint Cinnamon con una estetica limpia inspirada en Tokyo Night.

---

## Desklets incluidos

| Desklet | Funcion |
|--------|---------|
| `clock@ajolote` | Reloj y fecha minimalistas |
| `music@ajolote` | Controles de musica y reproduccion actual (MPRIS/playerctl) |
| `sysmonitor@ajolote` | Monitor de uso de CPU, RAM y GPU |
| `cava@ajolote` | Visualizador de audio con `cava` |
| `weather@ajolote` | Widget del clima con OpenWeatherMap |

---

## Requisitos

- Linux Mint 22.x (Cinnamon)
- `cava` para `cava@ajolote`
- `playerctl` para `music@ajolote`
- API key de OpenWeatherMap para `weather@ajolote`
- JetBrainsMono Nerd Font (recomendada)

Instalar dependencias:

```bash
sudo apt update
sudo apt install -y cava playerctl
```

---

## Instalacion

```bash
git clone https://github.com/Pedroj-64/Desklets-LinuxMint-Cinnamon.git
mkdir -p ~/.local/share/cinnamon/desklets
cp -r Desklets-LinuxMint-Cinnamon/*@ajolote ~/.local/share/cinnamon/desklets/
```

Luego abre: Configuracion del sistema > Desklets, y activa los que quieras.

---

## Configuracion del clima (importante)

El desklet del clima incluye:

- `weather@ajolote/config.json.example`
- `weather@ajolote/config.json`

Flujo recomendado:

```bash
cp ~/.local/share/cinnamon/desklets/weather@ajolote/config.json.example \
	~/.local/share/cinnamon/desklets/weather@ajolote/config.json
```

Edita `config.json` y define tu API key de OpenWeatherMap y los valores de ubicacion.

---

## Estructura del proyecto

```text
.
|- clock@ajolote/
|- music@ajolote/
|- sysmonitor@ajolote/
|- cava@ajolote/
`- weather@ajolote/
```

Cada carpeta de desklet contiene:

- `desklet.js` (logica)
- `stylesheet.css` (estilos)
- `metadata.json` (metadatos del desklet)
- `settings-schema.json` (ajustes de Cinnamon)

---

## Notas tecnicas

- Desarrollado con GJS (JavaScript de GNOME), no JavaScript de navegador
- Los timers usan `GLib.timeout_add` en lugar de `setInterval`
- Los comandos externos se ejecutan con `Gio.Subprocess`
- El estilo visual sigue la paleta Tokyo Night

---

## Contribuir

1. Haz un fork del repositorio
2. Crea una rama para tu cambio
3. Realiza los cambios
4. Prueba en Cinnamon
5. Abre un pull request

---


#### 🏆 Desarrollador Principal
**Pedro José Soto Rivera**  
*Basic Java, JavaScript, Python, Elixir/Erlang , React, Spring (noob),Kotlin and Gradle, C#. Junior Cybersecurity Analyst*  
Arquitectura, desarrollo frontend & backend, integración de APIs, CI/CD
