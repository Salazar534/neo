# Neo

**Local-first autonomous coding agent** — foundational AI for your PC.

Neo runs on your machine. Conversations, tools, and its own API stay on-device. No cloud account required for core AI. Open source under MIT.

## Install (simple)

Requires **Node.js 20+**. Full model bundle is about **~6.5 GB** download (run once via `neo install`).

### Works right now (recommended until npm publish)

**Windows (PowerShell / CMD)** — set a writable npm prefix first (fixes WinGet Node `EPERM`/`EEXIST`):

```powershell
npm config set prefix "$env:APPDATA\npm"
git clone https://github.com/Salazar534/neo.git
cd neo
npm install -g . --force
neo install
```

**macOS / Linux:**

```bash
git clone https://github.com/Salazar534/neo.git
cd neo
npm install -g . --force
neo install
```

One-liner alternative (HTTPS git URL — if this leaves an empty install on Windows, use the clone steps above):

```bash
npm install -g https://github.com/Salazar534/neo.git --force && neo install
```

### From npm (after `@node30/neo` is published)

```bash
npm install -g @node30/neo
neo install
```

Then:

```bash
neo doctor
neo
```

If `neo` is missing or Windows conflicts on `neo.cmd`:

```bash
neo repair
```

(or from the clone: `node bin/fix-path.mjs`) then open a **new** terminal.

| Goal | Command |
|---|---|
| **Works now** | `git clone … && cd neo && npm install -g . --force && neo install` |
| After npm publish | `npm install -g @node30/neo && neo install` |
| Models during npm | `NEO_INSTALL_MODELS=1 npm install -g …` |
| Text brain only | `neo install --skip-image` |
| Fix PATH / stale shims | `neo repair` |

`npm install -g` installs the small CLI only. Models are **not** downloaded in postinstall by default.

## Neo foundational models

| Asset | Path | Download | Disk | Role |
|---|---|---:|---:|---|
| **Neo Brain** | `neo-brain.gguf` | ~1.93 GB | ~1.93 GB | Powers **Neo Plan / Neo Code / Neo Work** (one shared GGUF) |
| **Neo Code** | `neo-coder.gguf` | ~0 | ~0* | Same weights as Neo Brain (hardlink when possible) |
| **Neo Vision** | `neo-image/` | ~2.6 GB | ~2.6 GB | Local image generation |
| Brain runtime | `venv/` (pip) | ~0.12 GB | ~0.12 GB | llama-cpp + hub |
| Vision runtime | `venv/` (pip) | ~1.8 GB | ~1.8 GB | torch / diffusers (skip with `--skip-image`) |

\* If hardlink fails, Neo Code is a full copy (~+1.93 GB disk).

| | Approx |
|---|---:|
| **Total download (full)** | **~6.5 GB** |
| **Total disk (full, hardlink OK)** | **~6.5 GB** |
| Text only (`neo install --skip-image`) | ~2.05 GB |

**Honest note:** Neo Plan, Neo Code, and Neo Work are **modes** on one Neo Brain GGUF — not three separate downloads.

Data dirs: Windows `%LOCALAPPDATA%\Neo` · macOS `~/Library/Application Support/Neo` · Linux `~/.local/share/neo` (or `$XDG_DATA_HOME/neo`).

## Features

- **Local API** — OpenAI-compatible endpoints on localhost for the Neo brain
- **SQLite conversations** — history stays on your PC
- **Multi-file edit** — change projects in place from the agent loop
- **PC search** — find files and content across your workspace
- **Desktop & Documents** — work with the folders you already use
- **Browser preview** — see web UIs while you iterate
- **Web research** — fetch context when you ask for it
- **1000+ tools** — catalog-backed skills for real agent work
- **Native CLI** — `neo` via npm bin on Windows, macOS, and Linux

## Privacy

Neo is **local by default**. Core AI runs on-device. Optional network features (for example web research) only run when you ask for them. `neo install` needs the network once to fetch Neo model weights.

## Commands

| Command | What it does |
|---|---|
| `neo` | Launch the agent UI (prompts to install models if missing) |
| `neo install` | Download **all** Neo models + brain/vision runtime (progress) |
| `neo install --dry-run` | Show size plan without downloading |
| `neo install --check` | Verify install without downloading |
| `neo install --cpu` | Force CPU-only inference |
| `neo install --skip-image` | Text brain only (skip Neo Vision) |
| `neo doctor` | OS, PATH, model, GPU/CPU, daemon status |
| `neo repair` | Clear stale `neo.cmd` / fix npm prefix PATH |
| `neo brain` | Run the brain daemon in the foreground |
| `neo help` | Help |

## Usage

Neo opens on a **mode picker** (Neo Plan / Neo Code / Neo Work), then keeps chat open until `/quit`.

- `/plan` `/code` `/work` — switch modes
- `/tools <query>` — search the tool catalog
- `/img <prompt>` — image via Neo Vision (when available)
- `/voice` — dictation (platform-dependent)
- Workspace = **your current directory** (`NEO_WORKSPACE` on launch)

## Architecture

```
neo (Node CLI)
  ├─ ui/           classic | Ink UI → agent loop
  ├─ core/         1000+ tools, skills, SQLite
  └─ daemon/       local Neo brain API (localhost)
```

## Env vars

| Var | Meaning |
|---|---|
| `NEO_WORKSPACE` | Root for relative file tools (default: cwd) |
| `NEO_BRAIN_PORT` | Brain daemon port (default `8766`) |
| `NEO_N_GPU_LAYERS` | GPU layers (`-1` all, `0` CPU) |
| `NEO_MODEL_PATH` | Override Neo Brain GGUF path |
| `NEO_INK=1` | Prefer Ink TUI when raw mode works |
| `NEO_HOME` | Override data dir |
| `NEO_INSTALL_MODELS=1` | postinstall runs full `neo install` |
| `NEO_SKIP_INSTALL_PROMPT=1` | skip first-run install prompt |

## Smoke / tests

```bash
npm run smoke
neo install --dry-run
neo doctor
```

## Author

Enrico

## License

MIT — see [LICENSE](LICENSE).
