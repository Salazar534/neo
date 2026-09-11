# Install Neo

Requires **Node.js 20+**.

**`neo install`** is the full setup in **one command / one terminal** (Mac & Windows):

1. Neo Brain GGUF
2. Neo Plan / Code / Work aliases
3. Neo Vision image weights
4. Brain venv + `llama-cpp-python`
5. Vision Python deps (torch / diffusers)

≈ **6.45 GB** once. Progress (sizes + %) prints in that same terminal. No extra windows.

## Mac (Terminal)

### From GitHub (works today)

```bash
git clone https://github.com/Salazar534/neo.git
cd neo
npm install -g .
neo install
```

### From npm (after publish)

```bash
npm install -g @node30/neo
neo install
```

Then: `neo doctor` · `neo`

## Windows (PowerShell or CMD)

### From GitHub (works today)

```powershell
git clone https://github.com/Salazar534/neo.git
cd neo
npm install -g .
neo install
```

### From npm (after publish)

```powershell
npm install -g @node30/neo
neo install
```

Then: `neo doctor` · `neo`

If `neo` is not found, open a **new** terminal. Still stuck? From the clone folder:

```powershell
node bin/neo.js repair
npm install -g .
```

## What you get

| | |
|---|---|
| CLI | small npm package (`@node30/neo`) |
| Full setup | `neo install` (everything above) |
| Size | ~6.45 GB download (full); text-only: `neo install --skip-image` (~2 GB) |

Models live under:

- **Windows:** `%LOCALAPPDATA%\Neo\models\`
- **macOS:** `~/Library/Application Support/Neo/models/`
- **Linux:** `~/.local/share/neo/models/`

## Publish `@node30/neo` (Enrico)

Package is **not** on the registry until published. On a machine logged into npm as the `@node30` org owner:

```bash
npm whoami
# expect an account that can publish to @node30

cd neo   # this repo
npm view @node30/neo   # should 404 until first publish
npm publish --access public
npm view @node30/neo
```

If `npm whoami` fails: `npm login` (or `npm adduser`), then retry `npm publish --access public`.

Version is in `package.json` (`publishConfig.access: public` is already set).
