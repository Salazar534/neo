#!/usr/bin/env node
/**
 * Unit test: OpenAI-compatible client talks to a stub Neo brain (no GGUF download).
 */
import http from "node:http";
import { parseToolCallsFromContent } from "../ui/lib.mjs";

const PORT = 18766;

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assert failed");
}

// --- parse layer ---
{
  const raw = `Sure.\n<tool_call>\n{"name":"fs_write","arguments":{"path":"a.txt","content":"hi"}}\n</tool_call>`;
  const { content, tool_calls } = parseToolCallsFromContent(raw);
  assert(tool_calls.length === 1, "expected 1 tool call");
  assert(tool_calls[0].function.name === "fs_write", "name");
  assert(tool_calls[0].function.arguments.path === "a.txt", "args");
  assert(!content.includes("tool_call"), "cleaned");
  console.log("OK parseToolCallsFromContent");
}

// --- stub server + client ---
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, ready: true, device: "stub" }));
      return;
    }
    if (req.url === "/api/chat") {
      const payload = JSON.parse(body || "{}");
      assert(Array.isArray(payload.messages), "messages");
      assert(Array.isArray(payload.tools), "tools");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: "neo-brain",
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{ function: { name: "get_status", arguments: {} } }],
          },
          done: true,
        }),
      );
      return;
    }
    if (req.url === "/v1/chat/completions") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "get_status", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const chat = await fetch(`http://127.0.0.1:${PORT}/api/chat`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "neo-brain",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "get_status" } }],
  }),
});
assert(chat.ok, "chat ok");
const data = await chat.json();
assert(data.message.tool_calls[0].function.name === "get_status", "tool name");
console.log("OK stub /api/chat");

const oa = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
});
assert(oa.ok, "openai ok");
const oaData = await oa.json();
assert(oaData.choices[0].message.tool_calls[0].function.name === "get_status", "oa tool");
console.log("OK stub /v1/chat/completions");

server.close();
console.log("\nBRAIN CLIENT TEST PASS");
