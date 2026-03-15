# 🦎 Desklets — Linux Mint Cinnamon

> A collection of custom desklets for Linux Mint Cinnamon, built to bring a modern Hyprland-inspired aesthetic to a traditional desktop environment.

**English** | [Español](#español)

---

## Preview

| Desklet | Description |
|--------|-------------|
| `cava@ajolote` | Audio visualizer using cava as a subprocess |
| `music@ajolote` | Music player with album art via MPRIS/playerctl |
| `sysmonitor@ajolote` | CPU, RAM and GPU resource monitor |
| `clock@ajolote` | Minimal clock with date in JetBrainsMono |
| `weather@ajolote` | Weather widget using OpenWeatherMap API |

---

## Requirements

- Linux Mint 22.x with Cinnamon desktop
- `cava` installed (`sudo apt install cava`)
- `playerctl` installed (`sudo apt install playerctl`)
- OpenWeatherMap API key (free) for the weather desklet
- JetBrainsMono Nerd Font (recommended)

---

## Installation

```bash
# Clone the repository
git clone https://github.com/Pedroj-64/Desklets-LinuxMint-Cinnamon.git

# Copy desklets to Cinnamon's desklet directory
cp -r Desklets-LinuxMint-Cinnamon/*@ajolote ~/.local/share/cinnamon/desklets/
```

Then go to **System Settings → Desklets** and enable the ones you want.

---

## Color palette

All desklets use the [Tokyo Night](https://github.com/folke/tokyonight.nvim) color scheme.

| Token | Hex |
|-------|-----|
| Background | `#1a1b26` |
| Surface | `#1f2335` |
| Border | `#414868` |
| Text | `#c0caf5` |
| Blue | `#7aa2f7` |
| Purple | `#9a7ecc` |
| Cyan | `#4abaaf` |
| Green | `#9ece6a` |

---

## Notes

- Built with **GJS** (GNOME JavaScript) — not a browser environment
- No blur or real transparency (Muffin compositor limitation)
- Timers use `GLib.timeout_add`, not `setInterval`
- External commands use `Gio.Subprocess`

---

## Author

**Pedro** — Systems and Computer Engineering student @ UniQuindío  
Junior Cybersecurity Analyst | Java · JavaScript · Python

---

---

## Español

> Colección de desklets personalizados para Linux Mint Cinnamon, diseñados para darle una estética moderna inspirada en Hyprland a un entorno de escritorio tradicional.

---

## Vista previa

| Desklet | Descripción |
|--------|-------------|
| `cava@ajolote` | Visualizador de audio usando cava como subproceso |
| `music@ajolote` | Reproductor de música con carátula vía MPRIS/playerctl |
| `sysmonitor@ajolote` | Monitor de recursos: CPU, RAM y GPU |
| `clock@ajolote` | Reloj minimal con fecha en JetBrainsMono |
| `weather@ajolote` | Widget del clima con la API de OpenWeatherMap |

---

## Requisitos

- Linux Mint 22.x con escritorio Cinnamon
- `cava` instalado (`sudo apt install cava`)
- `playerctl` instalado (`sudo apt install playerctl`)
- API key de OpenWeatherMap (gratuita) para el desklet del clima
- JetBrainsMono Nerd Font (recomendado)

---

## Instalación

```bash
# Clonar el repositorio
git clone https://github.com/Pedroj-64/Desklets-LinuxMint-Cinnamon.git

# Copiar los desklets al directorio de Cinnamon
cp -r Desklets-LinuxMint-Cinnamon/*@ajolote ~/.local/share/cinnamon/desklets/
```

Luego ve a **Configuración del sistema → Desklets** y activa los que quieras.

---

## Paleta de colores

Todos los desklets usan el esquema de colores [Tokyo Night](https://github.com/folke/tokyonight.nvim).

| Token | Hex |
|-------|-----|
| Fondo | `#1a1b26` |
| Superficie | `#1f2335` |
| Borde | `#414868` |
| Texto | `#c0caf5` |
| Azul | `#7aa2f7` |
| Morado | `#9a7ecc` |
| Cyan | `#4abaaf` |
| Verde | `#9ece6a` |

---

## Notas técnicas

- Desarrollado con **GJS** (JavaScript de GNOME) — no es un entorno de navegador
- Sin blur ni transparencia real (limitación del compositor Muffin)
- Los timers usan `GLib.timeout_add`, no `setInterval`
- Los comandos externos se ejecutan con `Gio.Subprocess`

---

## Autor

**Pedro Soto (Ajolote)** — Estudiante de Ingeniería de Sistemas y Computación @ UniQuindío  
Junior Cybersecurity Analyst | Java · JavaScript · Python
