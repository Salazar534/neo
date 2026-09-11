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
  pyExec,
  readState,
  startVoice,
  systemPrompt,
  writeState,
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
  console.log(M("  1 plan"));
  console.log(M("  2 code"));
  console.log(M("  3 work\n"));
  for (;;) {
    const ans = (await rl.question(M("  › "))).trim().toLowerCase();
    const map = { 1: "plan", 2: "code", 3: "work", plan: "plan", code: "code", work: "work" };
    if (map[ans]) return map[ans];
  }
}

function header(mode, model, voice, daemon) {
  const ws = process.env.NEO_WORKSPACE || process.cwd();
  console.log(L("╭──────────────────────────────────────╮"));
  console.log(
    L("│ ") +
      A.bold("NEO") +
      "  " +
      A(mode.toUpperCase()) +
      M(`  ${model}`) +
      M(voice === "listening" ? "  mic" : "") +
      M(daemon ? "  img" : "") +
      L(" │"),
  );
  console.log(L("╰──────────────────────────────────────╯"));
  console.log(M(`  ${ws}`));
  console.log(M("  modes: /plan  /code  /work\n"));
}

async function main() {
  ensureCatalog();
  ensureImageDaemonSilent();
  ensureBrainDaemonSilent();
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

  console.clear();
  header(mode, model, "off", daemon);

  const messages = [{ role: "system", content: systemPrompt(mode, model) }];
  let voiceStop = null;
  let voiceState = "off";
  let locked = false;

  const you = (t) => console.log(A.bold("you") + "  " + I(t));
  const neo = (t) => console.log(G.bold("neo") + "  " + I(t));
  const note = (t) => console.log(M("·  " + t));

  const runAgent = async (userText) => {
    if (locked) return;
    locked = true;
    you(userText);
    const st = readState();
    mode = st.mode || mode;
    model = st.text_model || model;
    try {
      await runAgentTurn({
        messages,
        mode,
        model,
        userText,
        onNote: note,
        onBusy: () => {},
        onReply: neo,
      });
    } catch (e) {
      note(String(e.message || e));
    } finally {
      locked = false;
    }
  };

  for (;;) {
    let line;
    try {
      line = (await rl.question(A(`${mode.toUpperCase()} › `))).trim();
    } catch {
      if (!input.isTTY || input.readableEnded || input.destroyed) break;
      continue;
    }
    if (!line) continue;

    try {
      if (line === "/quit" || line === "/exit") break;
      if (line === "/plan" || line === "/code" || line === "/work") {
        mode = line.slice(1);
        pyExec("set_mode", { mode });
        writeState({ ...readState(), mode });
        console.clear();
        header(mode, model, voiceState, daemon);
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
