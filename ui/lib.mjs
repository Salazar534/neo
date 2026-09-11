import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_BRAIN_PORT,
  loadConfig,
  resolvePython,
  PACKAGE_ROOT,
  neoDataRoot,
} from "../bin/paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");
export const CORE = path.join(ROOT, "core");
export const EXEC = path.join(CORE, "executor.py");
export const CATALOG = path.join(CORE, "tools_catalog.json");
/** Session state lives in user data dir so global installs stay writable. */
export const STATE = path.join(neoDataRoot(), "session_state.json");
const COMFY_PY = path.resolve(ROOT, "..", "ComfyUI", ".venv", "Scripts", "python.exe");
export const PY = fs.existsSync(COMFY_PY) ? COMFY_PY : resolvePython();
/** @private hidden external LLM host (NEO_USE_OLLAMA=1 only) */
const EXTERNAL_LLM = (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/$/, "");

// Migrate legacy in-repo session state once
try {
  const legacy = path.join(CORE, "session_state.json");
  if (!fs.existsSync(STATE) && fs.existsSync(legacy)) {
    fs.mkdirSync(neoDataRoot(), { recursive: true });
    fs.copyFileSync(legacy, STATE);
  }
} catch {
  /* */
}

export function brainBaseUrl() {
  const cfg = loadConfig();
  const port = Number(process.env.NEO_BRAIN_PORT || cfg?.brain_port || DEFAULT_BRAIN_PORT);
  return (process.env.NEO_BRAIN_URL || `http://127.0.0.1:${port}`).replace(/\/$/, "");
}

export function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE, "utf8"));
  } catch {
    return { mode: null, text_model: process.env.NEO_TEXT_MODEL || "neo-brain" };
  }
}

export function writeState(st) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(st, null, 2));
}

export function pyExec(tool, args = {}) {
  const env = { ...process.env };
  if (!env.NEO_WORKSPACE) env.NEO_WORKSPACE = process.cwd();
  const r = spawnSync(PY, [EXEC, tool, JSON.stringify(args)], {
    encoding: "utf8",
    maxBuffer: 20_000_000,
    windowsHide: true,
    env,
  });
  if (r.error) return { ok: false, error: String(r.error.message || r.error) };
  const raw = (r.stdout || "").trim();
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return { ok: false, error: (r.stderr || raw || "bad executor output").slice(0, 500) };
  }
}

export function ensureCatalog() {
  if (!fs.existsSync(CATALOG)) {
    spawnSync(PY, [path.join(CORE, "gen_catalog.py")], { stdio: "ignore", windowsHide: true });
  }
}

/** Prefer pythonw.exe on Windows — GUI subsystem, never allocates a console. */
function resolvePythonHidden(pyPath = PY) {
  if (process.platform !== "win32") return pyPath;
  const raw = String(pyPath);
  if (/pythonw\.exe$/i.test(raw)) return raw;
  if (/python\.exe$/i.test(raw)) {
    const w = raw.replace(/python\.exe$/i, "pythonw.exe");
    if (fs.existsSync(w)) return w;
  }
  const venvW = path.join(neoDataRoot(), "venv", "Scripts", "pythonw.exe");
  if (fs.existsSync(venvW)) return venvW;
  const comfyW = path.resolve(ROOT, "..", "ComfyUI", ".venv", "Scripts", "pythonw.exe");
  if (fs.existsSync(comfyW)) return comfyW;
  return raw;
}

