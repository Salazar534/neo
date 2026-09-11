"""Cross-platform Neo data directories (Windows / macOS / Linux)."""

from __future__ import annotations

import os
import sys
from pathlib import Path


def data_root() -> Path:
    env = os.environ.get("NEO_HOME")
    if env:
        return Path(env)
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "Neo"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Neo"
    xdg = os.environ.get("XDG_DATA_HOME")
    if xdg:
        return Path(xdg) / "neo"
    return Path.home() / ".local" / "share" / "neo"


def models_dir() -> Path:
    return data_root() / "models"


def default_db_path() -> Path:
    cfg_path = data_root() / "config.json"
    if cfg_path.is_file():
        try:
            import json

            cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
            if cfg.get("db_path"):
                return Path(cfg["db_path"])
        except Exception:
            pass
    return data_root() / "neo.db"
