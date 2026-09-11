import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, render } from "ink";
import SelectInput from "ink-select-input";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
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

if (!process.env.NEO_WORKSPACE) process.env.NEO_WORKSPACE = process.cwd();

const C = {
  card: "#1a1410",
  border: "#3d2e22",
  accent: "#F0A86A",
  ink: "#f7efe4",
  mute: "#9a816a",
  good: "#8FBF9F",
  bad: "#E07A5F",
};

const h = React.createElement;

function Badge({ label, tone = "accent" }) {
  const color = tone === "good" ? C.good : tone === "bad" ? C.bad : tone === "mute" ? C.mute : C.accent;
  return h(Text, { backgroundColor: C.card, color, bold: true }, ` ${label} `);
}

function ModePicker({ onPick }) {
  const items = [
    { label: "Neo Plan", value: "plan" },
    { label: "Neo Code", value: "code" },
    { label: "Neo Work", value: "work" },
  ];
  return h(
    Box,
    { flexDirection: "column", paddingX: 1, paddingY: 1 },
    h(Text, { bold: true, color: C.accent }, "NEO"),
    h(Text, { color: C.mute }, "choose a mode"),
    h(Box, { marginTop: 1 }, h(SelectInput, {
      items,
      onSelect: (item) => onPick(item.value),
      indicatorComponent: ({ isSelected }) =>
        h(Text, { color: C.accent }, isSelected ? "▸ " : "  "),
      itemComponent: ({ isSelected, label }) =>
        h(Text, { color: isSelected ? C.ink : C.mute, bold: isSelected }, label),
    })),
  );
}

function Header({ mode, model, voice, busy, daemon, convId }) {
  return h(
    Box,
    {
      borderStyle: "round",
      borderColor: C.border,
      paddingX: 1,
      marginBottom: 1,
      flexDirection: "column",
    },
    h(
      Box,
      { alignItems: "center" },
      h(Text, { bold: true, color: C.accent }, "NEO"),
      h(Text, {}, " "),
      h(Badge, { label: modeName(mode) }),
      h(Text, {}, " "),
      h(Badge, { label: model, tone: "mute" }),
      h(Text, {}, " "),
      h(Badge, {
        label: voice === "listening" ? "mic" : "mic off",
        tone: voice === "listening" ? "good" : "mute",
      }),
      h(Text, {}, " "),
      h(Badge, { label: daemon ? "img" : "img…", tone: daemon ? "good" : "mute" }),
      busy
        ? h(
            Box,
            { marginLeft: 1 },
            h(Text, { color: C.accent }, h(Spinner, { type: "dots" })),
          )
        : null,
    ),
    h(Text, { color: C.mute }, process.env.NEO_WORKSPACE || process.cwd()),
    convId ? h(Text, { color: C.mute }, `chat ${convId}`) : null,
    h(Text, { color: C.mute }, modesHintLine()),
    h(Text, { color: C.mute }, "/new /history /resume <id>  ·  /quit"),
  );
}

function Feed({ items }) {
  const shown = items.filter((m) => m.role !== "sys" || m.important).slice(-14);
  return h(
    Box,
    {
      flexDirection: "column",
      borderStyle: "round",
      borderColor: C.border,
      paddingX: 1,
      marginBottom: 1,
      minHeight: 10,
    },
    shown.length === 0
      ? h(Text, { color: C.mute }, "…")
      : shown.map((m, i) =>
          h(
            Text,
            { key: String(i) },
            h(
              Text,
              {
                bold: true,
                color:
                  m.role === "You" || m.role === "you"
                    ? C.accent
                    : m.role === "Neo" || m.role === "neo"
                      ? C.good
                      : C.mute,
              },
              m.role === "sys" ? "·" : m.role === "you" ? "You" : m.role === "neo" ? "Neo" : m.role,
            ),
            h(Text, { color: C.mute }, "  "),
            h(Text, { color: C.ink }, m.text),
          ),
        ),
  );
}

function Composer({ value, onChange, onSubmit, mode, voicePartial }) {
  return h(
    Box,
    { borderStyle: "round", borderColor: C.accent, paddingX: 1, flexDirection: "column" },
    voicePartial ? h(Text, { color: C.mute }, voicePartial) : null,
    h(
      Box,
      {},
      h(Text, { bold: true, color: C.accent }, modePromptLabel(mode)),
      h(Text, { color: C.mute }, " "),
      h(TextInput, { value, onChange, onSubmit, placeholder: "", focus: true }),
    ),
  );
}