function daemonLogPath(name) {
  const dir = path.join(neoDataRoot(), "logs");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${name}.log`);
}

/**
 * Spawn a long-lived daemon with no visible console on Windows.
 * Uses pythonw when available, windowsHide (CREATE_NO_WINDOW), log-file stdio.
 * Never uses wt.exe / Start-Process / cmd start.
 */
function spawnDaemonHidden(script, logName, pyPath = PY) {
  const logFile = daemonLogPath(logName);
  let outFd = "ignore";
  try {
    outFd = fs.openSync(logFile, "a");
  } catch {
    outFd = "ignore";
  }
  const exe = resolvePythonHidden(pyPath);
  const isPythonw = /pythonw\.exe$/i.test(String(exe));
  // detached + python.exe under Windows Terminal = blank console window.
  // Only detach with pythonw (GUI subsystem) or on non-Windows.
  const opts = {
    stdio: outFd === "ignore" ? "ignore" : ["ignore", outFd, outFd],
    windowsHide: true,
    env: {
      ...process.env,
      NEO_DAEMON_LOG: logFile,
      PYTHONUNBUFFERED: "1",
    },
  };
  if (process.platform !== "win32" || isPythonw) {
    opts.detached = true;
  }
  const child = spawn(exe, [script], opts);
  child.unref();
  if (typeof outFd === "number") {
    try {
      fs.closeSync(outFd);
    } catch {
      /* */
    }
  }
  return child;
}

/** In-process health — never spawn node -e (that opened blank Windows Terminal windows). */
async function probeDaemonHealth(url, timeoutMs = 2500) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (res.ok) {
      const j = await res.json().catch(() => ({}));
      return j?.ready ? "ready" : "up";
    }
    return "up";
  } catch {
    return "down";
  } finally {
    clearTimeout(t);
  }
}

let _imageStartAttempted = false;
let _brainStartAttempted = false;

/** Silent: start image daemon only if unreachable. No console windows. */
export async function ensureImageDaemonSilent() {
  const status = await probeDaemonHealth("http://127.0.0.1:8765/health");
  if (status === "ready" || status === "up") return status === "ready";
  if (_imageStartAttempted) return false;
  _imageStartAttempted = true;
  spawnDaemonHidden(path.join(ROOT, "daemon", "image_daemon.py"), "neo-image", PY);
  return false;
}

/** Start Neo brain daemon only if unreachable. No console windows. */
export async function ensureBrainDaemonSilent() {
  if (process.env.NEO_USE_OLLAMA === "1") return false;
  const base = brainBaseUrl();
  const status = await probeDaemonHealth(`${base}/health`, 3000);
  if (status === "ready" || status === "up") return status === "ready";
  if (_brainStartAttempted) return false;
  _brainStartAttempted = true;
  spawnDaemonHidden(path.join(PACKAGE_ROOT, "daemon", "brain_daemon.py"), "neo-brain", resolvePython());
  return false;
}

/** Wait until brain HTTP responds (conversations work even while GGUF loads). */
export async function waitBrainApi(ms = 45_000) {
  if (process.env.NEO_CHAT_LOCAL === "1") return false;
  const base = brainBaseUrl();
  await ensureBrainDaemonSilent();
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function waitBrainReady(ms = 120_000) {
  const base = brainBaseUrl();
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const res = await fetch(`${base}/health`);
      const j = await res.json();
      if (j.ready) return true;
      if (j.error && /not installed|No GGUF|FileNotFound/i.test(String(j.error))) {
        throw new Error(j.error + " — run: neo install");
      }
    } catch (e) {
      if (String(e.message || e).includes("neo install")) throw e;
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error("Neo brain daemon did not become ready. Run: neo install && neo doctor");
}

export const META_TOOLS = [
  {
    type: "function",
    function: {
      name: "search_tools",
      description: "Search Neo's 1000+ tools",
      parameters: {
        type: "object",
        required: ["query"],
        properties: { query: { type: "string" }, limit: { type: "integer" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "call_tool",
      description: "Execute a Neo tool by name",
      parameters: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" }, args: { type: "object" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_mode",
      description: "Switch plan|code|work",
      parameters: {
        type: "object",
        required: ["mode"],
        properties: { mode: { type: "string", enum: ["plan", "code", "work"] } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_status",
      description: "Neo status",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "todo_set",
      description: "Set a short checklist for non-trivial work",
      parameters: {
        type: "object",
        required: ["items"],
        properties: {
          items: { type: "array", items: { type: "string" } },
          replace: { type: "boolean" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todo_list",
      description: "List current todos",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "todo_done",
      description: "Mark todo done by index or text",
      parameters: {
        type: "object",
        properties: { index: { type: "integer" }, text: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "project_map",
      description: "Map project files for orientation",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, limit: { type: "integer" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "image_generate",
      description: "Fast local image. Use exact_text for perfect lettering.",
      parameters: {
        type: "object",
        required: ["prompt"],
        properties: {
          prompt: { type: "string" },
          exact_text: { type: "string" },
          width: { type: "integer" },
          height: { type: "integer" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the internet",
      parameters: {
        type: "object",
        required: ["query"],
        properties: { query: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Fetch a URL",
      parameters: {
        type: "object",
        required: ["url"],
        properties: { url: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fs_read",
      description: "Read a file",
      parameters: {
        type: "object",
        required: ["path"],
        properties: { path: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fs_write",
      description: "Write a small file. For large files use fs_write_chunk.",
      parameters: {
        type: "object",
        required: ["path", "content"],
        properties: { path: { type: "string" }, content: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fs_write_chunk",
      description: "Chunked write for large files (path+chunk_index+total or write_id)",
      parameters: {
        type: "object",
        required: ["content"],
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          chunk_index: { type: "integer" },
          total: { type: "integer" },
          write_id: { type: "string" },
          finalize: { type: "boolean" },
          resume: { type: "boolean" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "apply_patch",
      description: "Apply multi-file edits: edits=[{path,old,new,all?}]",
      parameters: {
        type: "object",
        required: ["edits"],
        properties: {
          edits: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                old: { type: "string" },
                new: { type: "string" },
                all: { type: "boolean" },
              },
            },
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fs_edit_replace",
      description: "Replace text in a file",
      parameters: {
        type: "object",
        required: ["path", "old", "new"],
        properties: {
          path: { type: "string" },
          old: { type: "string" },
          new: { type: "string" },
          all: { type: "boolean" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "code_verify",
      description: "Run syntax/smoke verification helpers",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, kind: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shell_powershell",
      description: "Run PowerShell",
      parameters: {
        type: "object",
        required: ["command"],
        properties: { command: { type: "string" } },
      },
    },
  },

  {
    type: "function",
    function: {
      name: "pc_search",
      description: "Search Desktop/Documents/Downloads/Home/cwd by name or text",
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string" },
          scope: { type: "string", enum: ["desktop", "documents", "downloads", "home", "cwd"] },
          kind: { type: "string", enum: ["name", "text"] },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pc_create",
      description: "Create folder/file on Desktop/Documents/Downloads/Home/cwd",
      parameters: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string" },
          scope: { type: "string", enum: ["desktop", "documents", "downloads", "home", "cwd"] },
          content: { type: "string" },
          directory: { type: "boolean" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_open",
      description: "Open URL or local HTML in the default browser",
      parameters: {
        type: "object",
        properties: { url: { type: "string" }, path: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "preview_server",
      description: "Serve a folder on localhost and open browser",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          port: { type: "integer" },
          open: { type: "boolean" },
          action: { type: "string", enum: ["start", "stop"] },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "db_sqlite_query",
      description: "Run SQLite SQL",
      parameters: {
        type: "object",
        required: ["sql"],
        properties: { path: { type: "string" }, sql: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "code_git_status",
      description: "git status in workspace",
      parameters: { type: "object", properties: { cwd: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_set",
      description: "Persist project memory key/value",
      parameters: {
        type: "object",
        required: ["key"],
        properties: { key: { type: "string" }, value: {} },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pkg_pip_install",
      description: "pip install",
      parameters: {
        type: "object",
        required: ["packages"],
        properties: { packages: { type: "string" } },
      },
    },
  },
];

function loadSkills() {
  const dir = path.join(CORE, "skills");
  if (!fs.existsSync(dir)) return "";
  const bits = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!/\.(md|txt)$/i.test(name)) continue;
    try {
      bits.push(fs.readFileSync(path.join(dir, name), "utf8").trim());
    } catch {
      /* */
    }
  }
  return bits.join("\n\n").slice(0, 14000);
}

export function systemPrompt(mode, model) {
  const skills = loadSkills();
  const think =
    mode === "plan"
      ? "Think carefully before answering. Prefer a clear plan, risks, and next steps. Use higher reasoning depth."
      : "Act with tools. Prefer apply_patch for multi-file edits, pc_search/pc_create for PC folders, browser_open/preview_server for HTML previews.";
  return `You are NEO — an elite local coding agent on this Windows PC. Identity: Neo only. MODE=${mode}. model=${model || "neo-brain"}.
Runtime: fully local Neo brain (GGUF). No cloud telemetry. Internet only via web_search/web_fetch when needed.
Workspace = current project directory. You can search and create under Desktop, Documents, Downloads, Home, and cwd.
Use tools. search_tools then call_tool when a specialized tool is needed.
plan = deep reasoning / text planning (extended thinking). code/work = write files and run tools.
${think}
Never invent fake prompts like "Provide the URL:". If you need a file, write it with fs_write or chunked writes.
For Apps Script / code requests: write the full script to a .gs or .js file in the workspace, then tell the user the path in one short line.
Replies: short and concrete. No fluff.
${skills ? "\n--- skills ---\n" + skills : ""}`;
}

/** Client-side XML/JSON tool parse (backup if daemon missed it). */
export function parseToolCallsFromContent(content) {
  if (!content) return { content: "", tool_calls: [] };
  const calls = [];
  let cleaned = content;
  const xml = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  let m;
  while ((m = xml.exec(content))) {
    try {
      const obj = JSON.parse(m[1]);
      const name = obj.name || obj.tool;
      const args = obj.arguments || obj.args || {};
      if (name) {
        calls.push({ function: { name, arguments: typeof args === "string" ? JSON.parse(args) : args } });
        cleaned = cleaned.replace(m[0], "");
      }
    } catch {
      /* */
    }
  }
  return { content: cleaned.trim(), tool_calls: calls };
}

function openaiToNeoMessage(msg) {
  const tool_calls = [];
  for (const tc of msg.tool_calls || []) {
    const fn = tc.function || {};
    let args = fn.arguments;
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        args = { _raw: args };
      }
    }
    tool_calls.push({ function: { name: fn.name, arguments: args || {} } });
  }
  let content = msg.content || "";
  if (!tool_calls.length && content) {
    const parsed = parseToolCallsFromContent(content);
    if (parsed.tool_calls.length) {
      content = parsed.content;
      tool_calls.push(...parsed.tool_calls);
    }
  }
  return { role: "assistant", content: content || "", tool_calls };
}

async function neoBrainChat(messages, model, mode) {
  await ensureBrainDaemonSilent();
  await waitBrainReady();
  const temp = mode === "plan" ? 0.5 : mode === "code" ? 0.2 : 0.35;
  const base = brainBaseUrl();
  // Prefer Neo /api/chat (legacy chat shape)
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: model || "neo-brain",
      messages,
      tools: META_TOOLS,
      stream: false,
      options: { temperature: temp, num_ctx: 16384 },
    }),
  });
  if (!res.ok) {
    // Fallback OpenAI path
    const res2 = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model || "neo-brain",
        messages,
        tools: META_TOOLS,
        temperature: temp,
        max_tokens: 4096,
      }),
    });
    if (!res2.ok) throw new Error(`neo-brain ${res2.status}: ${(await res2.text()).slice(0, 220)}`);
    const data = await res2.json();
    const msg = data.choices?.[0]?.message || {};
    return { model, message: openaiToNeoMessage(msg), done: true };
  }
  const data = await res.json();
  const msg = data.message || {};
  if (!(msg.tool_calls || []).length && msg.content) {
    const parsed = parseToolCallsFromContent(msg.content);
    if (parsed.tool_calls.length) {
      msg.content = parsed.content;
      msg.tool_calls = parsed.tool_calls;
    }
  }
  return data;
}

async function externalLlmChat(messages, model, mode) {
  const temp = mode === "plan" ? 0.5 : mode === "code" ? 0.2 : 0.35;
  const res = await fetch(`${EXTERNAL_LLM}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      tools: META_TOOLS,
      stream: false,
      options: { temperature: temp, num_ctx: 16384 },
    }),
  });
  if (!res.ok) throw new Error(`external-llm ${res.status}: ${(await res.text()).slice(0, 180)}`);
  return res.json();
}

