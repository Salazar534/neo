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
  pyExec,
  readState,
  startVoice,
  systemPrompt,
  writeState,
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
    { label: "plan", value: "plan" },
    { label: "code", value: "code" },
    { label: "work", value: "work" },
  ];
  return h(
    Box,
    { flexDirection: "column", paddingX: 1, paddingY: 1 },
    h(Text, { bold: true, color: C.accent }, "NEO"),
    h(Text, { color: C.mute }, "mode"),
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

function Header({ mode, model, voice, busy, daemon }) {
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
      h(Badge, { label: String(mode).toUpperCase() }),
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
    h(Text, { color: C.mute }, "modes: /plan  /code  /work"),
  );
}

function Feed({ items }) {
  const shown = items.filter((m) => m.role !== "sys" || m.important).slice(-10);
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
                color: m.role === "you" ? C.accent : m.role === "neo" ? C.good : C.mute,
              },
              m.role === "sys" ? "·" : m.role,
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
      h(Text, { bold: true, color: C.accent }, (mode || "").toUpperCase()),
      h(Text, { color: C.mute }, " › "),
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
  const messagesRef = useRef([]);
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
    ensureImageDaemonSilent();
    ensureBrainDaemonSilent();
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

  const pickMode = (m) => {
    const st = readState();
    st.mode = m;
    writeState(st);
    pyExec("set_mode", { mode: m });
    setMode(m);
    messagesRef.current = [{ role: "system", content: systemPrompt(m, st.text_model || model) }];
  };

  const runAgent = async (userText) => {
    if (locked.current) return;
    locked.current = true;
    const st = readState();
    const activeMode = st.mode || mode || "work";
    const activeModel = st.text_model || model;
    push("you", userText);
    try {
      await runAgentTurn({
        messages: messagesRef.current,
        mode: activeMode,
        model: activeModel,
        userText,
        onNote: (t) => push("sys", t, true),
        onBusy: (b) => setBusy(b || ""),
        onReply: (t) => push("neo", t),
      });
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
      if (line === "/plan" || line === "/code" || line === "/work") {
        pickMode(line.slice(1));
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
    h(Header, { mode, model, voice, busy, daemon }),
    h(Feed, { items: feed }),
    h(Composer, { value: input, onChange: setInput, onSubmit, mode, voicePartial }),
  );
}

ensureCatalog();
render(h(App));
