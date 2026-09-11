#!/usr/bin/env node
/**
 * Stub/API tests for Neo SQLite store + conversation endpoints (no GGUF required).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseToolCallsFromContent } from "../ui/lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 18767;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "neo-api-"));
const dbPath = path.join(tmpHome, "neo.db");

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assert failed");
}

// --- client parse ---
{
  const raw = `<tool_call>\n{"name":"pc_create","arguments":{"path":"NeoTest","scope":"desktop","directory":true}}\n</tool_call>`;
  const { tool_calls } = parseToolCallsFromContent(raw);
  assert(tool_calls[0].function.name === "pc_create", "pc_create parse");
  console.log("OK parse pc_create");
}

// --- Python store unit (stdlib sqlite) ---
const storeScript = `
import sys, json, os
sys.path.insert(0, r${JSON.stringify(path.join(root, "daemon"))})
os.environ["NEO_HOME"] = r${JSON.stringify(tmpHome)}
from neo_store import NeoStore
s = NeoStore(r${JSON.stringify(dbPath)})
c = s.create_conversation(title="t", workspace=r${JSON.stringify(tmpHome)}, mode="work")
s.add_message(c["id"], "user", "hello neo")
s.add_message(c["id"], "assistant", "hi")
msgs = s.list_messages(c["id"])
assert len(msgs) == 2, msgs
s.memory_set("k", {"v": 1})
assert s.memory_get("k")["v"] == 1
print(json.dumps({"ok": True, "id": c["id"], "n": len(msgs)}))
`;

const py = process.platform === "win32" ? "python" : "python3";
const { spawnSync } = await import("node:child_process");
const storeRun = spawnSync(py, ["-c", storeScript], { encoding: "utf8", windowsHide: true });
if (storeRun.status !== 0) {
  console.error(storeRun.stderr || storeRun.stdout);
  process.exit(1);
}
const storeOut = JSON.parse((storeRun.stdout || "").trim().split(/\r?\n/).pop());
assert(storeOut.ok, "store ok");
console.log("OK neo_store", storeOut.id);

// --- HTTP API with stub LLM (import handler pieces via mini server) ---
const apiScript = `
import sys, json, os, threading, time
from http.server import ThreadingHTTPServer
sys.path.insert(0, r${JSON.stringify(path.join(root, "daemon"))})
os.environ["NEO_HOME"] = r${JSON.stringify(tmpHome)}
os.environ["NEO_BRAIN_PORT"] = "${PORT}"

import brain_daemon as bd
from neo_store import NeoStore

bd.STORE = NeoStore(r${JSON.stringify(dbPath)})
bd.READY = True
bd.LOAD_ERROR = None
bd.MODEL_ID = "neo-brain"
bd.DEVICE = "stub"

def fake_chat(payload):
    return {
        "id": "chatcmpl-test",
        "object": "chat.completion",
        "created": 0,
        "model": "neo-brain",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": "pong"}, "finish_reason": "stop"}],
        "usage": {},
    }
bd.chat_completion = fake_chat
bd.LLM = object()  # truthy

httpd = ThreadingHTTPServer(("127.0.0.1", ${PORT}), bd.Handler)
t = threading.Thread(target=httpd.serve_forever, daemon=True)
t.start()
print("READY", flush=True)
while True:
    time.sleep(1)
`;

const child = spawn(py, ["-c", apiScript], {
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
  env: { ...process.env, NEO_HOME: tmpHome },
});

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("api stub timeout")), 15000);
  child.stdout.on("data", (buf) => {
    if (String(buf).includes("READY")) {
      clearTimeout(timer);
      resolve();
    }
  });
  child.stderr.on("data", (buf) => {
    const s = String(buf);
    if (/Error|Traceback/i.test(s)) console.error(s);
  });
  child.on("exit", (code) => reject(new Error(`api stub exited ${code}`)));
});

const base = `http://127.0.0.1:${PORT}`;

const health = await (await fetch(`${base}/v1/health`)).json();
assert(health.ok && health.ready, "health");
console.log("OK /v1/health");

const models = await (await fetch(`${base}/v1/models`)).json();
assert(models.data?.[0]?.id === "neo-brain", "models");
console.log("OK /v1/models");

const created = await (
  await fetch(`${base}/v1/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "api-test", mode: "work" }),
  })
).json();
assert(created.ok && created.conversation?.id, "create conv");
const cid = created.conversation.id;

await fetch(`${base}/v1/conversations/${cid}/messages`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ role: "user", content: "ping" }),
});

const chat = await (
  await fetch(`${base}/v1/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversation_id: cid, message: "ping2" }),
  })
).json();
assert(chat.ok && chat.completion?.choices?.[0]?.message?.content === "pong", "v1/chat");
console.log("OK /v1/chat");

const listed = await (await fetch(`${base}/v1/conversations`)).json();
assert((listed.conversations || []).some((c) => c.id === cid), "list");
console.log("OK conversations CRUD");

const oa = await (
  await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }),
  })
).json();
assert(oa.choices?.[0]?.message?.content === "pong", "completions");
console.log("OK /v1/chat/completions");

child.kill();
try {
  fs.rmSync(tmpHome, { recursive: true, force: true });
} catch {
  /* */
}

console.log("\nAPI TEST PASS");