/** @deprecated hidden escape hatch — use neoChat */
export async function externalLlmChatExport(messages, model, mode) {
  return externalLlmChat(messages, model, mode);
}

/**
 * Primary chat: Neo local brain only.
 * Hidden: NEO_USE_OLLAMA=1 forces external LLM host.
 */
export async function neoChat(messages, model, mode) {
  if (process.env.NEO_USE_OLLAMA === "1") {
    return externalLlmChat(messages, model, mode);
  }
  return neoBrainChat(messages, model, mode);
}

/** Conversation persistence via Neo local API + on-disk fallback */
export const MODE_NAMES = {
  plan: "Neo Plan",
  code: "Neo Code",
  work: "Neo Work",
};

export function modeName(mode) {
  const key = String(mode || "work").toLowerCase();
  return MODE_NAMES[key] || `Neo ${key}`;
}

export function modePromptLabel(mode) {
  return `${modeName(mode)} ›`;
}

export function modesHintLine() {
  return "Neo Plan · Neo Code · Neo Work   (/plan /code /work)";
}

export function normalizeWorkspace(ws) {
  const p = path.resolve(ws || process.env.NEO_WORKSPACE || process.cwd());
  return process.platform === "win32" ? p.toLowerCase() : p;
}

function localConversationsDir() {
  return path.join(neoDataRoot(), "conversations");
}

