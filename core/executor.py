#!/usr/bin/env python3
"""Neo tool executor — runs any catalog tool safely-ish on Windows."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
CATALOG_PATH = Path(__file__).resolve().parent / "tools_catalog.json"
OUT_DIR = (ROOT / "outputs").resolve()
def _neo_data_root() -> Path:
    env = os.environ.get("NEO_HOME")
    if env:
        return Path(env)
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "Neo"
    xdg = os.environ.get("XDG_DATA_HOME")
    if xdg:
        return Path(xdg) / "neo"
    return Path.home() / ".local" / "share" / "neo"


STATE_PATH = _neo_data_root() / "session_state.json"
IMAGE_DAEMON = os.environ.get("NEO_IMAGE_URL", "http://127.0.0.1:8765")

# Project cwd: NEO_WORKSPACE (set by neo launcher to process.cwd()) or process cwd.
_WORKSPACE = Path(os.environ.get("NEO_WORKSPACE") or os.getcwd()).resolve()
OUT_DIR.mkdir(parents=True, exist_ok=True)
_WORKSPACE.mkdir(parents=True, exist_ok=True)

# In-memory chunk write sessions (also persisted under .neo for cross-process resume)
_WRITE_SESSIONS: dict[str, dict[str, Any]] = {}


def _sessions_path() -> Path:
    return neo_dir() / "write_sessions.json"


def _load_sessions() -> dict[str, dict[str, Any]]:
    global _WRITE_SESSIONS
    path = _sessions_path()
    if path.exists():
        try:
            disk = json.loads(path.read_text(encoding="utf-8"))
            for k, v in disk.items():
                if k not in _WRITE_SESSIONS:
                    v = dict(v)
                    v["received"] = set(v.get("received") or [])
                    _WRITE_SESSIONS[k] = v
        except Exception:
            pass
    return _WRITE_SESSIONS


def _save_sessions() -> None:
    path = _sessions_path()
    serial = {}
    for k, v in _WRITE_SESSIONS.items():
        serial[k] = {
            "path": v["path"],
            "tmp": v["tmp"],
            "received": sorted(list(v.get("received") or [])),
            "total": v.get("total"),
            "bytes": v.get("bytes", 0),
        }
    path.write_text(json.dumps(serial, indent=2), encoding="utf-8")

SKIP_DIRS = {
    "node_modules",
    ".git",
    ".hg",
    ".svn",
    "__pycache__",
    ".venv",
    "venv",
    "dist",
    "build",
    ".next",
    ".neo",
    "coverage",
}

CATALOG = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
BY_NAME = {t["name"]: t for t in CATALOG["tools"]}


def get_workspace() -> Path:
    return _WORKSPACE


def set_workspace(path: Path | str) -> Path:
    global _WORKSPACE
    p = Path(path).expanduser().resolve()
    p.mkdir(parents=True, exist_ok=True)
    _WORKSPACE = p
    os.environ["NEO_WORKSPACE"] = str(p)
    return _WORKSPACE


def neo_dir() -> Path:
    d = get_workspace() / ".neo"
    d.mkdir(parents=True, exist_ok=True)
    return d


def load_state() -> dict:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    if STATE_PATH.exists():
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    return {"mode": "work", "text_model": os.environ.get("NEO_TEXT_MODEL", "neo-brain"), "last_image_prompt": ""}


def save_state(st: dict) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(st, indent=2), encoding="utf-8")


def ok(data: Any = None, **extra) -> dict:
    out = {"ok": True}
    if data is not None:
        out["data"] = data
    out.update(extra)
    return out


def err(msg: str, **extra) -> dict:
    out = {"ok": False, "error": str(msg)}
    out.update(extra)
    return out


def resolve_path(p: str) -> Path:
    path = Path(str(p)).expanduser()
    if not path.is_absolute():
        path = (get_workspace() / path).resolve()
    return path


def run_cmd(args: list[str], timeout: int = 120, cwd: str | None = None) -> dict:
    try:
        cp = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=cwd or str(get_workspace()),
            shell=False,
        )
        return ok(
            {
                "code": cp.returncode,
                "stdout": (cp.stdout or "")[-20000:],
                "stderr": (cp.stderr or "")[-8000:],
            }
        )
    except Exception as e:
        return err(str(e))


def special_folder(name: str) -> Path:
    home = Path.home()
    mapping = {
        "Desktop": home / "Desktop",
        "Documents": home / "Documents",
        "Downloads": home / "Downloads",
        "AppDataLocal": Path(os.environ.get("LOCALAPPDATA", home / "AppData/Local")),
        "AppDataRoaming": Path(os.environ.get("APPDATA", home / "AppData/Roaming")),
        "Temp": Path(tempfile.gettempdir()),
        "Home": home,
        "Workspace": get_workspace(),
    }
    return mapping.get(name, get_workspace())


def _count_occurrences(haystack: str, needle: str) -> int:
    if not needle:
        return 0
    count = 0
    start = 0
    while True:
        i = haystack.find(needle, start)
        if i < 0:
            break
        count += 1
        start = i + len(needle)
    return count


def _should_skip_path(p: Path) -> bool:
    try:
        parts = set(p.parts)
    except Exception:
        return True
    return bool(parts & SKIP_DIRS)


def web_get(url: str, max_chars: int = 30000) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "NeoLocalAI/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read()
        ctype = r.headers.get("Content-Type", "")
    text = raw.decode("utf-8", errors="replace")
    return ok({"content_type": ctype, "text": text[:max_chars], "bytes": len(raw)})


def web_search(query: str, limit: int = 5) -> dict:
    q = urllib.parse.quote(query)
    url = f"https://duckduckgo.com/html/?q={q}"
    got = web_get(url, max_chars=200000)
    if not got.get("ok"):
        return got
    html = got["data"]["text"]
    # crude result extraction
    links = re.findall(r'uddg=([^"&]+)', html)
    titles = re.findall(r'class="result__a"[^>]*>(.*?)</a>', html, flags=re.I | re.S)
    results = []
    for i, link in enumerate(links[:limit]):
        title = re.sub("<.*?>", "", titles[i]).strip() if i < len(titles) else query
        results.append({"title": title, "url": urllib.parse.unquote(link)})
    if not results:
        # fallback: return search URL
        results = [{"title": query, "url": f"https://duckduckgo.com/?q={q}"}]
    return ok(results)


HANDLERS: dict[str, Any] = {}


def handler(name):
    def deco(fn):
        HANDLERS[name] = fn
        return fn

    return deco


@handler("search_tools")
def h_search_tools(args, tool):
    q = str(args.get("query", "")).lower()
    raw_limit = args.get("limit", 20)
    try:
        limit = int(raw_limit if not isinstance(raw_limit, dict) else 20)
    except Exception:
        limit = 20
    hits = []
    for t in CATALOG["tools"]:
        blob = f"{t['name']} {t['description']} {t['category']}".lower()
        if q in blob or all(part in blob for part in q.split()):
            hits.append({"name": t["name"], "category": t["category"], "description": t["description"]})
        if len(hits) >= limit:
            break
    return ok(hits, count=len(hits))


@handler("list_categories")
def h_list_categories(args, tool):
    counts: dict[str, int] = {}
    for t in CATALOG["tools"]:
        counts[t["category"]] = counts.get(t["category"], 0) + 1
    return ok(counts, total=sum(counts.values()))


@handler("set_mode")
def h_set_mode(args, tool):
    mode = str(args.get("mode", "work")).lower()
    if mode not in {"plan", "code", "work"}:
        return err("mode must be plan|code|work")
    st = load_state()
    st["mode"] = mode
    save_state(st)
    return ok({"mode": mode})


@handler("get_status")
def h_get_status(args, tool):
    st = load_state()
    daemon = False
    try:
        urllib.request.urlopen(f"{IMAGE_DAEMON}/health", timeout=1)
        daemon = True
    except Exception:
        daemon = False
    return ok(
        {
            **st,
            "tools": CATALOG["count"],
            "workspace": str(get_workspace()),
            "image_daemon": daemon,
            "image_url": IMAGE_DAEMON,
        }
    )


@handler("project_set_root")
def h_project_set_root(args, tool):
    path = Path(str(args["path"])).expanduser()
    if not path.is_absolute():
        path = (Path.cwd() / path).resolve()
    else:
        path = path.resolve()
    if not path.exists():
        path.mkdir(parents=True, exist_ok=True)
    ws = set_workspace(path)
    st = load_state()
    st["project_root"] = str(ws)
    save_state(st)
    return ok({"workspace": str(ws)})


@handler("call_tool")
def h_call_tool(args, tool):
    name = args.get("name")
    inner = args.get("args") or {}
    return execute(name, inner, allow_meta=False)


@handler("fs_read")
def h_fs_read(args, tool):
    path = resolve_path(args["path"])
    max_bytes = int(args.get("max_bytes") or 200000)
    data = path.read_bytes()[:max_bytes]
    return ok({"path": str(path), "text": data.decode("utf-8", errors="replace"), "bytes": len(data)})


@handler("fs_write")
def h_fs_write(args, tool):
    path = resolve_path(args["path"])
    path.parent.mkdir(parents=True, exist_ok=True)
    content = str(args.get("content", ""))
    path.write_text(content, encoding="utf-8")
    return ok({"path": str(path), "bytes": path.stat().st_size})


@handler("fs_append")
def h_fs_append(args, tool):
    """Append content. Optional chunk_index/total for resumable long writes."""
    path = resolve_path(args["path"])
    path.parent.mkdir(parents=True, exist_ok=True)
    content = str(args.get("content", ""))
    chunk_index = args.get("chunk_index")
    total = args.get("total")
    if chunk_index is not None:
        idx = int(chunk_index)
        if idx == 0 and not args.get("resume"):
            path.write_text(content, encoding="utf-8")
        else:
            with path.open("a", encoding="utf-8") as f:
                f.write(content)
        size = path.stat().st_size
        done = total is not None and (idx + 1) >= int(total)
        return ok(
            {
                "path": str(path),
                "bytes": size,
                "chunk_index": idx,
                "total": int(total) if total is not None else None,
                "chunk_bytes": len(content.encode("utf-8")),
                "complete": done,
            }
        )
    with path.open("a", encoding="utf-8") as f:
        f.write(content)
    return ok({"path": str(path), "bytes": path.stat().st_size, "chunk_bytes": len(content.encode("utf-8"))})


@handler("fs_write_begin")
def h_fs_write_begin(args, tool):
    path = resolve_path(args["path"])
    path.parent.mkdir(parents=True, exist_ok=True)
    write_id = str(args.get("write_id") or hashlib.md5(f"{path}-{time.time()}".encode()).hexdigest()[:12])
    tmp = neo_dir() / f"write_{write_id}.part"
    total = args.get("total")
    tmp.write_bytes(b"")
    _load_sessions()
    _WRITE_SESSIONS[write_id] = {
        "path": str(path),
        "tmp": str(tmp),
        "received": set(),
        "total": int(total) if total is not None else None,
        "bytes": 0,
    }
    _save_sessions()
    return ok({"write_id": write_id, "path": str(path), "tmp": str(tmp), "total": total})


@handler("fs_write_chunk")
def h_fs_write_chunk(args, tool):
    """
    Write a chunk of a large file.
    Modes:
      A) write_id from fs_write_begin + chunk_index + content
      B) path + content + chunk_index (+ optional total): idx 0 truncates, later append
    """
    content = str(args.get("content", ""))
    raw = content.encode("utf-8")
    chunk_index = int(args.get("chunk_index") or 0)
    total = args.get("total")
    write_id = args.get("write_id")

    if write_id:
        sessions = _load_sessions()
        sess = sessions.get(str(write_id))
        if not sess:
            return err(f"unknown write_id: {write_id} — call fs_write_begin first")
        tmp = Path(sess["tmp"])
        with tmp.open("ab") as f:
            f.write(raw)
        if not isinstance(sess.get("received"), set):
            sess["received"] = set(sess.get("received") or [])
        sess["received"].add(chunk_index)
        sess["bytes"] = int(sess.get("bytes") or 0) + len(raw)
        if total is not None:
            sess["total"] = int(total)
        _WRITE_SESSIONS[str(write_id)] = sess
        _save_sessions()
        complete = sess["total"] is not None and len(sess["received"]) >= sess["total"]
        out = {
            "write_id": write_id,
            "path": sess["path"],
            "chunk_index": chunk_index,
            "chunk_bytes": len(raw),
            "bytes": sess["bytes"],
            "received": len(sess["received"]),
            "total": sess["total"],
            "complete": complete,
        }
        if complete or args.get("finalize"):
            return h_fs_write_finalize({"write_id": write_id}, tool)
        return ok(out)

    path = resolve_path(args["path"])
    path.parent.mkdir(parents=True, exist_ok=True)
    if chunk_index == 0 and not args.get("resume"):
        path.write_bytes(raw)
    else:
        with path.open("ab") as f:
            f.write(raw)
    size = path.stat().st_size
    done = total is not None and (chunk_index + 1) >= int(total)
    return ok(
        {
            "path": str(path),
            "chunk_index": chunk_index,
            "chunk_bytes": len(raw),
            "bytes": size,
            "total": int(total) if total is not None else None,
            "complete": done,
        }
    )


@handler("fs_write_finalize")
def h_fs_write_finalize(args, tool):
    write_id = str(args["write_id"])
    sessions = _load_sessions()
    sess = sessions.get(write_id)
    if not sess:
        return err(f"unknown write_id: {write_id}")
    tmp = Path(sess["tmp"])
    dest = Path(sess["path"])
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(tmp), str(dest))
    size = dest.stat().st_size
    _WRITE_SESSIONS.pop(write_id, None)
    _save_sessions()
    return ok({"path": str(dest), "bytes": size, "write_id": write_id, "complete": True})


@handler("fs_edit_replace")
def h_fs_edit_replace(args, tool):
    path = resolve_path(args["path"])
    if not path.exists():
        return err(f"file not found: {path}")
    text = path.read_text(encoding="utf-8")
    old, new = str(args["old"]), str(args["new"])
    if old == "":
        return err("old string must be non-empty")
    n = _count_occurrences(text, old)
    replace_all = bool(args.get("all"))
    if n == 0:
        return err(f"no matches for old string in {path}", matches=0, path=str(path))
    if not replace_all and n > 1:
        return err(
            f"old string matched {n} times; pass all=true to replace all, or make old unique",
            matches=n,
            path=str(path),
        )
    if replace_all:
        text2 = text.replace(old, new)
        replaced = n
    else:
        text2 = text.replace(old, new, 1)
        replaced = 1
    path.write_text(text2, encoding="utf-8")
    return ok({"replacements": replaced, "path": str(path), "matches": n})


@handler("apply_patch")
def h_apply_patch(args, tool):
    """Apply multi-file edits. edits: [{path, old, new, all?}] OR patch/unified string via edits."""
    edits = args.get("edits") or args.get("changes") or []
    if isinstance(edits, str):
        return err("edits must be a list of {path, old, new}")
    if not edits:
        return err("edits list required")
    results = []
    # Phase 1: validate all
    planned = []
    for i, e in enumerate(edits):
        if not isinstance(e, dict):
            return err(f"edit[{i}] must be object")
        path = resolve_path(e["path"])
        old, new = str(e.get("old", "")), str(e.get("new", ""))
        replace_all = bool(e.get("all"))
        if not path.exists():
            return err(f"edit[{i}]: file not found: {path}")
        text = path.read_text(encoding="utf-8")
        if old == "":
            return err(f"edit[{i}]: old must be non-empty")
        n = _count_occurrences(text, old)
        if n == 0:
            return err(f"edit[{i}]: no matches in {path}", path=str(path), matches=0)
        if not replace_all and n > 1:
            return err(
                f"edit[{i}]: {n} matches in {path}; pass all=true or unique old",
                path=str(path),
                matches=n,
            )
        if replace_all:
            text2 = text.replace(old, new)
            replaced = n
        else:
            text2 = text.replace(old, new, 1)
            replaced = 1
        planned.append((path, text2, replaced, n))
    # Phase 2: write all (best-effort atomic across files)
    for path, text2, replaced, n in planned:
        path.write_text(text2, encoding="utf-8")
        results.append({"path": str(path), "replacements": replaced, "matches": n})
    return ok({"applied": len(results), "files": results})


@handler("fs_apply_edits")
def h_fs_apply_edits(args, tool):
    return h_apply_patch(args, tool)


@handler("fs_edit_line_range")
def h_fs_edit_line_range(args, tool):
    path = resolve_path(args["path"])
    lines = path.read_text(encoding="utf-8").splitlines(True)
    start, end = int(args["start"]), int(args["end"])
    content = str(args["content"])
    if not content.endswith("\n"):
        content += "\n"
    lines[start - 1 : end] = [content]
    path.write_text("".join(lines), encoding="utf-8")
    return ok({"path": str(path)})


@handler("fs_insert_at_line")
def h_fs_insert_at_line(args, tool):
    path = resolve_path(args["path"])
    lines = path.read_text(encoding="utf-8").splitlines(True)
    line = int(args["line"])
    content = str(args["content"])
    if not content.endswith("\n"):
        content += "\n"
    lines.insert(line - 1, content)
    path.write_text("".join(lines), encoding="utf-8")
    return ok({"path": str(path)})


@handler("fs_delete")
def h_fs_delete(args, tool):
    path = resolve_path(args["path"])
    if path.is_dir():
        shutil.rmtree(path)
    elif path.exists():
        path.unlink()
    return ok({"deleted": str(path)})


@handler("fs_mkdir")
def h_fs_mkdir(args, tool):
    path = resolve_path(args["path"])
    path.mkdir(parents=True, exist_ok=True)
    return ok({"path": str(path)})


@handler("fs_listdir")
def h_fs_listdir(args, tool):
    path = resolve_path(args["path"])
    items = [{"name": p.name, "dir": p.is_dir()} for p in sorted(path.iterdir())][:500]
    return ok(items)


@handler("fs_glob")
def h_fs_glob(args, tool):
    root = resolve_path(args.get("root") or ".")
    pattern = args.get("pattern") or "*"
    hits = [str(p) for p in root.glob(pattern)][:500]
    return ok(hits)


@handler("fs_stat")
def h_fs_stat(args, tool):
    path = resolve_path(args["path"])
    st = path.stat()
    return ok({"path": str(path), "size": st.st_size, "mtime": st.st_mtime, "is_dir": path.is_dir()})


@handler("fs_copy")
def h_fs_copy(args, tool):
    src, dst = resolve_path(args["src"]), resolve_path(args["dst"])
    if src.is_dir():
        shutil.copytree(src, dst, dirs_exist_ok=True)
    else:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
    return ok({"src": str(src), "dst": str(dst)})


@handler("fs_move")
def h_fs_move(args, tool):
    src, dst = resolve_path(args["src"]), resolve_path(args["dst"])
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dst))
    return ok({"src": str(src), "dst": str(dst)})


@handler("fs_find_text")
def h_fs_find_text(args, tool):
    root = resolve_path(args.get("root") or ".")
    query = str(args["query"])
    glob = args.get("glob") or "*"
    max_hits = int(args.get("limit") or 50)
    context = int(args.get("context") or 1)
    hits = []
    for p in root.rglob(glob):
        if not p.is_file() or _should_skip_path(p):
            continue
        try:
            if p.stat().st_size > 2_000_000:
                continue
            text = p.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        if query not in text:
            continue
        lines = text.splitlines()
        for i, ln in enumerate(lines):
            if query not in ln:
                continue
            start = max(0, i - context)
            end = min(len(lines), i + context + 1)
            snippet = "\n".join(lines[start:end])
            hits.append(
                {
                    "path": str(p),
                    "line": i + 1,
                    "snippet": snippet[:500],
                }
            )
            if len(hits) >= max_hits:
                return ok(hits, count=len(hits))
    return ok(hits, count=len(hits))


@handler("fs_tree")
def h_fs_tree(args, tool):
    root = resolve_path(args.get("path") or ".")
    depth = int(args.get("depth") or 3)
    lines = []

    def walk(p: Path, d: int, prefix: str = ""):
        if d > depth:
            return
        try:
            kids = sorted(p.iterdir())[:80]
        except Exception:
            return
        for k in kids:
            if k.name in SKIP_DIRS:
                continue
            lines.append(f"{prefix}{k.name}{'/' if k.is_dir() else ''}")
            if k.is_dir():
                walk(k, d + 1, prefix + "  ")

    walk(root, 0)
    return ok("\n".join(lines[:400]))


@handler("fs_hash")
def h_fs_hash(args, tool):
    path = resolve_path(args["path"])
    h = hashlib.sha256(path.read_bytes()).hexdigest()
    return ok({"sha256": h, "path": str(path)})


@handler("fs_touch")
def h_fs_touch(args, tool):
    path = resolve_path(args["path"])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.touch()
    return ok({"path": str(path)})


@handler("fs_which")
def h_fs_which(args, tool):
    return ok({"path": shutil.which(args["name"])})


@handler("fs_list_special")
def h_fs_list_special(args, tool):
    folder = special_folder(tool.get("special", "Workspace"))
    g = args.get("glob") or "*"
    return ok([str(p) for p in folder.glob(g)][:300])


@handler("fs_search_special")
def h_fs_search_special(args, tool):
    folder = special_folder(tool.get("special", "Workspace"))
    return h_fs_find_text({"root": str(folder), "query": args["query"]}, tool)


@handler("shell_powershell")
def h_shell_powershell(args, tool):
    cmd = str(args["command"])
    timeout = int(args.get("timeout_sec") or 120)
    return run_cmd(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", cmd],
        timeout=timeout,
    )


@handler("shell_cmd")
def h_shell_cmd(args, tool):
    return run_cmd(["cmd", "/c", str(args["command"])], timeout=int(args.get("timeout_sec") or 120))


@handler("shell_python")
def h_shell_python(args, tool):
    return run_cmd([sys.executable, "-c", str(args["code"])], timeout=int(args.get("timeout_sec") or 120))


@handler("shell_python_file")
def h_shell_python_file(args, tool):
    path = resolve_path(args["path"])
    extra = str(args.get("args") or "").split()
    return run_cmd([sys.executable, str(path), *extra], timeout=int(args.get("timeout_sec") or 300))


@handler("shell_node")
def h_shell_node(args, tool):
    return run_cmd(["node", "-e", str(args["code"])])


@handler("shell_node_file")
def h_shell_node_file(args, tool):
    path = resolve_path(args["path"])
    extra = str(args.get("args") or "").split()
    return run_cmd(["node", str(path), *extra])


@handler("win_env_get")
def h_win_env_get(args, tool):
    return ok({args["name"]: os.environ.get(str(args["name"]))})


@handler("win_env_set")
def h_win_env_set(args, tool):
    os.environ[str(args["name"])] = str(args["value"])
    return ok(True)


@handler("win_processes")
def h_win_processes(args, tool):
    return h_shell_powershell(
        {"command": f"Get-Process | Sort-Object CPU -Descending | Select-Object -First {int(args.get('limit') or 30)} Name,Id,CPU,WS | ConvertTo-Json"},
        tool,
    )


@handler("win_kill_process")
def h_win_kill_process(args, tool):
    if args.get("pid"):
        return h_shell_powershell({"command": f"Stop-Process -Id {int(args['pid'])} -Force"}, tool)
    if args.get("name"):
        return h_shell_powershell({"command": f"Stop-Process -Name '{args['name']}' -Force -ErrorAction SilentlyContinue"}, tool)
    return err("pid or name required")


@handler("win_clipboard_get")
def h_win_clipboard_get(args, tool):
    return h_shell_powershell({"command": "Get-Clipboard"}, tool)


@handler("win_clipboard_set")
def h_win_clipboard_set(args, tool):
    text = str(args["text"]).replace("'", "''")
    return h_shell_powershell({"command": f"Set-Clipboard -Value '{text}'"}, tool)


@handler("win_notify")
def h_win_notify(args, tool):
    title = str(args["title"]).replace("'", "''")
    msg = str(args["message"]).replace("'", "''")
    ps = (
        "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null; "
        f"New-BurntToastNotification -Text '{title}','{msg}'"
    )
    # fallback message box
    ps2 = f"Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('{msg}','{title}')"
    r = h_shell_powershell({"command": ps}, tool)
    if not r.get("ok") or r.get("data", {}).get("code"):
        return h_shell_powershell({"command": ps2}, tool)
    return r


@handler("win_open_path")
def h_win_open_path(args, tool):
    path = str(args["path"])
    return run_cmd(["cmd", "/c", "start", "", path])


@handler("win_screenshot")
def h_win_screenshot(args, tool):
    out = args.get("path") or str(OUT_DIR / f"shot-{int(time.time())}.png")
    out_path = resolve_path(out)
    code = f"""
