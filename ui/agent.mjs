/**
 * Shared Neo agent turn: plan → act → verify tool loop.
 */
import {
  META_TOOLS,
  neoChat,
  pyExec,
  systemPrompt,
  ensureBrainDaemonSilent,
  createConversation,
  persistMessage,
} from "./lib.mjs";

const HOP_BUDGET_DEFAULT = 48;
const HOP_BUDGET_PLAN = 72;
const TOOL_RESULT_MAX = 24000;
const HISTORY_COMPACT_AFTER = 28;
const COMPACT_TOOL_MAX = 2500;

function truncateResult(obj) {
  let s = typeof obj === "string" ? obj : JSON.stringify(obj);
  if (s.length <= TOOL_RESULT_MAX) return s;
  return s.slice(0, TOOL_RESULT_MAX) + `…[truncated ${s.length - TOOL_RESULT_MAX} chars]`;
}

function compactHistory(messages) {
  if (messages.length < HISTORY_COMPACT_AFTER) return;
  const keepTail = 20;
  const head = messages[0];
  const mid = messages.slice(1, -keepTail);
  const tail = messages.slice(-keepTail);
  for (const m of mid) {
    if (m?.role === "tool" && typeof m.content === "string" && m.content.length > COMPACT_TOOL_MAX) {
      m.content = m.content.slice(0, COMPACT_TOOL_MAX) + "…[compacted]";
    }
  }
  messages.length = 0;
  messages.push(head, ...mid, ...tail);
}

function noteFromResult(name, result) {
  if (!result) return null;
  if (!result.ok) return `${name}: ${result.error || "fail"}`;
  const d = result.data;
  if (!d) return null;
  if (typeof d === "object") {
    if (d.path) return String(d.path) + (d.bytes != null ? ` (${d.bytes}b)` : "");
    if (d.url) return String(d.url);
    if (d.hits) return `hits: ${d.count ?? d.hits.length}`;
    if (d.files && Array.isArray(d.files) && d.applied != null) return `patched ${d.applied} file(s)`;
    if (d.items && d.pending != null) return `todos: ${d.pending} pending`;
    if (d.count != null && d.files) return `map: ${d.count} files`;
    if (d.rows) return `rows: ${d.count ?? d.rows.length}`;
    if (d.complete && d.path) return String(d.path);
  }
  return null;
}

export async function runAgentTurn({
  messages,
  mode,
  model,
  userText,
  conversationId,
  onNote,
  onBusy,
  onReply,
}) {
  await ensureBrainDaemonSilent();
  messages[0] = { role: "system", content: systemPrompt(mode, model) };
  messages.push({ role: "user", content: userText });

  let cid = conversationId;
  if (!cid) {
    try {
      const created = await createConversation({ mode, model });
      cid = created.conversation?.id;
    } catch {
      /* persistence optional if daemon loading */
    }
  }
  if (cid) {
    try {
      await persistMessage(cid, "user", userText);
    } catch {
      /* */
    }
  }

  const hopBudget = mode === "plan" ? HOP_BUDGET_PLAN : HOP_BUDGET_DEFAULT;

  for (let hop = 0; hop < hopBudget; hop++) {
    onBusy?.(hop === 0 ? "…" : `hop ${hop}`);
    compactHistory(messages);
    let data;
    try {
      data = await neoChat(messages, model, mode);
    } catch (e) {
      onNote?.(String(e.message || e));
      break;
    }
    const msg = data.message || {};
    messages.push(msg);
    if (cid) {
      try {
        await persistMessage(cid, "assistant", msg.content || "", {
          tool_calls: msg.tool_calls || null,
        });
      } catch {
        /* */
      }
    }
    const calls = msg.tool_calls || [];
    if (!calls.length) {
      const content = (msg.content || "").trim();
      if (content) onReply?.(content);
      break;
    }
    for (const call of calls) {
      let args = {};
      try {
        args =
          typeof call.function?.arguments === "string"
            ? JSON.parse(call.function.arguments || "{}")
            : call.function?.arguments || {};
      } catch {
        args = {};
      }
      const name = call.function?.name || "tool";
      if (name !== "set_mode" && name !== "search_tools" && name !== "get_status") {
        onBusy?.(name);
      }
      const result = pyExec(name, args);
      const note = noteFromResult(name, result);
      if (note) onNote?.(note);
      else if (name !== "set_mode" && name !== "search_tools" && name !== "get_status" && !result?.ok) {
        onNote?.(`${name}: ${result?.error || "fail"}`);
      }
      const toolContent = truncateResult(result);
      messages.push({
        role: "tool",
        tool_name: name,
        content: toolContent,
      });
      if (cid) {
        try {
          await persistMessage(cid, "tool", toolContent, { tool_name: name });
        } catch {
          /* */
        }
      }
    }
  }
  onBusy?.("");
  return { conversationId: cid };
}

export { HOP_BUDGET_DEFAULT as HOP_BUDGET, META_TOOLS };