function workspaceNeoDir(ws = process.env.NEO_WORKSPACE || process.cwd()) {
  return path.join(ws, ".neo");
}

function workspaceActivePath(ws = process.env.NEO_WORKSPACE || process.cwd()) {
  return path.join(workspaceNeoDir(ws), "active_conversation.json");
}

function workspaceChatJsonl(ws = process.env.NEO_WORKSPACE || process.cwd()) {
  return path.join(workspaceNeoDir(ws), "chat.jsonl");
}

function localConversationFile(id) {
  return path.join(localConversationsDir(), `${id}.json`);
}

function newConversationId() {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function readLocalConversation(id) {
  try {
    return JSON.parse(fs.readFileSync(localConversationFile(id), "utf8"));
  } catch {
    return null;
  }
}

export function writeLocalConversation(rec) {
  const dir = localConversationsDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = localConversationFile(rec.id);
  fs.writeFileSync(file, JSON.stringify(rec, null, 2) + "\n", "utf8");
  const ws = rec.workspace || process.env.NEO_WORKSPACE || process.cwd();
  fs.mkdirSync(workspaceNeoDir(ws), { recursive: true });
  fs.writeFileSync(
    workspaceActivePath(ws),
    JSON.stringify({ id: rec.id, updated_at: Date.now() / 1000 }, null, 2) + "\n",
    "utf8",
  );
  return rec;
}

export function appendWorkspaceChatJsonl(role, content, extra = {}, ws = process.env.NEO_WORKSPACE || process.cwd()) {
  try {
    fs.mkdirSync(workspaceNeoDir(ws), { recursive: true });
    const line = JSON.stringify({
      role,
      content,
      ...extra,
      ts: Date.now() / 1000,
    });
    fs.appendFileSync(workspaceChatJsonl(ws), line + "\n", "utf8");
  } catch {
    /* */
  }
}

export function chatMessagesToFeed(chat) {
  const items = [];
  for (const m of chat || []) {
    if (m.role === "user" && (m.content || "").trim()) {
      items.push({ role: "You", text: String(m.content).slice(0, 2000) });
    } else if (m.role === "assistant" && (m.content || "").trim()) {
      items.push({ role: "Neo", text: String(m.content).slice(0, 2000) });
    }
  }
  return items;
}

export function chatToAgentMessages(chat, mode, model) {
  const out = [];
  const sys = systemPrompt(mode, model);
  out.push({ role: "system", content: sys });
  for (const m of chat || []) {
    if (m.role === "system") continue;
    const item = { role: m.role, content: m.content || "" };
    if (m.tool_name) item.tool_name = m.tool_name;
    if (m.tool_calls) item.tool_calls = m.tool_calls;
    out.push(item);
  }
  if (out.length === 1) return out;
  return out;
}

export async function apiJson(method, pathName, body) {
  await ensureBrainDaemonSilent();
  const base = brainBaseUrl();
  const res = await fetch(`${base}${pathName}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const textBody = await res.text();
  let data;
  try {
    data = JSON.parse(textBody || "{}");
  } catch {
    data = { ok: false, error: textBody.slice(0, 200) };
  }
  if (!res.ok) throw new Error(data.error || `${method} ${pathName} ${res.status}`);
  return data;
}

export async function createConversation({ mode, model, workspace, title } = {}) {
  const ws = workspace || process.env.NEO_WORKSPACE || process.cwd();
  const payload = {
    mode: mode || "work",
    model: model || "neo-brain",
    workspace: ws,
    title,
  };
  try {
    if (!(await waitBrainApi(4_000))) throw new Error("brain api unavailable");
    const data = await apiJson("POST", "/v1/conversations", payload);
    const conv = data.conversation;
    if (conv?.id) {
      writeLocalConversation({
        id: conv.id,
        title: conv.title || title || "New chat",
        workspace: ws,
        mode: conv.mode || payload.mode,
        model: conv.model || payload.model,
        created_at: conv.created_at || Date.now() / 1000,
        updated_at: conv.updated_at || Date.now() / 1000,
        messages: [],
      });
    }
    return data;
  } catch {
    const id = newConversationId();
    const rec = writeLocalConversation({
      id,
      title: title || "New chat",
      workspace: ws,
      mode: payload.mode,
      model: payload.model,
      created_at: Date.now() / 1000,
      updated_at: Date.now() / 1000,
      messages: [],
    });
    return { ok: true, conversation: rec, local: true };
  }
}

export async function listConversations(limit = 30, workspace) {
  const qs = new URLSearchParams({ limit: String(limit) });
  if (workspace) qs.set("workspace", workspace);
  try {
    if (!(await waitBrainApi(2_500))) throw new Error("brain api unavailable");
    return await apiJson("GET", `/v1/conversations?${qs}`);
  } catch {
    const dir = localConversationsDir();
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      files = [];
    }
    const rows = [];
    for (const f of files) {
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        if (workspace && normalizeWorkspace(rec.workspace) !== normalizeWorkspace(workspace)) continue;
        rows.push(rec);
      } catch {
        /* */
      }
    }
    rows.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
    return { ok: true, conversations: rows.slice(0, limit), local: true };
  }
}

export async function loadConversation(id) {
  try {
    if (!(await waitBrainApi(2_500))) throw new Error("brain api unavailable");
    const data = await apiJson("GET", `/v1/conversations/${id}`);
    if (data.conversation) {
      writeLocalConversation({
        ...data.conversation,
        messages: data.messages || [],
      });
    }
    return data;
  } catch {
    const rec = readLocalConversation(id);
    if (!rec) throw new Error(`conversation not found: ${id}`);
    const messages = rec.messages || [];
    const chat = messages.map((m) => {
      const item = { role: m.role, content: m.content || "" };
      if (m.tool_name) item.tool_name = m.tool_name;
      if (m.tool_calls) item.tool_calls = m.tool_calls;
      return item;
    });
    return { ok: true, conversation: rec, messages, chat, local: true };
  }
}

export async function persistMessage(conversationId, role, content, extra = {}) {
  appendWorkspaceChatJsonl(role, content, { conversation_id: conversationId, ...extra });
  const local = readLocalConversation(conversationId) || {
    id: conversationId,
    title: "New chat",
    workspace: process.env.NEO_WORKSPACE || process.cwd(),
    mode: "work",
    model: "neo-brain",
    created_at: Date.now() / 1000,
    messages: [],
  };
  local.messages = local.messages || [];
  local.messages.push({
    id: `m_${Date.now().toString(36)}`,
    role,
    content,
    tool_name: extra.tool_name || null,
    tool_calls: extra.tool_calls || null,
    created_at: Date.now() / 1000,
  });
  local.updated_at = Date.now() / 1000;
  if (role === "user" && content && (!local.title || local.title === "New chat")) {
    local.title = String(content).trim().replace(/\n/g, " ").slice(0, 72);
  }
  writeLocalConversation(local);

  try {
    return await apiJson("POST", `/v1/conversations/${conversationId}/messages`, {
      role,
      content,
      ...extra,
    });
  } catch {
    return { ok: true, message: local.messages[local.messages.length - 1], local: true };
  }
}

/**
 * Resume last chat for this workspace, or create a new one.
 * Returns { conversationId, messages, feed, conversation, resumed }
 */
export async function openWorkspaceConversation({ mode, model, forceNew = false } = {}) {
  const ws = process.env.NEO_WORKSPACE || process.cwd();
  const activeModel = model || "neo-brain";
  const activeMode = mode || "work";

  if (!forceNew) {
    // Pointer in workspace .neo/
    try {
      const ptr = JSON.parse(fs.readFileSync(workspaceActivePath(ws), "utf8"));
      if (ptr?.id) {
        const data = await loadConversation(ptr.id);
        const chat = data.chat || [];
        const hasTurns = (data.messages || chat).some(
          (m) => m.role === "user" || m.role === "assistant",
        );
        if (hasTurns) {
          return {
            conversationId: data.conversation?.id || ptr.id,
            messages: chatToAgentMessages(chat, activeMode, activeModel),
            feed: chatMessagesToFeed(chat),
            conversation: data.conversation,
            resumed: true,
          };
        }
      }
    } catch {
      /* */
    }

    try {
      const listed = await listConversations(20, ws);
      const latest = listed.latest || (listed.conversations || [])[0];
      if (latest?.id) {
        const data = await loadConversation(latest.id);
        const chat = data.chat || [];
        const hasTurns = (data.messages || chat).some(
          (m) => m.role === "user" || m.role === "assistant",
        );
        if (hasTurns) {
          return {
            conversationId: data.conversation?.id || latest.id,
            messages: chatToAgentMessages(chat, activeMode, activeModel),
            feed: chatMessagesToFeed(chat),
            conversation: data.conversation || latest,
            resumed: true,
          };
        }
        return {
          conversationId: latest.id,
          messages: [{ role: "system", content: systemPrompt(activeMode, activeModel) }],
          feed: [],
          conversation: data.conversation || latest,
          resumed: false,
        };
      }
    } catch {
      /* */
    }
  }

  const created = await createConversation({ mode: activeMode, model: activeModel, workspace: ws });
  const conv = created.conversation;
  return {
    conversationId: conv?.id || null,
    messages: [{ role: "system", content: systemPrompt(activeMode, activeModel) }],
    feed: [],
    conversation: conv,
    resumed: false,
  };
}


export function startVoice(onLine, onStatus) {
  const ps1 = path.join(ROOT, "daemon", "voice_listen.ps1");
  const child = spawn(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  let buf = "";
  const handle = (chunk) => {
    buf += chunk.toString("utf8");
    const parts = buf.split(/\r?\n/);
    buf = parts.pop() || "";
    for (const line of parts) {
      const t = line.trim();
      if (!t) continue;
      if (t === "NEO_VOICE_READY") {
        onStatus?.("listening");
        continue;
      }
      if (t.startsWith("NEO_VOICE_ERROR:")) {
        onStatus?.("error:" + t.slice(16));
        continue;
      }
      onLine?.(t);
    }
  };
  child.stdout.on("data", handle);
  child.stderr.on("data", handle);
  child.on("exit", () => onStatus?.("off"));
  return () => {
    try {
      child.kill();
    } catch {
      /* */
    }
  };
}
