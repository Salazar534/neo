#!/usr/bin/env python3
"""
Neo daemon — local GGUF inference + SQLite-backed API.

Ports (default): http://127.0.0.1:8766

REST:
  GET  /health  /v1/health
  GET  /v1/models  /v1/tools  /v1/status
  POST /v1/chat/completions          OpenAI-compatible
  POST /v1/chat                      Neo turn (persist + complete)
  GET/POST /v1/conversations
  GET/POST/DELETE /v1/conversations/:id
  GET/POST /v1/conversations/:id/messages
  GET/POST /v1/memory
  POST /api/chat                     legacy chat shape (compat clients)
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from neo_store import NeoStore, data_root

LLM = None
DEVICE = "cpu"
MODEL_ID = "neo-brain"
MODEL_PATH = ""
LOCK = threading.Lock()
N_CTX = 16384
N_GPU_LAYERS = 0
READY = False
LOAD_ERROR = None
STORE: NeoStore | None = None
STARTED_AT = time.time()
PACKAGE_ROOT = Path(__file__).resolve().parents[1]


def _setup_daemon_logging() -> None:
    """Send prints to Neo logs dir — no visible console required (pythonw-safe)."""
    import sys

    log_env = os.environ.get("NEO_DAEMON_LOG")
    log_path = Path(log_env) if log_env else (data_root() / "logs" / "neo-brain.log")
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        fp = open(log_path, "a", encoding="utf-8", buffering=1)
        if sys.stdout is None or not getattr(sys.stdout, "isatty", lambda: False)():
            sys.stdout = fp
            sys.stderr = fp
    except Exception:
        pass


def load_config() -> dict:
    cfg_path = data_root() / "config.json"
    if cfg_path.is_file():
        try:
            return json.loads(cfg_path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def resolve_model_path(cfg: dict) -> Path:
    override = os.environ.get("NEO_MODEL_PATH")
    if override:
        return Path(override)
    if cfg.get("model_path"):
        p = Path(cfg["model_path"])
        if p.is_file():
            return p
    models = data_root() / "models"
    for name in ("neo-brain.gguf", "neo-coder.gguf", cfg.get("model_file") or ""):
        if not name:
            continue
        p = models / name
        if p.is_file():
            return p
    ggufs = sorted(models.glob("neo-*.gguf"))
    if not ggufs:
        ggufs = sorted(models.glob("*.gguf"))
    if ggufs:
        return ggufs[0]
    raise FileNotFoundError(f"No Neo GGUF model in {models}. Run: neo install")


def load_llm():
    global LLM, DEVICE, MODEL_ID, MODEL_PATH, N_CTX, N_GPU_LAYERS, READY, LOAD_ERROR
    try:
        from llama_cpp import Llama
    except ImportError as e:
        LOAD_ERROR = "llama-cpp-python not installed. Run: neo install\n" + str(e)
        READY = False
        raise

    cfg = load_config()
    MODEL_ID = str(cfg.get("model_id") or os.environ.get("NEO_TEXT_MODEL") or "neo-brain")
    N_CTX = int(os.environ.get("NEO_N_CTX") or cfg.get("n_ctx") or 16384)
    env_layers = os.environ.get("NEO_N_GPU_LAYERS")
    if env_layers is not None:
        N_GPU_LAYERS = int(env_layers)
    else:
        N_GPU_LAYERS = int(cfg.get("n_gpu_layers", -1))

    path = resolve_model_path(cfg)
    MODEL_PATH = str(path.resolve())
    print(f"[neo] loading {MODEL_PATH} n_ctx={N_CTX} n_gpu_layers={N_GPU_LAYERS}", flush=True)
    t0 = time.time()
    LLM = Llama(
        model_path=MODEL_PATH,
        n_ctx=N_CTX,
        n_gpu_layers=N_GPU_LAYERS,
        verbose=False,
        chat_format="chatml",
    )
    DEVICE = "cpu" if N_GPU_LAYERS == 0 else "gpu"
    READY = True
    LOAD_ERROR = None
    print(f"[neo] ready in {time.time() - t0:.1f}s device={DEVICE}", flush=True)


# --- tool-call parsing -------------------------------------------------------

_TOOL_XML = re.compile(r"<tool_call>\s*(.*?)\s*</tool_call>", re.DOTALL | re.IGNORECASE)
_TOOL_FENCE = re.compile(r"```(?:json|tool_call|tools?)?\s*(\{.*?\}|\[.*?\])\s*```", re.DOTALL | re.IGNORECASE)
_FN_CALL = re.compile(
    r"<function[=:\s]+([a-zA-Z0-9_\-]+)\s*>\s*(\{.*?\})\s*</function>",
    re.DOTALL | re.IGNORECASE,
)


def _as_tool_calls(obj) -> list[dict]:
    out = []
    if obj is None:
        return out
    if isinstance(obj, str):
        try:
            obj = json.loads(obj)
        except Exception:
            return out
    items = obj if isinstance(obj, list) else [obj]
    for it in items:
        if not isinstance(it, dict):
            continue
        if "function" in it and isinstance(it["function"], dict):
            fn = it["function"]
            name = fn.get("name")
            args = fn.get("arguments", {})
        else:
            name = it.get("name") or it.get("tool") or it.get("function_name")
            args = it.get("arguments") if "arguments" in it else it.get("args") or it.get("parameters") or {}
        if not name:
            continue
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except Exception:
                args = {"_raw": args}
        if not isinstance(args, dict):
            args = {"value": args}
        out.append(
            {
                "id": f"call_{uuid.uuid4().hex[:12]}",
                "type": "function",
                "function": {"name": str(name), "arguments": json.dumps(args)},
            }
        )
    return out


def parse_tool_calls_from_text(text: str) -> tuple[str, list[dict]]:
    if not text:
        return "", []
    calls: list[dict] = []
    cleaned = text

    for m in _TOOL_XML.finditer(text):
        calls.extend(_as_tool_calls(m.group(1)))
        cleaned = cleaned.replace(m.group(0), "")

    for m in _FN_CALL.finditer(text):
        name, raw = m.group(1), m.group(2)
        calls.extend(_as_tool_calls({"name": name, "arguments": raw}))
        cleaned = cleaned.replace(m.group(0), "")

    if not calls:
        for m in _TOOL_FENCE.finditer(text):
            try:
                parsed = json.loads(m.group(1))
            except Exception:
                continue
            if isinstance(parsed, dict) and (
                "name" in parsed or "tool" in parsed or "function" in parsed or "tool_calls" in parsed
            ):
                if "tool_calls" in parsed:
                    calls.extend(_as_tool_calls(parsed["tool_calls"]))
                else:
                    calls.extend(_as_tool_calls(parsed))
                cleaned = cleaned.replace(m.group(0), "")

    if not calls:
        bare = re.search(r"(\{\s*\"(?:name|tool|function)\"[\s\S]*\}\s*)$", text.strip())
        if bare:
            try:
                parsed = json.loads(bare.group(1))
                got = _as_tool_calls(parsed)
                if got:
                    calls.extend(got)
                    cleaned = cleaned[: bare.start()] + cleaned[bare.end() :]
            except Exception:
                pass

    return cleaned.strip(), calls


def tools_system_addon(tools: list | None) -> str:
    if not tools:
        return ""
    names = []
    for t in tools:
        if isinstance(t, dict) and t.get("type") == "function":
            fn = t.get("function") or {}
            names.append(
                {
                    "name": fn.get("name"),
                    "description": fn.get("description"),
                    "parameters": fn.get("parameters"),
                }
            )
    if not names:
        return ""
    return (
        "\n\nYou have tools. Prefer native tool calls when available. "
        "Otherwise emit ONE or more blocks exactly like:\n"
        "<tool_call>\n"
        '{"name":"tool_name","arguments":{...}}\n'
        "</tool_call>\n"
        "Do not invent tools. After tools run you will get results.\n"
        f"Available tools JSON:\n{json.dumps(names)[:12000]}\n"
    )


def normalize_messages(messages: list, tools: list | None) -> list:
    out = []
    for m in messages or []:
        if not isinstance(m, dict):
            continue
        role = m.get("role") or "user"
        content = m.get("content")
        if role == "system":
            out.append({"role": "system", "content": content or ""})
        elif role == "assistant":
            item = {"role": "assistant", "content": content or ""}
            if m.get("tool_calls"):
                item["tool_calls"] = m["tool_calls"]
            out.append(item)
        elif role == "tool":
            name = m.get("tool_name") or m.get("name") or "tool"
            body = content if isinstance(content, str) else json.dumps(content)
            out.append({"role": "user", "content": f"[tool result {name}]\n{body}"})
        else:
            out.append({"role": "user", "content": content or ""})

    if tools and out and out[0].get("role") == "system":
        out[0] = {
            "role": "system",
            "content": (out[0].get("content") or "") + tools_system_addon(tools),
        }
    elif tools:
        out.insert(0, {"role": "system", "content": tools_system_addon(tools).strip()})
    return out


def chat_completion(payload: dict) -> dict:
    assert LLM is not None
    messages = payload.get("messages") or []
    tools = payload.get("tools")
    temperature = float(payload.get("temperature") if payload.get("temperature") is not None else 0.35)
    max_tokens = int(payload.get("max_tokens") or 4096)

    norm = normalize_messages(messages, tools)

    kwargs = {
        "messages": norm,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": False,
    }
    used_native = False
    with LOCK:
        try:
            if tools:
                kwargs["tools"] = tools
                kwargs["tool_choice"] = payload.get("tool_choice") or "auto"
            result = LLM.create_chat_completion(**kwargs)
            used_native = True
        except TypeError:
            kwargs.pop("tools", None)
            kwargs.pop("tool_choice", None)
            result = LLM.create_chat_completion(**kwargs)
        except Exception:
            kwargs.pop("tools", None)
            kwargs.pop("tool_choice", None)
            result = LLM.create_chat_completion(**kwargs)

    choice = (result.get("choices") or [{}])[0]
    msg = choice.get("message") or {}
    content = msg.get("content") or ""
    tool_calls = msg.get("tool_calls") or []

    if not tool_calls and content:
        cleaned, parsed = parse_tool_calls_from_text(content)
        if parsed:
            content = cleaned
            tool_calls = parsed

    for tc in tool_calls:
        fn = tc.get("function") or {}
        args = fn.get("arguments")
        if isinstance(args, dict):
            fn["arguments"] = json.dumps(args)
        tc["function"] = fn
        if "id" not in tc:
            tc["id"] = f"call_{uuid.uuid4().hex[:12]}"
        if "type" not in tc:
            tc["type"] = "function"

    out_msg = {"role": "assistant", "content": content or None}
    if tool_calls:
        out_msg["tool_calls"] = tool_calls
        if not content:
            out_msg["content"] = None

    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:12]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": MODEL_ID,
        "choices": [
            {
                "index": 0,
                "message": out_msg,
                "finish_reason": "tool_calls" if tool_calls else "stop",
            }
        ],
        "usage": result.get("usage") or {},
        "neo": {"device": DEVICE, "native_tools": used_native, "model_path": MODEL_PATH},
    }


def to_legacy_chat_shape(openai_resp: dict) -> dict:
    msg = (((openai_resp.get("choices") or [{}])[0]).get("message")) or {}
    tool_calls = []
    for tc in msg.get("tool_calls") or []:
        fn = tc.get("function") or {}
        args = fn.get("arguments")
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except Exception:
                args = {"_raw": args}
        tool_calls.append({"function": {"name": fn.get("name"), "arguments": args or {}}})
    return {
        "model": openai_resp.get("model") or MODEL_ID,
        "message": {
            "role": "assistant",
            "content": msg.get("content") or "",
            "tool_calls": tool_calls,
        },
        "done": True,
    }


def catalog_tools_summary(limit: int = 80) -> list[dict]:
    path = PACKAGE_ROOT / "core" / "tools_catalog.json"
    try:
        cat = json.loads(path.read_text(encoding="utf-8"))
        tools = cat.get("tools") or []
        out = []
        for t in tools[:limit]:
            out.append(
                {
                    "name": t.get("name"),
                    "description": t.get("description"),
                    "category": t.get("category"),
                }
            )
        return out
    except Exception:
        return []


def status_payload() -> dict:
    cfg = load_config()
    return {
        "ok": True,
        "ready": READY,
        "device": DEVICE,
        "model": MODEL_ID,
        "model_path": MODEL_PATH,
        "error": LOAD_ERROR,
        "n_ctx": N_CTX,
        "n_gpu_layers": N_GPU_LAYERS,
        "uptime_sec": round(time.time() - STARTED_AT, 1),
        "db": str(STORE.path) if STORE else None,
        "workspace": os.environ.get("NEO_WORKSPACE") or os.getcwd(),
        "image_path": cfg.get("image_path"),
        "coder_path": cfg.get("coder_path"),
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print("[neo]", fmt % args, flush=True)

    def _json(self, code: int, obj: dict | list):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        try:
            return json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            return {}

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)
        assert STORE is not None

        if path in ("/health", "/v1/health"):
            self._json(200, status_payload())
            return
        if path in ("/v1/status", "/v1/sessions", "/status"):
            self._json(200, {**status_payload(), "sessions": STORE.list_conversations(20)})
            return
        if path in ("/v1/models", "/api/tags"):
            models = [{"id": MODEL_ID, "object": "model", "owned_by": "neo"}]
            if (data_root() / "models" / "neo-coder.gguf").is_file():
                models.append({"id": "neo-coder", "object": "model", "owned_by": "neo"})
            self._json(
                200,
                {
                    "object": "list",
                    "data": models,
                    "models": [{"name": m["id"]} for m in models],
                },
            )
            return
        if path == "/v1/tools":
            limit = int((qs.get("limit") or ["80"])[0])
            self._json(200, {"ok": True, "tools": catalog_tools_summary(limit)})
            return
        if path == "/v1/conversations":
            limit = int((qs.get("limit") or ["50"])[0])
            workspace = (qs.get("workspace") or [None])[0]
            rows = STORE.list_conversations(max(limit, 80) if workspace else limit)
            latest = None
            if workspace:
                latest = STORE.find_latest_for_workspace(workspace, limit=80)
                target = os.path.normcase(os.path.abspath(workspace))
                filtered = []
                for r in rows:
                    ws = r.get("workspace") or ""
                    try:
                        if os.path.normcase(os.path.abspath(ws)) == target:
                            filtered.append(r)
                    except Exception:
                        if ws == workspace:
                            filtered.append(r)
                rows = filtered[:limit]
                if latest and not any(r["id"] == latest["id"] for r in rows):
                    rows = [latest] + rows
            self._json(200, {"ok": True, "conversations": rows, "latest": latest})
            return
        if path.startswith("/v1/conversations/") and path.endswith("/messages"):
            cid = path[len("/v1/conversations/") : -len("/messages")]
            self._json(200, {"ok": True, "messages": STORE.list_messages(cid)})
            return
        if path.startswith("/v1/conversations/"):
            cid = path.split("/")[-1]
            conv = STORE.get_conversation(cid)
            if not conv:
                self._json(404, {"ok": False, "error": "not found"})
                return
            self._json(
                200,
                {
                    "ok": True,
                    "conversation": conv,
                    "messages": STORE.list_messages(cid),
                    "chat": STORE.messages_as_chat(cid),
                },
            )
            return
        if path == "/v1/memory":
            key = (qs.get("key") or [None])[0]
            self._json(200, {"ok": True, "memory": STORE.memory_get(key)})
            return
        self._json(404, {"ok": False, "error": "not found"})

    def do_DELETE(self):
        path = urlparse(self.path).path
        assert STORE is not None
        if path.startswith("/v1/conversations/"):
            cid = path.split("/")[-1]
            STORE.delete_conversation(cid)
            self._json(200, {"ok": True, "deleted": cid})
            return
        self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        payload = self._read_json()
        assert STORE is not None

        if path == "/v1/conversations":
            conv = STORE.create_conversation(
                title=payload.get("title"),
                workspace=payload.get("workspace") or os.environ.get("NEO_WORKSPACE"),
                mode=payload.get("mode") or "work",
                model=payload.get("model") or MODEL_ID,
            )
            self._json(200, {"ok": True, "conversation": conv})
            return

        if path.startswith("/v1/conversations/") and path.endswith("/messages"):
            cid = path[len("/v1/conversations/") : -len("/messages")]
            if not STORE.get_conversation(cid):
                self._json(404, {"ok": False, "error": "conversation not found"})
                return
            msg = STORE.add_message(
                cid,
                payload.get("role") or "user",
                payload.get("content"),
                tool_name=payload.get("tool_name"),
                tool_calls=payload.get("tool_calls"),
            )
            self._json(200, {"ok": True, "message": msg})
            return

        if path == "/v1/memory":
            key = payload.get("key")
            if not key:
                self._json(400, {"ok": False, "error": "key required"})
                return
            STORE.memory_set(str(key), payload.get("value"))
            self._json(200, {"ok": True})
            return

        if path == "/v1/chat":
            # Persist user turn + run completion (no tool execution — CLI agent owns that)
            cid = payload.get("conversation_id")
            if not cid:
                conv = STORE.create_conversation(
                    workspace=payload.get("workspace") or os.environ.get("NEO_WORKSPACE"),
                    mode=payload.get("mode") or "work",
                    model=payload.get("model") or MODEL_ID,
                )
                cid = conv["id"]
            user_text = payload.get("message") or payload.get("content")
            messages = payload.get("messages")
            if user_text:
                STORE.add_message(cid, "user", user_text)
            if not messages:
                messages = STORE.messages_as_chat(cid)
                if not any(m.get("role") == "system" for m in messages):
                    messages.insert(
                        0,
                        {
                            "role": "system",
                            "content": (
                                "You are NEO, an elite local coding agent on this PC. "
                                "Be concrete, tool-first when tools are provided, Neo identity only."
                            ),
                        },
                    )
            if not READY or LLM is None:
                self._json(503, {"ok": False, "error": LOAD_ERROR or "model loading", "conversation_id": cid})
                return
            try:
                resp = chat_completion(
                    {
                        "messages": messages,
                        "tools": payload.get("tools"),
                        "temperature": payload.get("temperature"),
                        "max_tokens": payload.get("max_tokens"),
                    }
                )
                amsg = (((resp.get("choices") or [{}])[0]).get("message")) or {}
                STORE.add_message(
                    cid,
                    "assistant",
                    amsg.get("content"),
                    tool_calls=amsg.get("tool_calls"),
                )
                self._json(200, {"ok": True, "conversation_id": cid, "completion": resp})
            except Exception as e:
                traceback.print_exc()
                self._json(500, {"ok": False, "error": str(e), "conversation_id": cid})
            return

        # Inference routes need model ready
        if not READY or LLM is None:
            self._json(503, {"ok": False, "error": LOAD_ERROR or "model loading"})
            return

        try:
            if path in ("/v1/chat/completions", "/chat/completions"):
                self._json(200, chat_completion(payload))
                return
            if path == "/api/chat":
                opts = payload.get("options") or {}
                openai_payload = {
                    "messages": payload.get("messages") or [],
                    "tools": payload.get("tools"),
                    "temperature": opts.get("temperature", 0.35),
                    "max_tokens": opts.get("num_predict") or 4096,
                }
                self._json(200, to_legacy_chat_shape(chat_completion(openai_payload)))
                return
            self._json(404, {"ok": False, "error": "not found"})
        except Exception as e:
            traceback.print_exc()
            self._json(500, {"ok": False, "error": str(e)})


def main():
    global READY, LOAD_ERROR, STORE

    _setup_daemon_logging()
    cfg = load_config()
    STORE = NeoStore(Path(cfg["db_path"]) if cfg.get("db_path") else None)
    port = int(os.environ.get("NEO_BRAIN_PORT") or cfg.get("brain_port") or 8766)
    host = os.environ.get("NEO_BRAIN_HOST") or "127.0.0.1"

    # Serve conversation/memory APIs immediately; load GGUF in background.
    def _load_bg():
        global READY, LOAD_ERROR
        try:
            load_llm()
        except Exception as e:
            READY = False
            LOAD_ERROR = str(e)
            print(f"[neo] load failed: {e}", flush=True)

    threading.Thread(target=_load_bg, name="neo-llm-load", daemon=True).start()
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"[neo] API listening http://{host}:{port}  db={STORE.path}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
