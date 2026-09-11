#!/usr/bin/env node
/**
 * Smoke: conversation save + load (local file helpers + optional live API).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const smokeWs = fs.mkdtempSync(path.join(os.tmpdir(), "neo-chat-"));
process.env.NEO_WORKSPACE = smokeWs;
process.env.NEO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "neo-home-"));
process.env.NEO_CHAT_LOCAL = "1";
process.env.NEO_USE_OLLAMA = "1"; // skip brain spawn during unit smoke

const {
  modeName,
  modePromptLabel,
  modesHintLine,
  createConversation,
  persistMessage,
  loadConversation,
  openWorkspaceConversation,
  chatMessagesToFeed,
  writeLocalConversation,
  readLocalConversation,
} = await import("../ui/lib.mjs");

assert.equal(modeName("code"), "Neo Code");
assert.equal(modeName("plan"), "Neo Plan");
assert.equal(modeName("work"), "Neo Work");
assert.equal(modePromptLabel("code"), "Neo Code ›");
assert.match(modesHintLine(), /Neo Plan/);
console.log("OK branding labels");

const localId = "c_smoke_local";
writeLocalConversation({
  id: localId,
  title: "smoke",
  workspace: smokeWs,
  mode: "code",
  model: "neo-brain",
  created_at: Date.now() / 1000,
  updated_at: Date.now() / 1000,
  messages: [
    { role: "user", content: "build a todo app", created_at: Date.now() / 1000 },
    { role: "assistant", content: "I'll scaffold a todo list.", created_at: Date.now() / 1000 },
  ],
});
const roundtrip = readLocalConversation(localId);
assert.equal(roundtrip.messages.length, 2);
const feed = chatMessagesToFeed(roundtrip.messages);
assert.equal(feed[0].role, "You");
assert.equal(feed[1].role, "Neo");
console.log("OK local conversation roundtrip");

const created = await createConversation({ mode: "code", model: "neo-brain", workspace: smokeWs });
assert.ok(created.conversation?.id, "createConversation must return id");
const cid = created.conversation.id;
await persistMessage(cid, "user", "Neo help me build a simple to do list app");
await persistMessage(cid, "assistant", "Sure — I'll create the files in this workspace.");
const loaded = await loadConversation(cid);
assert.ok((loaded.messages || []).length >= 2, "loaded messages");
const labels = chatMessagesToFeed(loaded.chat || loaded.messages);
assert.ok(labels.some((x) => x.role === "You"));
assert.ok(labels.some((x) => x.role === "Neo"));
console.log("OK persist+load", cid, created.local ? "(local fallback)" : "(api)");

const resumed = await openWorkspaceConversation({ mode: "code", model: "neo-brain" });
assert.equal(resumed.conversationId, cid);
assert.ok(resumed.resumed, "should resume workspace chat");
assert.ok(resumed.feed.length >= 2, "feed restored");
console.log("OK openWorkspaceConversation resume");

const neoDir = path.join(smokeWs, ".neo");
assert.ok(fs.existsSync(path.join(neoDir, "active_conversation.json")));
assert.ok(fs.existsSync(path.join(neoDir, "chat.jsonl")));
console.log("OK workspace .neo pointers");

console.log("\nCHAT PERSISTENCE PASS");
console.log("workspace", smokeWs);
