"""
Neo local SQLite store — conversations, messages, memory, todos, tool_runs, settings.
DB default: %LOCALAPPDATA%/Neo/neo.db
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any


def data_root() -> Path:
    env = os.environ.get("NEO_HOME")
    if env:
        return Path(env)
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "Neo"
    import sys

    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Neo"
    xdg = os.environ.get("XDG_DATA_HOME")
    if xdg:
        return Path(xdg) / "neo"
    return Path.home() / ".local" / "share" / "neo"


def default_db_path() -> Path:
    cfg_path = data_root() / "config.json"
    if cfg_path.is_file():
        try:
            cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
            if cfg.get("db_path"):
                return Path(cfg["db_path"])
        except Exception:
            pass
    return data_root() / "neo.db"


SCHEMA = """
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT,
  workspace TEXT,
  mode TEXT,
  model TEXT,
  created_at REAL,
  updated_at REAL,
  archived INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  tool_name TEXT,
  tool_calls TEXT,
  created_at REAL,
  FOREIGN KEY(conversation_id) REFERENCES conversations(id)
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
CREATE TABLE IF NOT EXISTS memory (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at REAL
);
CREATE TABLE IF NOT EXISTS todos (
  id TEXT PRIMARY KEY,
  content TEXT,
  status TEXT,
  created_at REAL,
  updated_at REAL
);
CREATE TABLE IF NOT EXISTS tool_runs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  tool_name TEXT,
  args TEXT,
  result TEXT,
  ok INTEGER,
  created_at REAL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
"""


class NeoStore:
    def __init__(self, path: Path | None = None):
        self.path = Path(path or default_db_path())
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.executescript(SCHEMA)
        self._conn.commit()

    def close(self):
        self._conn.close()

    def create_conversation(
        self,
        *,
        title: str | None = None,
        workspace: str | None = None,
        mode: str = "work",
        model: str = "neo-brain",
        conversation_id: str | None = None,
    ) -> dict:
        cid = conversation_id or f"c_{uuid.uuid4().hex[:12]}"
        now = time.time()
        self._conn.execute(
            "INSERT INTO conversations(id,title,workspace,mode,model,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
            (cid, title or "New chat", workspace, mode, model, now, now),
        )
        self._conn.commit()
        return self.get_conversation(cid)

    def get_conversation(self, cid: str) -> dict | None:
        row = self._conn.execute("SELECT * FROM conversations WHERE id=?", (cid,)).fetchone()
        return dict(row) if row else None

    def list_conversations(self, limit: int = 50, include_archived: bool = False) -> list[dict]:
        if include_archived:
            rows = self._conn.execute(
                "SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
        else:
            rows = self._conn.execute(
                "SELECT * FROM conversations WHERE archived=0 ORDER BY updated_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [dict(r) for r in rows]

    def touch_conversation(self, cid: str, **fields):
        cols = []
        vals: list[Any] = []
        for k in ("title", "workspace", "mode", "model", "archived"):
            if k in fields:
                cols.append(f"{k}=?")
                vals.append(fields[k])
        cols.append("updated_at=?")
        vals.append(time.time())
        vals.append(cid)
        self._conn.execute(f"UPDATE conversations SET {', '.join(cols)} WHERE id=?", vals)
        self._conn.commit()

    def delete_conversation(self, cid: str):
        self._conn.execute("DELETE FROM messages WHERE conversation_id=?", (cid,))
        self._conn.execute("DELETE FROM conversations WHERE id=?", (cid,))
        self._conn.commit()

    def add_message(
        self,
        conversation_id: str,
        role: str,
        content: str | None = None,
        *,
        tool_name: str | None = None,
        tool_calls: Any = None,
        message_id: str | None = None,
    ) -> dict:
        mid = message_id or f"m_{uuid.uuid4().hex[:12]}"
        now = time.time()
        tc = json.dumps(tool_calls) if tool_calls is not None else None
        self._conn.execute(
            "INSERT INTO messages(id,conversation_id,role,content,tool_name,tool_calls,created_at) VALUES(?,?,?,?,?,?,?)",
            (mid, conversation_id, role, content, tool_name, tc, now),
        )
        self.touch_conversation(conversation_id)
        # Auto-title from first user message
        if role == "user" and content:
            conv = self.get_conversation(conversation_id)
            if conv and (not conv.get("title") or conv.get("title") == "New chat"):
                title = content.strip().replace("\n", " ")[:72]
                self.touch_conversation(conversation_id, title=title)
        return self.get_message(mid)

    def get_message(self, mid: str) -> dict | None:
        row = self._conn.execute("SELECT * FROM messages WHERE id=?", (mid,)).fetchone()
        if not row:
            return None
        d = dict(row)
        if d.get("tool_calls"):
            try:
                d["tool_calls"] = json.loads(d["tool_calls"])
            except Exception:
                pass
        return d

    def list_messages(self, conversation_id: str, limit: int = 500) -> list[dict]:
        rows = self._conn.execute(
            "SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at ASC LIMIT ?",
            (conversation_id, limit),
        ).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            if d.get("tool_calls"):
                try:
                    d["tool_calls"] = json.loads(d["tool_calls"])
                except Exception:
                    pass
            out.append(d)
        return out

    def messages_as_chat(self, conversation_id: str, *, compact_tools: bool = True) -> list[dict]:
        """OpenAI-ish messages for resume; compact old tool noise."""
        msgs = self.list_messages(conversation_id)
        out = []
        for i, m in enumerate(msgs):
            role = m["role"]
            item: dict[str, Any] = {"role": role}
            content = m.get("content") or ""
            if role == "tool":
                item["tool_name"] = m.get("tool_name") or "tool"
                if compact_tools and len(content) > 2500 and i < len(msgs) - 12:
                    content = content[:2500] + "…[archived]"
                item["content"] = content
            elif role == "assistant":
                item["content"] = content
                if m.get("tool_calls"):
                    item["tool_calls"] = m["tool_calls"]
            else:
                item["content"] = content
            out.append(item)
        return out

    def memory_set(self, key: str, value: Any):
        self._conn.execute(
            "INSERT INTO memory(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            (key, json.dumps(value), time.time()),
        )
        self._conn.commit()

    def memory_get(self, key: str | None = None) -> Any:
        if key:
            row = self._conn.execute("SELECT value FROM memory WHERE key=?", (key,)).fetchone()
            if not row:
                return None
            try:
                return json.loads(row["value"])
            except Exception:
                return row["value"]
        rows = self._conn.execute("SELECT key, value FROM memory").fetchall()
        out = {}
        for r in rows:
            try:
                out[r["key"]] = json.loads(r["value"])
            except Exception:
                out[r["key"]] = r["value"]
        return out

    def setting_set(self, key: str, value: Any):
        self._conn.execute(
            "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, json.dumps(value)),
        )
        self._conn.commit()

    def setting_get(self, key: str, default=None):
        row = self._conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        if not row:
            return default
        try:
            return json.loads(row["value"])
        except Exception:
            return row["value"]

    def log_tool_run(self, conversation_id: str | None, tool_name: str, args: Any, result: Any, ok: bool):
        self._conn.execute(
            "INSERT INTO tool_runs(id,conversation_id,tool_name,args,result,ok,created_at) VALUES(?,?,?,?,?,?,?)",
            (
                f"t_{uuid.uuid4().hex[:12]}",
                conversation_id,
                tool_name,
                json.dumps(args)[:20000],
                json.dumps(result)[:50000] if not isinstance(result, str) else result[:50000],
                1 if ok else 0,
                time.time(),
            ),
        )
        self._conn.commit()