import mss, mss.tools
from pathlib import Path
out = Path(r"{out_path}")
with mss.mss() as sct:
    mon = sct.monitors[0]
    img = sct.grab(mon)
    mss.tools.to_png(img.rgb, img.size, output=str(out))
print(out)
"""
    # try mss, else powershell
    r = run_cmd([sys.executable, "-c", code])
    if r.get("ok") and r["data"]["code"] == 0:
        return ok({"path": str(out_path)})
    return h_shell_powershell(
        {
            "command": (
                "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; "
                "$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; "
                "$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; "
                "$g=[System.Drawing.Graphics]::FromImage($bmp); "
                "$g.CopyFromScreen($b.Location,[Drawing.Point]::Empty,$b.Size); "
                f"$bmp.Save('{str(out_path).replace('\\', '\\\\')}'); 'ok'"
            )
        },
        tool,
    )


@handler("win_services_list")
def h_win_services_list(args, tool):
    filt = str(args.get("filter") or "")
    cmd = "Get-Service"
    if filt:
        cmd += f" | Where-Object {{ $_.Name -match '{filt}' -or $_.DisplayName -match '{filt}' }}"
    cmd += " | Select-Object -First 40 Name,Status,DisplayName | ConvertTo-Json"
    return h_shell_powershell({"command": cmd}, tool)


@handler("win_system_info")
def h_win_system_info(args, tool):
    return h_shell_powershell(
        {
            "command": (
                "$os=Get-CimInstance Win32_OperatingSystem; $cpu=Get-CimInstance Win32_Processor; "
                "$gpu=Get-CimInstance Win32_VideoController | Select-Object -First 1; "
                "[pscustomobject]@{OS=$os.Caption; RAMGB=[math]::Round($os.TotalVisibleMemorySize/1MB,1); "
                "CPU=$cpu.Name; GPU=$gpu.Name} | ConvertTo-Json"
            )
        },
        tool,
    )


@handler("win_net_adapters")
def h_win_net_adapters(args, tool):
    return h_shell_powershell({"command": "Get-NetAdapter | Select Name,Status,LinkSpeed | ConvertTo-Json"}, tool)


@handler("win_disk_usage")
def h_win_disk_usage(args, tool):
    return h_shell_powershell(
        {"command": "Get-PSDrive -PSProvider FileSystem | Select Name,Used,Free | ConvertTo-Json"},
        tool,
    )


@handler("win_recipe")
def h_win_recipe(args, tool):
    return h_shell_powershell({"command": tool.get("recipe", "Get-Date")}, tool)


@handler("pkg_pip_install")
def h_pkg_pip_install(args, tool):
    pkgs = str(args["packages"]).split()
    return run_cmd([sys.executable, "-m", "pip", "install", *pkgs], timeout=600)


@handler("pkg_pip_uninstall")
def h_pkg_pip_uninstall(args, tool):
    pkgs = str(args["packages"]).split()
    return run_cmd([sys.executable, "-m", "pip", "uninstall", "-y", *pkgs], timeout=300)


@handler("pkg_pip_list")
def h_pkg_pip_list(args, tool):
    return run_cmd([sys.executable, "-m", "pip", "list"])


@handler("pkg_pip_named")
def h_pkg_pip_named(args, tool):
    return run_cmd([sys.executable, "-m", "pip", "install", tool["package"]], timeout=600)


@handler("pkg_npm_install")
def h_pkg_npm_install(args, tool):
    cwd = str(resolve_path(args.get("cwd") or "."))
    pkgs = str(args.get("packages") or "").split()
    cmd = ["npm", "install"]
    if args.get("global"):
        cmd.append("-g")
    cmd.extend(pkgs)
    return run_cmd(cmd, timeout=600, cwd=cwd)


@handler("pkg_npm_run")
def h_pkg_npm_run(args, tool):
    cwd = str(resolve_path(args.get("cwd") or "."))
    return run_cmd(["npm", "run", str(args["script"])], timeout=600, cwd=cwd)


@handler("pkg_winget_search")
def h_pkg_winget_search(args, tool):
    return run_cmd(["winget", "search", str(args["query"])])


@handler("pkg_winget_install")
def h_pkg_winget_install(args, tool):
    return run_cmd(["winget", "install", "-e", "--id", str(args["id"]), "-h"], timeout=600)


@handler("pkg_choco_install")
def h_pkg_choco_install(args, tool):
    return run_cmd(["choco", "install", *str(args["packages"]).split(), "-y"], timeout=600)


@handler("pkg_uv_pip")
def h_pkg_uv_pip(args, tool):
    return run_cmd(["uv", "pip", "install", *str(args["packages"]).split()], timeout=600)


@handler("pkg_download_url")
def h_pkg_download_url(args, tool):
    path = resolve_path(args["path"])
    path.parent.mkdir(parents=True, exist_ok=True)
    urllib.request.urlretrieve(str(args["url"]), str(path))
    return ok({"path": str(path), "bytes": path.stat().st_size})


@handler("web_fetch")
def h_web_fetch(args, tool):
    return web_get(str(args["url"]), int(args.get("max_chars") or 30000))


@handler("web_fetch_json")
def h_web_fetch_json(args, tool):
    got = web_get(str(args["url"]), 500000)
    if not got.get("ok"):
        return got
    return ok(json.loads(got["data"]["text"]))


@handler("web_post_json")
def h_web_post_json(args, tool):
    data = json.dumps(args["body"]).encode()
    req = urllib.request.Request(
        str(args["url"]),
        data=data,
        headers={"Content-Type": "application/json", "User-Agent": "NeoLocalAI/1.0"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        body = r.read().decode("utf-8", errors="replace")
    return ok({"status": r.status, "body": body[:30000]})


@handler("web_search")
def h_web_search(args, tool):
    return web_search(str(args["query"]), int(args.get("limit") or 5))


@handler("web_search_preset")
def h_web_search_preset(args, tool):
    return web_search(tool.get("query", "neo"), 5)


@handler("web_download")
def h_web_download(args, tool):
    return h_pkg_download_url(args, tool)


@handler("web_headers")
def h_web_headers(args, tool):
    req = urllib.request.Request(str(args["url"]), method="HEAD", headers={"User-Agent": "NeoLocalAI/1.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return ok(dict(r.headers))


@handler("web_ping_host")
def h_web_ping_host(args, tool):
    host = str(args["host"])
    port = int(args.get("port") or 443)
    s = socket.create_connection((host, port), timeout=5)
    s.close()
    return ok({"host": host, "port": port, "open": True})


@handler("code_run_python_test")
def h_code_run_python_test(args, tool):
    path = resolve_path(args.get("path") or ".")
    extra = str(args.get("args") or "").split()
    return run_cmd([sys.executable, "-m", "pytest", str(path), *extra], timeout=300)


@handler("code_run_node_test")
def h_code_run_node_test(args, tool):
    cwd = str(resolve_path(args.get("cwd") or "."))
    return run_cmd(["npm", "test"], timeout=300, cwd=cwd)


@handler("code_syntax_check_python")
def h_code_syntax_check_python(args, tool):
    path = resolve_path(args["path"])
    return run_cmd([sys.executable, "-m", "py_compile", str(path)])


@handler("code_syntax_check_json")
def h_code_syntax_check_json(args, tool):
    path = resolve_path(args["path"])
    json.loads(path.read_text(encoding="utf-8"))
    return ok({"valid": True, "path": str(path)})


@handler("code_format_json")
def h_code_format_json(args, tool):
    path = resolve_path(args["path"])
    obj = json.loads(path.read_text(encoding="utf-8"))
    path.write_text(json.dumps(obj, indent=2), encoding="utf-8")
    return ok({"path": str(path)})


@handler("code_diff")
def h_code_diff(args, tool):
    import difflib

    a = resolve_path(args["a"]).read_text(encoding="utf-8").splitlines()
    b = resolve_path(args["b"]).read_text(encoding="utf-8").splitlines()
    diff = "\n".join(difflib.unified_diff(a, b, fromfile=args["a"], tofile=args["b"]))
    return ok(diff[:30000])


@handler("code_smoke_python")
def h_code_smoke_python(args, tool):
    tmp = Path(tempfile.gettempdir()) / f"neo_smoke_{int(time.time())}.py"
    tmp.write_text(str(args["code"]), encoding="utf-8")
    r = run_cmd([sys.executable, str(tmp)], timeout=120)
    return r


@handler("code_smoke_node")
def h_code_smoke_node(args, tool):
    tmp = Path(tempfile.gettempdir()) / f"neo_smoke_{int(time.time())}.mjs"
    tmp.write_text(str(args["code"]), encoding="utf-8")
    return run_cmd(["node", str(tmp)], timeout=120)


@handler("code_find_todos")
def h_code_find_todos(args, tool):
    return h_fs_find_text({"root": args.get("root") or ".", "query": "TODO", "glob": "*"}, tool)


@handler("code_count_lines")
def h_code_count_lines(args, tool):
    root = resolve_path(args.get("root") or ".")
    counts: dict[str, int] = {}
    for p in root.rglob("*"):
        if p.is_file() and p.stat().st_size < 2_000_000:
            ext = p.suffix.lower() or "[none]"
            try:
                n = len(p.read_text(encoding="utf-8", errors="ignore").splitlines())
            except Exception:
                continue
            counts[ext] = counts.get(ext, 0) + n
    return ok(dict(sorted(counts.items(), key=lambda x: -x[1])[:40]))


@handler("code_git_status")
def h_code_git_status(args, tool):
    return run_cmd(["git", "status", "--short"], cwd=str(resolve_path(args.get("cwd") or ".")))


@handler("code_git_diff")
def h_code_git_diff(args, tool):
    return run_cmd(["git", "diff"], cwd=str(resolve_path(args.get("cwd") or ".")))


@handler("code_git_log")
def h_code_git_log(args, tool):
    n = int(args.get("n") or 15)
    return run_cmd(["git", "log", f"-{n}", "--oneline"], cwd=str(resolve_path(args.get("cwd") or ".")))


@handler("code_git_clone")
def h_code_git_clone(args, tool):
    return run_cmd(["git", "clone", str(args["url"]), str(resolve_path(args["dst"]))], timeout=600)


@handler("code_git_add_commit")
def h_code_git_add_commit(args, tool):
    cwd = str(resolve_path(args.get("cwd") or "."))
    run_cmd(["git", "add", "-A"], cwd=cwd)
    return run_cmd(["git", "commit", "-m", str(args["message"])], cwd=cwd)


@handler("code_git_branch")
def h_code_git_branch(args, tool):
    cwd = str(resolve_path(args.get("cwd") or "."))
    name = args.get("name")
    if name:
        return run_cmd(["git", "branch", str(name)], cwd=cwd)
    return run_cmd(["git", "branch", "-a"], cwd=cwd)


@handler("code_git_checkout")
def h_code_git_checkout(args, tool):
    cwd = str(resolve_path(args.get("cwd") or "."))
    cmd = ["git", "checkout"]
    if args.get("create"):
        cmd.append("-b")
    cmd.append(str(args["branch"]))
    return run_cmd(cmd, cwd=cwd)


@handler("code_git_pull")
def h_code_git_pull(args, tool):
    return run_cmd(["git", "pull"], cwd=str(resolve_path(args.get("cwd") or ".")), timeout=300)


@handler("code_git_push")
def h_code_git_push(args, tool):
    cwd = str(resolve_path(args.get("cwd") or "."))
    cmd = ["git", "push"]
    if args.get("set_upstream"):
        cmd.extend(["-u", "origin", str(args.get("branch") or "HEAD")])
    return run_cmd(cmd, cwd=cwd, timeout=300)


@handler("code_git_show")
def h_code_git_show(args, tool):
    cwd = str(resolve_path(args.get("cwd") or "."))
    return run_cmd(["git", "show", "--stat", str(args.get("ref") or "HEAD")], cwd=cwd)


@handler("code_scaffold_python")
def h_code_scaffold_python(args, tool):
    path = resolve_path(args["path"])
    desc = args.get("description") or "Neo scaffold"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f'"""{desc}"""\n\ndef main():\n    print("hello from neo")\n\nif __name__ == "__main__":\n    main()\n',
        encoding="utf-8",
    )
    return ok({"path": str(path)})


@handler("code_scaffold_html")
def h_code_scaffold_html(args, tool):
    path = resolve_path(args["path"])
    title = args.get("title") or "Neo UI"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>{title}</title>
<style>
:root{{--bg:#120e0b;--ink:#f3e6d4;--accent:#F0A86A;--muted:#9a816a}}
*{{box-sizing:border-box}} body{{margin:0;font-family:ui-sans-serif,system-ui;background:radial-gradient(1200px 600px at 10% -10%,#2a1c14,var(--bg));color:var(--ink);min-height:100vh;display:grid;place-items:center}}
.card{{width:min(720px,92vw);padding:2.5rem;border:1px solid #3d2e22;border-radius:18px;background:#16110dcc;backdrop-filter:blur(8px)}}
h1{{margin:0 0 .5rem;font-size:2.4rem;letter-spacing:.04em}} p{{color:var(--muted);line-height:1.5}}
button{{margin-top:1.2rem;background:var(--accent);color:#1a1008;border:0;padding:.75rem 1.2rem;border-radius:999px;font-weight:700;cursor:pointer}}
</style></head>
<body><main class="card"><h1>{title}</h1><p>Generated by Neo — local AI that ships UI.</p><button onclick="this.textContent='locked in'">Launch</button></main></body></html>
""",
        encoding="utf-8",
    )
    return ok({"path": str(path)})


