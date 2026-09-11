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
export const OLLAMA = (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/$/, "");

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

/** Silent: start image daemon only if health check fails. No chatter. */
export function ensureImageDaemonSilent() {
  try {
    const r = spawnSync(
      process.execPath,
      [
        "-e",
        "fetch('http://127.0.0.1:8765/health').then(r=>r.json()).then(j=>{if(!j.ready)process.exit(2)}).catch(()=>process.exit(1))",
      ],
      { encoding: "utf8", windowsHide: true, timeout: 2500 },
    );
    if (r.status === 0) return true;
  } catch {
    /* start */
  }
  const child = spawn(PY, [path.join(ROOT, "daemon", "image_daemon.py")], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return false;
}

/** Start Neo brain daemon if not healthy. */
export function ensureBrainDaemonSilent() {
  if (process.env.NEO_USE_OLLAMA === "1") return false;
  const base = brainBaseUrl();
  try {
    const r = spawnSync(
      process.execPath,
      [
        "-e",
        `fetch('${base}/health').then(r=>r.json()).then(j=>{if(!j.ready)process.exit(2)}).catch(()=>process.exit(1))`,
      ],
      { encoding: "utf8", windowsHide: true, timeout: 3000 },
    );
    if (r.status === 0) return true;
  } catch {
    /* start */
  }
  const py = resolvePython();
  const script = path.join(PACKAGE_ROOT, "daemon", "brain_daemon.py");
  const child = spawn(py, [script], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env },
  });
  child.unref();
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
  return `You are NEO on Windows. MODE=${mode}. model=${model}.
Runtime: Neo local brain (GGUF via llama.cpp). Ollama is optional fallback only.
Use tools. search_tools then call_tool when needed.
plan = text only. code/work = write files and run tools.
Never invent fake prompts like "Provide the URL:". If you need a file, write it with fs_write or chunked writes.
For Apps Script / code requests: write the full script to a .gs or .js file in the workspace, then tell the user the path in one short line.
Replies: short. No fluff.
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

function openaiToOllamaMessage(msg) {
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
  ensureBrainDaemonSilent();
  await waitBrainReady();
  const temp = mode === "plan" ? 0.5 : mode === "code" ? 0.2 : 0.35;
  const base = brainBaseUrl();
  // Prefer Ollama-shaped /api/chat on our daemon (same client shape)
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: model || "neo-brain",
      messages,
      tools: META_TOOLS,
      stream: false,
      options: { temperature: temp, num_ctx: 8192 },
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
        max_tokens: 2048,
      }),
    });
    if (!res2.ok) throw new Error(`neo-brain ${res2.status}: ${(await res2.text()).slice(0, 220)}`);
    const data = await res2.json();
    const msg = data.choices?.[0]?.message || {};
    return { model, message: openaiToOllamaMessage(msg), done: true };
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

export async function ollamaChat(messages, model, mode) {
  const temp = mode === "plan" ? 0.5 : mode === "code" ? 0.2 : 0.35;
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      tools: META_TOOLS,
      stream: false,
      options: { temperature: temp, num_ctx: 8192 },
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 180)}`);
  return res.json();
}

/**
 * Primary chat: Neo local brain. Optional Ollama if NEO_USE_OLLAMA=1.
 */
export async function neoChat(messages, model, mode) {
  if (process.env.NEO_USE_OLLAMA === "1") {
    return ollamaChat(messages, model, mode);
  }
  try {
    return await neoBrainChat(messages, model, mode);
  } catch (e) {
    const msg = String(e.message || e);
    // Soft fallback only if user has Ollama up and brain missing
    if (/neo install|No GGUF|llama-cpp/i.test(msg)) throw e;
    try {
      const probe = await fetch(`${OLLAMA}/api/tags`);
      if (probe.ok) {
        console.error("[neo] brain failed; falling back to Ollama (set NEO_USE_OLLAMA=1 to force)");
        return ollamaChat(messages, model, mode);
      }
    } catch {
      /* */
    }
    throw e;
  }
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
