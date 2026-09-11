# Neo

**Local-first autonomous coding agent** — foundational AI for your PC.

Neo runs on your machine. Conversations, tools, and its own API stay on-device. No cloud account required for core AI. Open source under MIT.

## Install

Requires **Node.js 20+**. One command does the full setup after the CLI is on PATH:

**`neo install`** = Brain GGUF + Plan/Code/Work aliases + Neo Vision + Python runtimes (~**6.45 GB**), progress in the **same terminal** (Mac & Windows). No extra windows.

### GitHub (works today)

```bash
git clone https://github.com/Salazar534/neo.git && cd neo && npm install -g . && neo install
```

### npm (after `@node30/neo` is published)

```bash
npm install -g @node30/neo && neo install
```

Then: `neo doctor` · `neo`

Same on **macOS Terminal** and **Windows PowerShell / CMD**. Details: [INSTALL.md](INSTALL.md).

If `neo` is missing, open a new terminal or run `neo repair` (from the clone: `node bin/neo.js repair`).

| | |
|---|---|
| Full setup (default) | `neo install` |
| Text only | `neo install --skip-image` |
| Size plan | `neo install --dry-run` |
| Fix PATH / stale shims | `neo repair` |

`npm install -g` installs the CLI only. Models download only when you run `neo install` (or `NEO_INSTALL_MODELS=1` during npm).

## Where models live

| OS | Path |
|---|---|
| **Windows** | `%LOCALAPPDATA%\Neo\models\` |
| **macOS** | `~/Library/Application Support/Neo/models/` |
| **Linux** | `~/.local/share/neo/models/` |

```
models/
  neo-brain.gguf     # shared weights (one download)
  neo-coder.gguf     # hardlink → Neo Code
  neo-plan.gguf      # hardlink → Neo Plan
  neo-work.gguf      # hardlink → Neo Work
  neo-image/         # Neo Vision
```

Override with `NEO_HOME` if needed.

## Neo foundational models

| Asset | Path | Download | Disk | Role |
|---|---|---:|---:|---|
| **Neo Brain** | `neo-brain.gguf` | ~1.93 GB | ~1.93 GB | Shared GGUF for Plan / Code / Work |
| **Neo Code** | `neo-coder.gguf` | ~0 | ~0* | Role alias of Neo Brain |
| **Neo Plan** | `neo-plan.gguf` | ~0 | ~0* | Role alias of Neo Brain |
| **Neo Work** | `neo-work.gguf` | ~0 | ~0* | Role alias of Neo Brain |
| **Neo Vision** | `neo-image/` | ~2.6 GB | ~2.6 GB | Local image generation |
| Brain runtime | `venv/` (pip) | ~0.12 GB | ~0.12 GB | llama-cpp + hub |
| Vision runtime | `venv/` (pip) | ~1.8 GB | ~1.8 GB | torch / diffusers (skip with `--skip-image`) |

\* If hardlink fails, each role alias is a full copy (~+1.93 GB disk).

| | Approx |
|---|---:|
| **Total download (full)** | **~6.45 GB** |
| **Total disk (full, hardlink OK)** | **~6.45 GB** |
| Text only (`neo install --skip-image`) | ~2.05 GB |

Neo Plan / Neo Code / Neo Work are **modes** on one Neo Brain GGUF — not three separate downloads.

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
| `neo repair` | Fix stale `neo` shims / npm global PATH |
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
