/**
 * Persistent Neo shell — stays open until /quit.
 */
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import chalk from "chalk";
import { runAgentTurn } from "./agent.mjs";
import {
  ensureBrainDaemonSilent,
  ensureCatalog,
  ensureImageDaemonSilent,
  modeName,
  modePromptLabel,
  modesHintLine,
  openWorkspaceConversation,
  pyExec,
  readState,
  startVoice,
  systemPrompt,
  writeState,
  listConversations,
  loadConversation,
  chatToAgentMessages,
  chatMessagesToFeed,
} from "./lib.mjs";

const A = chalk.hex("#F0A86A");
const G = chalk.hex("#8FBF9F");
const M = chalk.hex("#9a816a");
const I = chalk.hex("#f7efe4");
const B = chalk.hex("#E07A5F");
const L = chalk.hex("#3d2e22");

if (!process.env.NEO_WORKSPACE) process.env.NEO_WORKSPACE = process.cwd();

async function pickMode(rl) {
  console.clear();
  console.log(A.bold("\n  NEO\n"));
  console.log(M("  1  Neo Plan"));
  console.log(M("  2  Neo Code"));
  console.log(M("  3  Neo Work\n"));
  for (;;) {
    const ans = (await rl.question(M("  › "))).trim().toLowerCase();
    const map = {
      1: "plan",
      2: "code",
      3: "work",
      plan: "plan",
      code: "code",
      work: "work",
      "neo plan": "plan",
      "neo code": "code",
      "neo work": "work",
    };
    if (map[ans]) return map[ans];
  }
}

function header(mode, model, voice, daemon, convId) {
  const ws = process.env.NEO_WORKSPACE || process.cwd();
  console.log(L("╭──────────────────────────────────────╮"));
  console.log(
    L("│ ") +
      A.bold("NEO") +
      "  " +
      A(modeName(mode)) +
      M(`  ${model}`) +
      M(voice === "listening" ? "  mic" : "") +
      M(daemon ? "  img" : "") +
      L(" │"),
  );
  console.log(L("╰──────────────────────────────────────╯"));
  console.log(M(`  ${ws}`));
  if (convId) console.log(M(`  chat ${convId}`));
  console.log(M(`  ${modesHintLine()}`));
  console.log(M("  /new /history /resume <id>  ·  /quit\n"));
}

function printFeed(feed) {
  for (const item of feed || []) {
    if (item.role === "You") console.log(A.bold("You") + "  " + I(item.text));
    else if (item.role === "Neo") console.log(G.bold("Neo") + "  " + I(item.text));
  }
}

async function main() {
  ensureCatalog();
  await ensureImageDaemonSilent();
  await ensureBrainDaemonSilent();
  writeState({ ...readState(), mode: null });

  const rl = readline.createInterface({ input, output, terminal: !!input.isTTY });
  let mode = await pickMode(rl);
  pyExec("set_mode", { mode });
  pyExec("project_set_root", { path: process.env.NEO_WORKSPACE || process.cwd() });
  let model = readState().text_model || "neo-brain";
  writeState({ ...readState(), mode, text_model: model });

  let daemon = false;
  try {
    daemon = !!(await (await fetch("http://127.0.0.1:8765/health")).json()).ready;
  } catch {
    /* */
  }

  let session = await openWorkspaceConversation({ mode, model });
  let conversationId = session.conversationId;
  let messages = session.messages;

  console.clear();
  header(mode, model, "off", daemon, conversationId);
  if (session.resumed && session.feed?.length) {
    printFeed(session.feed);
    console.log(M(`  · resumed ${conversationId} (${session.feed.length} turns)\n`));
  }

  let voiceStop = null;
  let voiceState = "off";
  let locked = false;

  const you = (t) => console.log(A.bold("You") + "  " + I(t));
  const neo = (t) => console.log(G.bold("Neo") + "  " + I(t));
  const note = (t) => console.log(M("·  " + t));

  const startNewChat = async () => {
    session = await openWorkspaceConversation({ mode, model, forceNew: true });
    conversationId = session.conversationId;
    messages = session.messages;
    note(`new chat ${conversationId || "(local)"}`);
  };

  const resumeChat = async (id) => {
    const data = await loadConversation(id);
    conversationId = data.conversation?.id || id;
    const chat = data.chat || [];
    messages = chatToAgentMessages(chat, mode, model);
    const feed = chatMessagesToFeed(chat);
    printFeed(feed);
    note(`resumed ${conversationId} (${feed.length} turns)`);
  };

  const runAgent = async (userText) => {
    if (locked) return;
    locked = true;
    you(userText);
    const st = readState();
    mode = st.mode || mode;
    model = st.text_model || model;
    try {
      const out = await runAgentTurn({
        messages,
        mode,
        model,
        userText,
        conversationId,
        onNote: note,
        onBusy: () => {},
        onReply: neo,
      });
      if (out?.conversationId) conversationId = out.conversationId;
    } catch (e) {
      note(String(e.message || e));
    } finally {
      locked = false;
    }
  };

  for (;;) {
    let line;
    try {
      line = (await rl.question(A(`${modePromptLabel(mode)} `))).trim();
    } catch {
      if (!input.isTTY || input.readableEnded || input.destroyed) break;
      continue;
    }
    if (!line) continue;

    try {
      if (line === "/quit" || line === "/exit") break;
      if (line === "/new") {
        await startNewChat();
        continue;
      }
      if (line === "/history") {
        try {
          const data = await listConversations(20, process.env.NEO_WORKSPACE || process.cwd());
          const rows = data.conversations || [];
          if (!rows.length) note("no saved chats");
          for (const c of rows) {
            const title = (c.title || "chat").slice(0, 48);
            const mark = c.id === conversationId ? "*" : " ";
            note(`${mark} ${c.id}  ${title}`);
          }
        } catch (e) {
          note(String(e.message || e));
        }
        continue;
      }
      if (line.startsWith("/resume ")) {
        try {
          await resumeChat(line.slice(8).trim());
        } catch (e) {
          note(String(e.message || e));
        }
        continue;
      }
      if (line === "/plan" || line === "/code" || line === "/work") {
        mode = line.slice(1);
        pyExec("set_mode", { mode });
        writeState({ ...readState(), mode });
        messages[0] = { role: "system", content: systemPrompt(mode, model) };
        console.clear();
        header(mode, model, voiceState, daemon, conversationId);
        continue;
      }
      if (line === "/voice") {
        if (voiceStop) {
          voiceStop();
          voiceStop = null;
          voiceState = "off";
          continue;
        }
        voiceStop = startVoice(
          (t) => {
            if (!locked) void runAgent(t);
          },
          (s) => {
            voiceState = s;
          },
        );
        continue;
      }
      if (line.startsWith("/tools ")) {
        const r = pyExec("search_tools", { query: line.slice(7), limit: 12 });
        note((r.data || []).map((t) => t.name).join("  ") || "none");
        continue;
      }
      if (line.startsWith("/img ")) {
        const r = pyExec("image_generate", { prompt: line.slice(5) });
        if (r.ok) note(String(r.data?.path));
        else note(r.error || "fail");
        continue;
      }
      if (line.startsWith("/model ")) {
        model = line.slice(7).trim();
        writeState({ ...readState(), text_model: model });
        pyExec("model_switch_text", { model });
        continue;
      }
      await runAgent(line);
    } catch (e) {
      note(String(e.message || e));
      locked = false;
    }
  }

  voiceStop?.();
  rl.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(B(String(e.message || e)));
  process.exit(1);
});