function App() {
  const { exit } = useApp();
  const [booted, setBooted] = useState(false);
  const [mode, setMode] = useState(null);
  const [model, setModel] = useState("neo-brain");
  const [feed, setFeed] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState("");
  const [voice, setVoice] = useState("off");
  const [voicePartial, setVoicePartial] = useState("");
  const [daemon, setDaemon] = useState(false);
  const [conversationId, setConversationId] = useState(null);
  const messagesRef = useRef([]);
  const conversationIdRef = useRef(null);
  const voiceStopRef = useRef(null);
  const locked = useRef(false);

  const push = (role, text, important = false) =>
    setFeed((f) => [...f, { role, text: String(text).slice(0, 800), important }]);

  useEffect(() => {
    ensureCatalog();
    const st = readState();
    writeState({ ...st, mode: null });
    setModel(st.text_model || "neo-brain");
    pyExec("project_set_root", { path: process.env.NEO_WORKSPACE || process.cwd() });
    void ensureImageDaemonSilent();
    void ensureBrainDaemonSilent();
    const t = setInterval(async () => {
      try {
        const r = await fetch("http://127.0.0.1:8765/health");
        setDaemon(!!(await r.json()).ready);
      } catch {
        setDaemon(false);
      }
    }, 5000);
    setBooted(true);
    return () => {
      clearInterval(t);
      voiceStopRef.current?.();
    };
  }, []);

  useInput((ch, key) => {
    if (key.ctrl && ch === "c") {
      voiceStopRef.current?.();
      exit();
    }
  });

  const pickMode = async (m) => {
    const st = readState();
    st.mode = m;
    writeState(st);
    pyExec("set_mode", { mode: m });
    setMode(m);
    const activeModel = st.text_model || model;
    const session = await openWorkspaceConversation({ mode: m, model: activeModel });
    conversationIdRef.current = session.conversationId;
    setConversationId(session.conversationId);
    messagesRef.current = session.messages;
    if (session.resumed && session.feed?.length) {
      setFeed([
        ...session.feed,
        {
          role: "sys",
          text: `resumed ${session.conversationId} (${session.feed.length} turns)`,
          important: true,
        },
      ]);
    } else {
      setFeed([]);
    }
  };

  const runAgent = async (userText) => {
    if (locked.current) return;
    locked.current = true;
    const st = readState();
    const activeMode = st.mode || mode || "work";
    const activeModel = st.text_model || model;
    push("You", userText);
    try {
      const out = await runAgentTurn({
        messages: messagesRef.current,
        mode: activeMode,
        model: activeModel,
        userText,
        conversationId: conversationIdRef.current,
        onNote: (t) => push("sys", t, true),
        onBusy: (b) => setBusy(b || ""),
        onReply: (t) => push("Neo", t),
      });
      if (out?.conversationId) {
        conversationIdRef.current = out.conversationId;
        setConversationId(out.conversationId);
      }
    } finally {
      setBusy("");
      locked.current = false;
    }
  };

  const onSubmit = async (raw) => {
    const line = String(raw || "").trim();
    setInput("");
    if (!line) return;
    try {
      if (line === "/quit" || line === "/exit") {
        voiceStopRef.current?.();
        exit();
        return;
      }
      if (line === "/new") {
        const session = await openWorkspaceConversation({
          mode: mode || "work",
          model,
          forceNew: true,
        });
        conversationIdRef.current = session.conversationId;
        setConversationId(session.conversationId);
        messagesRef.current = session.messages;
        setFeed([{ role: "sys", text: `new chat ${session.conversationId || "(local)"}`, important: true }]);
        return;
      }
      if (line === "/history") {
        const data = await listConversations(20, process.env.NEO_WORKSPACE || process.cwd());
        const rows = data.conversations || [];
        if (!rows.length) push("sys", "no saved chats", true);
        else {
          for (const c of rows) {
            const mark = c.id === conversationIdRef.current ? "*" : " ";
            push("sys", `${mark} ${c.id}  ${(c.title || "chat").slice(0, 48)}`, true);
          }
        }
        return;
      }
      if (line.startsWith("/resume ")) {
        const id = line.slice(8).trim();
        const data = await loadConversation(id);
        const cid = data.conversation?.id || id;
        conversationIdRef.current = cid;
        setConversationId(cid);
        const chat = data.chat || [];
        messagesRef.current = chatToAgentMessages(chat, mode || "work", model);
        setFeed([
          ...chatMessagesToFeed(chat),
          { role: "sys", text: `resumed ${cid}`, important: true },
        ]);
        return;
      }
      if (line === "/plan" || line === "/code" || line === "/work") {
        const next = line.slice(1);
        const st = readState();
        st.mode = next;
        writeState(st);
        pyExec("set_mode", { mode: next });
        setMode(next);
        if (messagesRef.current[0]) {
          messagesRef.current[0] = { role: "system", content: systemPrompt(next, model) };
        }
        return;
      }
      if (line === "/voice") {
        if (voice === "listening" || voice === "starting") {
          voiceStopRef.current?.();
          voiceStopRef.current = null;
          setVoice("off");
          setVoicePartial("");
          return;
        }
        setVoice("starting");
        voiceStopRef.current = startVoice(
          (transcript) => {
            setVoicePartial(transcript);
            setTimeout(() => {
              setVoicePartial("");
              if (!locked.current) runAgent(transcript);
            }, 30);
          },
          (status) => setVoice(status),
        );
        return;
      }
      if (line.startsWith("/tools ")) {
        const r = pyExec("search_tools", { query: line.slice(7), limit: 12 });
        push("sys", (r.data || []).map((t) => t.name).join("  ") || "none", true);
        return;
      }
      if (line.startsWith("/img ")) {
        setBusy("img");
        const r = pyExec("image_generate", { prompt: line.slice(5) });
        setBusy("");
        if (r.ok) push("sys", String(r.data?.path || "ok"), true);
        else push("sys", r.error || "img fail", true);
        return;
      }
      if (line.startsWith("/model ")) {
        const m = line.slice(7).trim();
        const st = readState();
        st.text_model = m;
        writeState(st);
        setModel(m);
        pyExec("model_switch_text", { model: m });
        return;
      }
      await runAgent(line);
    } catch (e) {
      push("sys", String(e.message || e), true);
      locked.current = false;
      setBusy("");
    }
  };

  if (!booted) {
    return h(Box, { padding: 1 }, h(Text, { color: C.mute }, "neo"));
  }
  if (!mode) return h(ModePicker, { onPick: pickMode });

  return h(
    Box,
    { flexDirection: "column", paddingX: 1 },
    h(Header, { mode, model, voice, busy, daemon, convId: conversationId }),
    h(Feed, { items: feed }),
    h(Composer, { value: input, onChange: setInput, onSubmit, mode, voicePartial }),
  );
}

ensureCatalog();
render(h(App));