@handler("code_scaffold_react")
def h_code_scaffold_react(args, tool):
    d = resolve_path(args["dir"])
    d.mkdir(parents=True, exist_ok=True)
    r = run_cmd(
        ["npm", "create", "vite@latest", str(d.name), "--", "--template", "react"],
        timeout=300,
        cwd=str(d.parent),
    )
    if r.get("ok") and r.get("data", {}).get("code") == 0:
        return ok({"path": str(d), "via": "vite"})
    (d / "src").mkdir(parents=True, exist_ok=True)
    (d / "package.json").write_text(
        json.dumps(
            {
                "name": d.name,
                "private": True,
                "version": "0.0.1",
                "type": "module",
                "scripts": {"dev": "vite", "build": "vite build", "preview": "vite preview"},
                "dependencies": {"react": "^18.3.1", "react-dom": "^18.3.1"},
                "devDependencies": {"@vitejs/plugin-react": "^4.3.4", "vite": "^5.4.11"},
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    (d / "vite.config.js").write_text(
        "import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\nexport default defineConfig({ plugins: [react()] })\n",
        encoding="utf-8",
    )
    (d / "index.html").write_text(
        '<!doctype html><html><head><meta charset="UTF-8"/><title>Neo App</title></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>\n',
        encoding="utf-8",
    )
    (d / "src" / "main.jsx").write_text(
        "import React from 'react'\nimport { createRoot } from 'react-dom/client'\nimport App from './App.jsx'\ncreateRoot(document.getElementById('root')).render(<App />)\n",
        encoding="utf-8",
    )
    (d / "src" / "App.jsx").write_text(
        "export default function App() {\n  return <main style={{fontFamily:'system-ui',padding:'2rem'}}><h1>Neo React</h1></main>\n}\n",
        encoding="utf-8",
    )
    return ok({"path": str(d), "via": "manual"})


@handler("code_scaffold_express")
def h_code_scaffold_express(args, tool):
    d = resolve_path(args.get("dir") or "api")
    d.mkdir(parents=True, exist_ok=True)
    (d / "package.json").write_text(
        json.dumps(
            {
                "name": d.name,
                "version": "1.0.0",
                "type": "module",
                "main": "server.js",
                "scripts": {"start": "node server.js", "dev": "node --watch server.js"},
                "dependencies": {"express": "^4.21.2", "cors": "^2.8.5"},
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    (d / "server.js").write_text(
        """import express from 'express';
import cors from 'cors';
const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/api/hello', (_req, res) => res.json({ message: 'hello from neo express' }));
app.listen(PORT, () => console.log(`listening on ${PORT}`));
""",
        encoding="utf-8",
    )
    return ok({"path": str(d), "entry": str(d / "server.js")})


@handler("code_scaffold_fastapi")
def h_code_scaffold_fastapi(args, tool):
    d = resolve_path(args.get("dir") or "api")
    d.mkdir(parents=True, exist_ok=True)
    (d / "main.py").write_text(
        '''from fastapi import FastAPI
app = FastAPI(title="Neo API")

@app.get("/health")
def health():
    return {"ok": True}

@app.get("/api/hello")
def hello():
    return {"message": "hello from neo fastapi"}
''',
        encoding="utf-8",
    )
    (d / "requirements.txt").write_text("fastapi\nuvicorn\n", encoding="utf-8")
    return ok({"path": str(d), "entry": str(d / "main.py"), "run": "uvicorn main:app --reload"})


@handler("code_scaffold_sql_schema")
def h_code_scaffold_sql_schema(args, tool):
    path = resolve_path(args.get("path") or "schema.sql")
    name = str(args.get("table") or "items")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"""-- Neo schema scaffold
CREATE TABLE IF NOT EXISTS {name} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_{name}_name ON {name}(name);
""",
        encoding="utf-8",
    )
    return ok({"path": str(path)})


@handler("code_verify")
def h_code_verify(args, tool):
    root = resolve_path(args.get("cwd") or args.get("path") or ".")
    results = []
    pkg = root / "package.json"
    if pkg.exists():
        results.append({"check": "npm_test", **(run_cmd(["npm", "test"], cwd=str(root), timeout=300).get("data") or {})})
        try:
            data = json.loads(pkg.read_text(encoding="utf-8"))
            main = data.get("main")
            if main and (root / main).exists():
                results.append(
                    {"check": "node_syntax", **(run_cmd(["node", "--check", str(root / main)], cwd=str(root)).get("data") or {})}
                )
        except Exception as e:
            results.append({"check": "package_json", "error": str(e)})
    py_files = [p for p in root.rglob("*.py") if not _should_skip_path(p)][:5]
    for p in py_files:
        r = run_cmd([sys.executable, "-m", "py_compile", str(p)], cwd=str(root))
        results.append({"check": "py_compile", "path": str(p), **(r.get("data") or {})})
    if (root / "pyproject.toml").exists() or (root / "requirements.txt").exists() or list(root.glob("test_*.py")):
        r = run_cmd([sys.executable, "-m", "pytest", "-q"], cwd=str(root), timeout=300)
        results.append({"check": "pytest", **(r.get("data") or {})})
    if not results:
        return ok({"checks": [], "note": "no package.json / python files detected"})
    return ok({"checks": results})


@handler("code_lint_ruff")
def h_code_lint_ruff(args, tool):
    return run_cmd(["ruff", "check", str(resolve_path(args.get("path") or "."))])


@handler("code_bug_scan")
def h_code_bug_scan(args, tool):
    path = resolve_path(args["path"])
    text = path.read_text(encoding="utf-8", errors="ignore")
    findings = []
    rules = [
        (r"except\s*:", "bare except"),
        (r"\beval\(", "eval()"),
        (r"\bexec\(", "exec()"),
        (r"TODO|FIXME", "TODO/FIXME"),
        (r"password\s*=\s*['\"][^'\"]+['\"]", "hardcoded password-like string"),
    ]
    for i, line in enumerate(text.splitlines(), 1):
        for rx, label in rules:
            if re.search(rx, line):
                findings.append({"line": i, "issue": label, "text": line.strip()[:200]})
    return ok(findings[:100])


@handler("code_template")
def h_code_template(args, tool):
    path = resolve_path(args["path"])
    name = tool.get("template", "stub")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f'"""Neo template: {name}"""\n\ndef run():\n    """Implement {name}."""\n    raise NotImplementedError("{name}")\n\nif __name__ == "__main__":\n    print("template {name} ready")\n',
        encoding="utf-8",
    )
    return ok({"path": str(path), "template": name})


def _load_json_file(path: Path, default):
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return default
    return default


def _save_json_file(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


@handler("todo_set")
def h_todo_set(args, tool):
    path = neo_dir() / "todos.json"
    todos = _load_json_file(path, {"items": []})
    items = todos.get("items") or []
    if args.get("items"):
        new_items = []
        for i, it in enumerate(args["items"]):
            if isinstance(it, str):
                new_items.append({"id": str(i + 1), "content": it, "status": "pending"})
            else:
                new_items.append(
                    {
                        "id": str(it.get("id") or (i + 1)),
                        "content": str(it.get("content") or it.get("text") or ""),
                        "status": str(it.get("status") or "pending"),
                    }
                )
        items = new_items
    else:
        tid = str(args.get("id") or (len(items) + 1))
        content = str(args.get("content") or args.get("text") or "")
        status = str(args.get("status") or "pending")
        found = False
        for it in items:
            if str(it.get("id")) == tid:
                if content:
                    it["content"] = content
                it["status"] = status
                found = True
                break
        if not found:
            items.append({"id": tid, "content": content, "status": status})
    todos["items"] = items
    _save_json_file(path, todos)
    st = load_state()
    st["todos"] = items
    save_state(st)
    return ok({"items": items, "path": str(path)})


@handler("todo_list")
def h_todo_list(args, tool):
    path = neo_dir() / "todos.json"
    todos = _load_json_file(path, {"items": []})
    items = todos.get("items") or []
    return ok({"items": items, "pending": sum(1 for i in items if i.get("status") != "done")})


@handler("todo_done")
def h_todo_done(args, tool):
    path = neo_dir() / "todos.json"
    todos = _load_json_file(path, {"items": []})
    tid = str(args.get("id") or "")
    if not tid:
        return err("id required")
    found = False
    for it in todos.get("items") or []:
        if str(it.get("id")) == tid:
            it["status"] = "done"
            found = True
            break
    if not found:
        return err(f"todo not found: {tid}")
    _save_json_file(path, todos)
    st = load_state()
    st["todos"] = todos["items"]
    save_state(st)
    return ok({"items": todos["items"]})


@handler("memory_set")
def h_memory_set(args, tool):
    path = neo_dir() / "memory.json"
    mem = _load_json_file(path, {})
    key = str(args["key"])
    mem[key] = args.get("value")
    _save_json_file(path, mem)
    return ok({"key": key, "path": str(path)})


@handler("memory_get")
def h_memory_get(args, tool):
    path = neo_dir() / "memory.json"
    mem = _load_json_file(path, {})
    key = args.get("key")
    if key is None:
        return ok(mem)
    return ok({"key": key, "value": mem.get(str(key))})


@handler("project_map")
def h_project_map(args, tool):
    root = resolve_path(args.get("path") or ".")
    depth = int(args.get("depth") or 4)
    max_files = int(args.get("limit") or 200)
    exts = {
        ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".json", ".md",
        ".css", ".html", ".sql", ".go", ".rs", ".java", ".cs",
    }
    files: list[str] = []

    def walk(p: Path, d: int):
        if d > depth or len(files) >= max_files:
            return
        try:
            kids = sorted(p.iterdir())
        except Exception:
            return
        for k in kids:
            if k.name in SKIP_DIRS:
                continue
            if k.is_dir() and k.name.startswith(".") and k.name not in {".github"}:
                continue
            if k.is_dir():
                walk(k, d + 1)
            elif k.suffix.lower() in exts or k.name in {"Dockerfile", "Makefile", "AGENTS.md", "NEO.md"}:
                try:
                    files.append(str(k.relative_to(root)))
                except Exception:
                    files.append(str(k))
                if len(files) >= max_files:
                    return

    walk(root, 0)
    return ok({"root": str(root), "files": files, "count": len(files)})


@handler("db_sqlite_query")
def h_db_sqlite_query(args, tool):
    import sqlite3

    path = resolve_path(args.get("path") or args.get("db") or "data.db")
    sql = str(args["sql"])
    params = args.get("params") or []
    conn = sqlite3.connect(str(path))
    try:
        conn.row_factory = sqlite3.Row
        stripped = sql.strip()
        multi = ";" in stripped.rstrip(";")
        if multi and not params:
            conn.executescript(sql)
            conn.commit()
            return ok({"rowcount": -1, "path": str(path), "script": True})
        cur = conn.execute(sql, params if isinstance(params, (list, tuple)) else [])
        if stripped.lower().startswith(("select", "pragma", "with", "explain")):
            rows = [dict(r) for r in cur.fetchall()]
            return ok({"rows": rows, "count": len(rows), "path": str(path)})
        conn.commit()
        return ok({"rowcount": cur.rowcount, "path": str(path)})
    finally:
        conn.close()


@handler("db_sqlite_exec")
def h_db_sqlite_exec(args, tool):
    return h_db_sqlite_query(args, tool)


@handler("db_sqlite_tables")
def h_db_sqlite_tables(args, tool):
    return h_db_sqlite_query(
        {
            "path": args.get("path") or args.get("db") or "data.db",
            "sql": "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        },
        tool,
    )


@handler("db_sqlite_schema")
def h_db_sqlite_schema(args, tool):
    import sqlite3

    path = resolve_path(args.get("path") or args.get("db") or "data.db")
    table = args.get("table")
    conn = sqlite3.connect(str(path))
    try:
        if table:
            cur = conn.execute(f"PRAGMA table_info({table})")
            cols = [
                {"cid": r[0], "name": r[1], "type": r[2], "notnull": r[3], "dflt": r[4], "pk": r[5]}
                for r in cur.fetchall()
            ]
            return ok({"table": table, "columns": cols, "path": str(path)})
        cur = conn.execute("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name")
        return ok({"tables": [{"name": r[0], "sql": r[1]} for r in cur.fetchall()], "path": str(path)})
    finally:
        conn.close()


@handler("db_postgres_query")
def h_db_postgres_query(args, tool):
    sql = str(args["sql"])
    url = args.get("url") or os.environ.get("DATABASE_URL") or ""
    if shutil.which("psql"):
        cmd = ["psql"]
        if url:
            cmd.extend([url, "-c", sql])
        else:
            cmd.extend(["-c", sql])
            if args.get("db"):
                cmd.extend(["-d", str(args["db"])])
        return run_cmd(cmd, timeout=120)
    try:
        import psycopg2  # type: ignore
    except Exception:
        return err("psql not found and psycopg2 not installed")
    conn = psycopg2.connect(url or args.get("dsn"))
    try:
        cur = conn.cursor()
        cur.execute(sql)
        if cur.description:
            cols = [d[0] for d in cur.description]
            rows = [dict(zip(cols, r)) for r in cur.fetchall()]
            return ok({"rows": rows, "count": len(rows)})
        conn.commit()
        return ok({"rowcount": cur.rowcount})
    finally:
        conn.close()


@handler("db_mysql_query")
def h_db_mysql_query(args, tool):
    sql = str(args["sql"])
    if not shutil.which("mysql"):
        return err("mysql CLI not found on PATH")
    cmd = ["mysql", "-e", sql]
    if args.get("db"):
        cmd.extend(["-D", str(args["db"])])
    if args.get("user"):
        cmd.extend(["-u", str(args["user"])])
    if args.get("password"):
        cmd.append(f"-p{args['password']}")
    if args.get("host"):
        cmd.extend(["-h", str(args["host"])])
    return run_cmd(cmd, timeout=120)


@handler("db_mongo_query")
def h_db_mongo_query(args, tool):
    if not shutil.which("mongosh"):
        return err("mongosh not found on PATH")
    eval_js = str(args.get("eval") or args.get("js") or args.get("sql") or "")
    cmd = ["mongosh", "--quiet", "--eval", eval_js]
    if args.get("uri"):
        cmd.insert(1, str(args["uri"]))
    return run_cmd(cmd, timeout=120)


@handler("image_generate")
def h_image_generate(args, tool):
    st = load_state()
    prompt = str(args["prompt"])
    style = str(args.get("style") or "cinematic, ultra detailed, coherent design, accurate composition")
    full = f"{prompt}, {style}"
    exact = str(args.get("exact_text") or "")
    payload = {
        "prompt": full,
        "width": int(args.get("width") or 768),
        "height": int(args.get("height") or 768),
        "steps": int(args.get("steps") or 4),
        "exact_text": exact,
    }
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"{IMAGE_DAEMON}/generate",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            body = json.loads(r.read().decode())
    except Exception as e:
        return err(f"image daemon unavailable ({e}). Start: npm run image-daemon")
    st["last_image_prompt"] = full
    st["last_image_path"] = body.get("path")
    save_state(st)
    return ok(body)


@handler("image_edit_prompt")
def h_image_edit_prompt(args, tool):
    st = load_state()
    base = st.get("last_image_prompt") or "a scene"
    return h_image_generate({"prompt": f"{base}. Change: {args['instruction']}"}, tool)


@handler("image_open")
def h_image_open(args, tool):
    return h_win_open_path({"path": str(resolve_path(args["path"]))}, tool)


@handler("image_info")
def h_image_info(args, tool):
    try:
        from PIL import Image

        path = resolve_path(args["path"])
        im = Image.open(path)
        return ok({"path": str(path), "size": im.size, "format": im.format, "mode": im.mode})
    except Exception as e:
        return err(str(e))


@handler("image_overlay_text")
def h_image_overlay_text(args, tool):
    from PIL import Image, ImageDraw, ImageFont

    path = resolve_path(args["path"])
    out = resolve_path(args["out"]) if args.get("out") else path.with_name(path.stem + "-text.png")
    im = Image.open(path).convert("RGBA")
    draw = ImageDraw.Draw(im)
    text = str(args["text"])
    # large default font
    try:
        font = ImageFont.truetype("arial.ttf", size=max(24, im.width // 18))
    except Exception:
        font = ImageFont.load_default()
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    x = (im.width - tw) // 2
    y = (im.height - th) // 2
    # shadow + text for legibility
    draw.text((x + 2, y + 2), text, fill=(0, 0, 0, 200), font=font)
    draw.text((x, y), text, fill=(255, 245, 230, 255), font=font)
    im.save(out)
    return ok({"path": str(out)})


@handler("design_critique")
def h_design_critique(args, tool):
    brief = args["brief"]
    return ok(
        {
            "hierarchy": "One hero idea, one supporting line, one CTA.",
            "type": "Expressive display + readable body; avoid Inter/Roboto defaults.",
            "color": "Define 4 tokens: bg, ink, accent, mute. Avoid purple-on-white cliché.",
            "layout": "First viewport = one composition, not a dashboard.",
            "motion": "2–3 intentional motions max.",
            "brief": brief,
        }
    )


@handler("design_palette")
def h_design_palette(args, tool):
    return ok(
        {
            "bg": "#120e0b",
            "surface": "#1a1410",
            "ink": "#f3e6d4",
            "accent": "#F0A86A",
            "mute": "#9a816a",
            "line": "#3d2e22",
            "brief": args["brief"],
        }
    )


@handler("mcp_list_local")
def h_mcp_list_local(args, tool):
    root = resolve_path(args.get("root") or ".")
    hits = [str(p) for p in root.rglob("*mcp*") if p.is_file()][:100]
    return ok(hits)


@handler("mcp_install_npm")
def h_mcp_install_npm(args, tool):
    cwd = str(resolve_path(args.get("cwd") or "."))
    return run_cmd(["npm", "install", str(args["package"])], timeout=600, cwd=cwd)


@handler("mcp_write_config")
def h_mcp_write_config(args, tool):
    path = resolve_path(args["path"])
    path.parent.mkdir(parents=True, exist_ok=True)
    cfg = {}
    if path.exists():
        try:
            cfg = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            cfg = {}
    servers = cfg.setdefault("mcpServers", {})
    servers[str(args["name"])] = {"command": str(args["command"]), "args": args.get("args") or []}
    path.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    return ok({"path": str(path)})


@handler("model_ollama_list")
def h_model_ollama_list(args, tool):
    got = web_get("http://127.0.0.1:11434/api/tags", 200000)
    if not got.get("ok"):
        return got
    models = json.loads(got["data"]["text"]).get("models", [])
    return ok([m.get("name") for m in models])


@handler("model_ollama_pull")
def h_model_ollama_pull(args, tool):
    return run_cmd(["ollama", "pull", str(args["name"])], timeout=3600)


@handler("model_ollama_run_prompt")
def h_model_ollama_run_prompt(args, tool):
    payload = json.dumps({"model": args["model"], "prompt": args["prompt"], "stream": False}).encode()
    req = urllib.request.Request(
        "http://127.0.0.1:11434/api/generate",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        body = json.loads(r.read().decode())
    return ok({"response": body.get("response", "")[:8000]})


@handler("model_switch_text")
def h_model_switch_text(args, tool):
    st = load_state()
    st["text_model"] = str(args["model"])
    save_state(st)
    return ok(st)


@handler("model_capabilities")
def h_model_capabilities(args, tool):
    return ok(
        {
            "text": "Neo local GGUF brain (llama.cpp) — neo-brain default; Ollama optional via NEO_USE_OLLAMA=1",
            "image": "Warm SD-Turbo daemon + exact_text overlay for perfect typography",
            "vision": "optional via separate vision GGUF / Ollama if configured",
            "code": "python/node smoke, git, scaffolds, bug scan, chunked writes, apply_patch",
            "web": "fetch/search/download",
            "windows": "powershell/cmd/services/clipboard/screenshot",
            "packages": "pip/npm/winget/choco",
            "mcp": "install + write write",
            "tools_total": CATALOG["count"],
        }
    )


@handler("util_echo")
def h_util_echo(args, tool):
    return ok({"message": args.get("message", "neo")})


MODE_ALLOW = {
    "plan": {"meta", "web", "design", "image"},  # image blocked in executor for plan
    "code": {"meta", "fs", "code", "pkg", "web", "win", "mcp", "util", "db", "agent"},
    "work": None,  # all
}


def execute(name: str, args: dict | None = None, allow_meta: bool = True) -> dict:
    args = args or {}
    tool = BY_NAME.get(name)
    if not tool:
        # Allow executing registered handlers even if catalog lags (dev)
        if name in HANDLERS:
            try:
                return HANDLERS[name](args, {"name": name, "handler": name, "category": "util"})
            except Exception as e:
                return err(str(e))
        return err(f"unknown tool: {name}")
    st = load_state()
    mode = st.get("mode", "work")
    allowed = MODE_ALLOW.get(mode)
    plan_ok = {
        "design_critique",
        "design_palette",
        "get_status",
        "search_tools",
        "list_categories",
        "set_mode",
        "model_capabilities",
        "todo_set",
        "todo_list",
        "todo_done",
        "memory_set",
        "memory_get",
        "project_map",
        "project_set_root",
    }
    if mode == "plan" and tool["category"] not in {"meta", "web", "agent"} and tool["handler"] not in plan_ok:
        return err("PLAN mode is text/planning only. Switch to work/code to execute.")
    if allowed is not None and tool["category"] not in allowed and name not in {
        "search_tools",
        "call_tool",
        "set_mode",
        "get_status",
        "list_categories",
    }:
        return err(f"Tool category '{tool['category']}' blocked in {mode} mode")
    if name == "call_tool" and not allow_meta:
        return err("nested call_tool blocked")
    fn = HANDLERS.get(tool["handler"])
    if not fn:
        return err(f"handler missing: {tool['handler']}")
    try:
        return fn(args, tool)
    except Exception as e:
        return err(str(e))


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(json.dumps({"ok": False, "error": "usage: executor.py <tool> [json-args]"}))
        return 2
    name = argv[1]
    args = json.loads(argv[2]) if len(argv) > 2 else {}
    print(json.dumps(execute(name, args), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
