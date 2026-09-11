#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const comfyPy = path.resolve(root, "..", "ComfyUI", ".venv", "Scripts", "python.exe");
const py = fs.existsSync(comfyPy) ? comfyPy : "python";
const exec = path.join(root, "core", "executor.py");

const smokeDir = fs.mkdtempSync(path.join(os.tmpdir(), "neo-smoke-"));
process.env.NEO_WORKSPACE = smokeDir;

function call(tool, args = {}, expectOk = true) {
  const r = spawnSync(py, [exec, tool, JSON.stringify(args)], {
    encoding: "utf8",
    env: process.env,
    cwd: smokeDir,
  });
  let out;
  try {
    out = JSON.parse((r.stdout || "{}").trim() || "{}");
  } catch {
    throw new Error(`${tool}: bad json: ${(r.stdout || r.stderr || "").slice(0, 300)}`);
  }
  if (expectOk && !out.ok) throw new Error(`${tool}: ${out.error || r.stderr}`);
  if (!expectOk && out.ok) throw new Error(`${tool}: expected failure but ok`);
  console.log(expectOk ? "OK" : "FAIL_OK", tool);
  return out;
}

const cat = JSON.parse(fs.readFileSync(path.join(root, "core", "tools_catalog.json"), "utf8"));
if (cat.count < 1000) throw new Error("catalog < 1000");
console.log("catalog", cat.count);
console.log("workspace", smokeDir);

call("project_set_root", { path: smokeDir });
call("get_status");
call("search_tools", { query: "sqlite", limit: 5 });

call("fs_write", { path: "smoke.txt", content: "neo-smoke\n" });
call("fs_append", { path: "smoke.txt", content: "append\n" });
call("fs_read", { path: "smoke.txt" });
call("fs_edit_replace", { path: "smoke.txt", old: "append", new: "patched" });

// unique-match fail: two occurrences without all=true
call("fs_write", { path: "dup.txt", content: "aaa\nbbb\naaa\n" });
call("fs_edit_replace", { path: "dup.txt", old: "aaa", new: "zzz" }, false);

// chunked long write >50KB
const chunkSize = 8000;
const totalChunks = 8;
let assembled = "";
for (let i = 0; i < totalChunks; i++) {
  const chunk = (`CHUNK${i}:` + "x".repeat(chunkSize - 10) + "\n").slice(0, chunkSize);
  assembled += chunk;
  const r = call("fs_write_chunk", {
    path: "long.txt",
    content: chunk,
    chunk_index: i,
    total: totalChunks,
  });
  if (!r.data || r.data.bytes < (i + 1) * 1000) throw new Error("chunk bytes too small");
}
const longPath = path.join(smokeDir, "long.txt");
const longStat = fs.statSync(longPath);
if (longStat.size < 50_000) throw new Error(`long.txt too small: ${longStat.size}`);
console.log("OK long_file", longStat.size);

// begin/finalize session
const begin = call("fs_write_begin", { path: "session.bin", total: 2 });
const wid = begin.data.write_id;
call("fs_write_chunk", { write_id: wid, content: "hello-", chunk_index: 0, total: 2 });
call("fs_write_chunk", { write_id: wid, content: "world", chunk_index: 1, total: 2, finalize: true });
if (!fs.readFileSync(path.join(smokeDir, "session.bin"), "utf8").includes("hello-world")) {
  throw new Error("session write mismatch");
}

// apply_patch multi-edit
call("fs_write", { path: "a.js", content: "const x = 1;\nconst y = 2;\n" });
call("fs_write", { path: "b.js", content: "export const z = 3;\n" });
call("apply_patch", {
  edits: [
    { path: "a.js", old: "const x = 1;", new: "const x = 10;" },
    { path: "b.js", old: "export const z = 3;", new: "export const z = 30;" },
  ],
});
if (!fs.readFileSync(path.join(smokeDir, "a.js"), "utf8").includes("10")) throw new Error("patch a failed");
if (!fs.readFileSync(path.join(smokeDir, "b.js"), "utf8").includes("30")) throw new Error("patch b failed");

// sqlite
call("db_sqlite_exec", {
  path: "app.db",
  sql: "CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items(name) VALUES ('neo');",
});
const q = call("db_sqlite_query", { path: "app.db", sql: "SELECT name FROM items" });
if (!q.data?.rows?.some((r) => r.name === "neo")) throw new Error("sqlite query miss");
call("db_sqlite_tables", { path: "app.db" });
call("db_sqlite_schema", { path: "app.db", table: "items" });

// todos + project_map
call("todo_set", { items: ["chunk writes", "sqlite", "patch"] });
const todos = call("todo_list");
if (!todos.data?.items?.length) throw new Error("todos empty");
call("todo_done", { id: "1" });
call("memory_set", { key: "smoke", value: true });
call("memory_get", { key: "smoke" });
const map = call("project_map", { path: ".", depth: 3, limit: 50 });
if (!map.data?.count) throw new Error("project_map empty");

call("code_scaffold_html", { path: "ui-smoke.html", title: "Neo Smoke" });
call("code_scaffold_sql_schema", { path: "schema.sql", table: "widgets" });
call("set_mode", { mode: "plan" });
call("set_mode", { mode: "work" });
call("model_capabilities", {});

console.log("\nSMOKE PASS");
console.log("dir", smokeDir);
