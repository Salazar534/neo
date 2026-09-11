# Neo

**Local-first autonomous coding agent** — foundational AI for your PC.

Neo runs on your machine. Conversations, tools, and its own API stay on-device. No cloud account required for core AI. Open source under MIT.

## The breakthrough

A fully local coding agent with:

- its own local API
- a large tool surface (1000+)
- SQLite-backed conversations
- multi-file editing and PC-wide search
- Desktop / Documents access
- browser preview
- web research when you ask for it

All of that without shipping your work to a remote model by default.

## Neo foundational models

Neo ships under Neo-branded model lines:

| Model | Role |
|---|---|
| **Neo Vision** | Vision / image understanding and generation |
| **Neo Code** | Coding brain for plan and code modes |
| **Neo Work** | General agent / work-mode brain |

Modes: **plan**, **code**, and **work** — pick how Neo should think and act for the task.

## Install

```bash
npm install -g @node30/neo
neo install
neo
```

That installs a native `neo` command for **Windows CMD** and **PowerShell** (and typical Unix shells via npm’s shim).

`neo install` sets up the local brain runtime and Neo models. It does not run during `npm install` (too heavy for postinstall).

### From this repo (dev)

```bash
npm install
npm run install-global
neo install
neo doctor
neo
```

## Features

- **Local API** — OpenAI-compatible endpoints on localhost for the Neo brain
- **SQLite conversations** — history stays on your PC
- **Multi-file edit** — change projects in place from the agent loop
- **PC search** — find files and content across your workspace
- **Desktop & Documents** — work with the folders you already use
- **Browser preview** — see web UIs while you iterate
- **Web research** — fetch context when you ask for it
- **1000+ tools** — catalog-backed skills for real agent work
- **Native CLI** — `neo` on Windows CMD + PowerShell

## Privacy

Neo is **local by default**. Core AI runs on-device. No cloud is required for the main coding and agent experience. Optional network features (for example web research) only run when you ask for them.

## Commands

| Command | What it does |
|---|---|
| `neo` | Launch the agent UI |
| `neo install` | Download / verify Neo models + brain runtime |
| `neo install --dry-run` | Show plan without downloading |
| `neo install --check` | Verify install without downloading |
| `neo install --cpu` | Force CPU-only inference |
| `neo doctor` | PATH, model, GPU/CPU, daemon status |
| `neo brain` | Run the brain daemon in the foreground |
| `neo help` | Help |

## Usage

Neo opens on a **mode picker** (PLAN / CODE / WORK), then keeps chat open until `/quit`.

- `/plan` `/code` `/work` — switch modes
- `/tools <query>` — search the tool catalog
- `/img <prompt>` — image via Neo Vision (when available)
- `/voice` — Windows dictation
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
| `NEO_MODEL_PATH` | Override Neo Code / Work model path |
| `NEO_INK=1` | Prefer Ink TUI when raw mode works |
| `NEO_HOME` | Override data dir (default `%LOCALAPPDATA%\Neo`) |

## Smoke / tests

```bash
npm run smoke
npm run test:brain-client
neo install --dry-run
neo doctor
```

## Author

Enrico

## License

MIT — see [LICENSE](LICENSE).
