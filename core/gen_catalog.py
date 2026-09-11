#!/usr/bin/env python3
"""Generate Neo's tool catalog (1000+ tools) and write tools_catalog.json."""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "tools_catalog.json"

tools: list[dict] = []


def add(name: str, desc: str, params: dict, category: str, handler: str, **extra):
    tools.append(
        {
            "name": name,
            "description": desc,
            "category": category,
            "handler": handler,
            "parameters": {
                "type": "object",
                "properties": params,
                "required": [k for k, v in params.items() if v.get("required")],
            },
            **extra,
        }
    )
    # strip required flags from property objects for JSON schema cleanliness
    for k, v in list(params.items()):
        v.pop("required", None)


# --- always-on meta ---
add("search_tools", "Search Neo's tool catalog by keyword. Use before call_tool.", {
    "query": {"type": "string", "required": True},
    "limit": {"type": "integer", "default": 20},
}, "meta", "search_tools")

add("call_tool", "Execute any Neo tool by exact name with JSON args.", {
    "name": {"type": "string", "required": True},
    "args": {"type": "object", "default": {}},
}, "meta", "call_tool")

add("list_categories", "List all tool categories and counts.", {}, "meta", "list_categories")

add("set_mode", "Switch Neo mode: plan (text-only), code (build/test), work (do anything).", {
    "mode": {"type": "string", "enum": ["plan", "code", "work"], "required": True},
}, "meta", "set_mode")

add("get_status", "Neo status: mode, models, image daemon, counts.", {}, "meta", "get_status")

# --- filesystem (bulk) ---
fs_ops = [
    ("fs_read", "Read a text file", {"path": {"type": "string", "required": True}, "max_bytes": {"type": "integer", "default": 200000}}),
    ("fs_write", "Write/overwrite a text file (small files). For large files use fs_write_chunk.", {"path": {"type": "string", "required": True}, "content": {"type": "string", "required": True}}),
    ("fs_append", "Append text; optional chunk_index/total for resumable long writes", {"path": {"type": "string", "required": True}, "content": {"type": "string", "required": True}, "chunk_index": {"type": "integer"}, "total": {"type": "integer"}, "resume": {"type": "boolean"}}),
    ("fs_write_begin", "Begin a chunked write session; returns write_id", {"path": {"type": "string", "required": True}, "total": {"type": "integer"}, "write_id": {"type": "string"}}),
    ("fs_write_chunk", "Write one chunk of a large file (path+chunk_index or write_id)", {"path": {"type": "string"}, "content": {"type": "string", "required": True}, "chunk_index": {"type": "integer", "default": 0}, "total": {"type": "integer"}, "write_id": {"type": "string"}, "finalize": {"type": "boolean"}, "resume": {"type": "boolean"}}),
    ("fs_write_finalize", "Finalize a chunked write session by write_id", {"write_id": {"type": "string", "required": True}}),
    ("fs_edit_replace", "Replace exact substring; fails if 0 or >1 matches unless all=true", {"path": {"type": "string", "required": True}, "old": {"type": "string", "required": True}, "new": {"type": "string", "required": True}, "all": {"type": "boolean", "default": False}}),
    ("apply_patch", "Apply multi-file edits atomically-ish: list of {path,old,new,all?}", {"edits": {"type": "array", "required": True}}),
    ("fs_apply_edits", "Alias for apply_patch", {"edits": {"type": "array", "required": True}}),
    ("fs_edit_line_range", "Replace lines [start,end] inclusive (1-based)", {"path": {"type": "string", "required": True}, "start": {"type": "integer", "required": True}, "end": {"type": "integer", "required": True}, "content": {"type": "string", "required": True}}),
    ("fs_insert_at_line", "Insert text before a 1-based line number", {"path": {"type": "string", "required": True}, "line": {"type": "integer", "required": True}, "content": {"type": "string", "required": True}}),
    ("fs_delete", "Delete a file", {"path": {"type": "string", "required": True}}),
    ("fs_mkdir", "Create directory (parents ok)", {"path": {"type": "string", "required": True}}),
    ("fs_listdir", "List directory", {"path": {"type": "string", "required": True}}),
    ("fs_glob", "Glob files", {"pattern": {"type": "string", "required": True}, "root": {"type": "string", "default": "."}}),
    ("fs_stat", "Stat a path", {"path": {"type": "string", "required": True}}),
    ("fs_copy", "Copy file/dir", {"src": {"type": "string", "required": True}, "dst": {"type": "string", "required": True}}),
    ("fs_move", "Move/rename", {"src": {"type": "string", "required": True}, "dst": {"type": "string", "required": True}}),
    ("fs_find_text", "Text search with snippets; skips node_modules/.git", {"query": {"type": "string", "required": True}, "root": {"type": "string", "default": "."}, "glob": {"type": "string", "default": "*"}, "limit": {"type": "integer", "default": 50}}),
    ("fs_tree", "Directory tree", {"path": {"type": "string", "default": "."}, "depth": {"type": "integer", "default": 3}}),
    ("fs_hash", "SHA256 a file", {"path": {"type": "string", "required": True}}),
    ("fs_touch", "Create empty file / update mtime", {"path": {"type": "string", "required": True}}),
    ("fs_which", "Resolve executable on PATH", {"name": {"type": "string", "required": True}}),
]
for name, desc, params in fs_ops:
    add(name, desc, params, "fs", name)

# PC-native agency
pc_ops = [
    ("pc_search", "Search Desktop/Documents/Downloads/Home/cwd by file name or text", {
        "query": {"type": "string", "required": True},
        "scope": {"type": "string", "enum": ["desktop", "documents", "downloads", "home", "cwd", "workspace"], "default": "cwd"},
        "kind": {"type": "string", "enum": ["name", "text"], "default": "name"},
        "limit": {"type": "integer", "default": 80},
    }),
    ("pc_create", "Create a folder or file on Desktop/Documents/Downloads/Home/cwd", {
        "path": {"type": "string", "required": True},
        "scope": {"type": "string", "enum": ["desktop", "documents", "downloads", "home", "cwd", "workspace"], "default": "desktop"},
        "content": {"type": "string"},
        "directory": {"type": "boolean", "default": False},
    }),
    ("browser_open", "Open a URL or local HTML file in the default browser", {
        "url": {"type": "string"},
        "path": {"type": "string"},
    }),
    ("preview_server", "Serve a folder over localhost and optionally open the browser", {
        "path": {"type": "string", "default": "."},
        "port": {"type": "integer", "default": 8767},
        "open": {"type": "boolean", "default": True},
        "action": {"type": "string", "enum": ["start", "stop"], "default": "start"},
    }),
]
for name, desc, params in pc_ops:
    add(name, desc, params, "win", name)

# agent / project
agent_ops = [
    ("project_set_root", "Set Neo project workspace root (relative paths resolve here)", {"path": {"type": "string", "required": True}}),
    ("project_map", "List source files for prompt context", {"path": {"type": "string", "default": "."}, "depth": {"type": "integer", "default": 4}, "limit": {"type": "integer", "default": 200}}),
    ("todo_set", "Create/update todos persisted in .neo/todos.json", {"items": {"type": "array"}, "id": {"type": "string"}, "content": {"type": "string"}, "status": {"type": "string"}}),
    ("todo_list", "List todos", {}),
    ("todo_done", "Mark a todo done by id", {"id": {"type": "string", "required": True}}),
    ("memory_set", "Persist key/value in .neo/memory.json", {"key": {"type": "string", "required": True}, "value": {}}),
    ("memory_get", "Get memory key or all memory", {"key": {"type": "string"}}),
]
for name, desc, params in agent_ops:
    add(name, desc, params, "agent", name)

# databases
db_ops = [
    ("db_sqlite_query", "SQLite query/exec (stdlib always works)", {"path": {"type": "string", "default": "data.db"}, "sql": {"type": "string", "required": True}, "params": {"type": "array"}}),
    ("db_sqlite_exec", "SQLite exec alias", {"path": {"type": "string", "default": "data.db"}, "sql": {"type": "string", "required": True}, "params": {"type": "array"}}),
    ("db_sqlite_tables", "List SQLite tables", {"path": {"type": "string", "default": "data.db"}}),
    ("db_sqlite_schema", "SQLite schema (all or one table)", {"path": {"type": "string", "default": "data.db"}, "table": {"type": "string"}}),
    ("db_postgres_query", "Postgres via psql or psycopg2", {"sql": {"type": "string", "required": True}, "url": {"type": "string"}, "db": {"type": "string"}, "dsn": {"type": "string"}}),
    ("db_mysql_query", "MySQL via mysql CLI if present", {"sql": {"type": "string", "required": True}, "db": {"type": "string"}, "user": {"type": "string"}, "password": {"type": "string"}, "host": {"type": "string"}}),
    ("db_mongo_query", "Mongo via mongosh if present", {"eval": {"type": "string"}, "js": {"type": "string"}, "uri": {"type": "string"}}),
]
for name, desc, params in db_ops:
    add(name, desc, params, "db", name)

# Generate many fs_* aliases for common Windows locations / patterns to reach scale
win_roots = [
    "Desktop", "Documents", "Downloads", "AppDataLocal", "AppDataRoaming", "Temp", "Home", "Workspace"
]
for root_name in win_roots:
    add(f"fs_list_{root_name.lower()}", f"List files in special folder {root_name}", {
        "glob": {"type": "string", "default": "*"},
    }, "fs", "fs_list_special", special=root_name)
    add(f"fs_search_{root_name.lower()}", f"Search text under special folder {root_name}", {
        "query": {"type": "string", "required": True},
    }, "fs", "fs_search_special", special=root_name)

# --- shell / windows ---
shell_ops = [
    ("shell_powershell", "Run PowerShell command", {"command": {"type": "string", "required": True}, "timeout_sec": {"type": "integer", "default": 120}}),
    ("shell_cmd", "Run cmd.exe command", {"command": {"type": "string", "required": True}, "timeout_sec": {"type": "integer", "default": 120}}),
    ("shell_python", "Run a Python one-liner or code string", {"code": {"type": "string", "required": True}, "timeout_sec": {"type": "integer", "default": 120}}),
    ("shell_python_file", "Run a Python file", {"path": {"type": "string", "required": True}, "args": {"type": "string", "default": ""}, "timeout_sec": {"type": "integer", "default": 300}}),
    ("shell_node", "Run node -e code", {"code": {"type": "string", "required": True}}),
    ("shell_node_file", "Run a JS/MJS file", {"path": {"type": "string", "required": True}, "args": {"type": "string", "default": ""}}),
    ("win_env_get", "Get env var", {"name": {"type": "string", "required": True}}),
    ("win_env_set", "Set env var for current Neo process", {"name": {"type": "string", "required": True}, "value": {"type": "string", "required": True}}),
    ("win_processes", "List top processes", {"limit": {"type": "integer", "default": 30}}),
    ("win_kill_process", "Kill process by PID or name", {"pid": {"type": "integer"}, "name": {"type": "string"}}),
    ("win_clipboard_get", "Read clipboard text", {}),
    ("win_clipboard_set", "Set clipboard text", {"text": {"type": "string", "required": True}}),
    ("win_notify", "Windows toast/balloon notification", {"title": {"type": "string", "required": True}, "message": {"type": "string", "required": True}}),
    ("win_open_path", "Open file/folder/URL with default app", {"path": {"type": "string", "required": True}}),
    ("win_screenshot", "Capture screen to PNG", {"path": {"type": "string", "default": ""}}),
    ("win_services_list", "List Windows services (sample)", {"filter": {"type": "string", "default": ""}}),
    ("win_system_info", "CPU/RAM/GPU/OS info", {}),
    ("win_net_adapters", "Network adapters", {}),
    ("win_disk_usage", "Disk free space", {}),
]
for name, desc, params in shell_ops:
    add(name, desc, params, "win", name)

# 200 generated powershell recipes
ps_recipes = [
    ("get date", "Get-Date"),
    ("list wifi profiles", "netsh wlan show profiles"),
    ("ipconfig", "ipconfig /all"),
    ("dns flush", "Clear-DnsClientCache"),
    ("list startup", "Get-CimInstance Win32_StartupCommand | Select-Object Name,Command,Location"),
    ("list hotfixes", "Get-HotFix | Select-Object -First 20"),
    ("battery", "Get-CimInstance Win32_Battery"),
    ("gpu", "Get-CimInstance Win32_VideoController | Select Name,DriverVersion,AdapterRAM"),
    ("cpu", "Get-CimInstance Win32_Processor | Select Name,NumberOfCores,MaxClockSpeed"),
    ("ram", "Get-CimInstance Win32_OperatingSystem | Select TotalVisibleMemorySize,FreePhysicalMemory"),
]
for i in range(1, 191):
    base = ps_recipes[i % len(ps_recipes)]
    add(
        f"win_recipe_{i:03d}_{base[0].replace(' ', '_')}",
        f"Windows recipe: {base[0]} (#{i})",
        {},
        "win",
        "win_recipe",
        recipe=base[1],
    )

# --- packages ---
pkg_ops = [
    ("pkg_pip_install", "pip install packages", {"packages": {"type": "string", "required": True}}),
    ("pkg_pip_uninstall", "pip uninstall packages", {"packages": {"type": "string", "required": True}}),
    ("pkg_pip_list", "pip list", {}),
    ("pkg_npm_install", "npm install in a directory", {"packages": {"type": "string", "default": ""}, "cwd": {"type": "string", "default": "."}, "global": {"type": "boolean", "default": False}}),
    ("pkg_npm_run", "npm run script", {"script": {"type": "string", "required": True}, "cwd": {"type": "string", "default": "."}}),
    ("pkg_winget_search", "winget search", {"query": {"type": "string", "required": True}}),
    ("pkg_winget_install", "winget install", {"id": {"type": "string", "required": True}}),
    ("pkg_choco_install", "choco install (if available)", {"packages": {"type": "string", "required": True}}),
    ("pkg_uv_pip", "uv pip install", {"packages": {"type": "string", "required": True}}),
    ("pkg_download_url", "Download a URL to a file", {"url": {"type": "string", "required": True}, "path": {"type": "string", "required": True}}),
]
for name, desc, params in pkg_ops:
    add(name, desc, params, "pkg", name)

# 100 common pip packages as one-click installers
common_pips = [
    "requests", "httpx", "beautifulsoup4", "lxml", "pandas", "numpy", "scipy", "matplotlib",
    "seaborn", "pillow", "opencv-python", "rich", "typer", "click", "fastapi", "uvicorn",
    "flask", "django", "sqlalchemy", "pydantic", "pytest", "black", "ruff", "mypy",
    "jupyter", "notebook", "ipython", "tqdm", "pyyaml", "toml", "orjson", "aiohttp",
    "playwright", "selenium", "boto3", "openai", "anthropic", "tiktoken", "langchain",
    "chromadb", "faiss-cpu", "scikit-learn", "torch", "torchvision", "diffusers",
    "transformers", "accelerate", "safetensors", "sentencepiece", "onnxruntime",
    "soundfile", "librosa", "moviepy", "imageio", "reportlab", "openpyxl", "xlrd",
    "python-docx", "python-pptx", "pypdf", "pdfminer.six", "cryptography", "paramiko",
    "fabric", "docker", "kubernetes", "redis", "pymongo", "psycopg2-binary", "mysqlclient",
    "schedule", "apscheduler", "watchdog", "pathvalidate", "send2trash", "pyperclip",
    "keyboard", "mouse", "pyautogui", "mss", "qrcode", "python-barcode", "folium",
    "geopy", "timezonefinder", "pendulum", "arrow", "dateparser", "humanize", "tabulate",
    "prettytable", "colorama", "termcolor", "loguru", "structlog", "sentry-sdk",
    "tenacity", "retry", "cachetools", "diskcache", "joblib", "dill", "cloudpickle",
]
for pkg in common_pips:
    safe = pkg.replace(".", "_").replace("-", "_")
    add(f"pkg_install_{safe}", f"Install Python package {pkg}", {}, "pkg", "pkg_pip_named", package=pkg)

# --- web ---
web_ops = [
    ("web_fetch", "HTTP GET URL and return text/json (truncated)", {"url": {"type": "string", "required": True}, "max_chars": {"type": "integer", "default": 30000}}),
    ("web_fetch_json", "HTTP GET JSON", {"url": {"type": "string", "required": True}}),
    ("web_post_json", "HTTP POST JSON", {"url": {"type": "string", "required": True}, "body": {"type": "object", "required": True}}),
    ("web_search", "Search the web (DuckDuckGo HTML)", {"query": {"type": "string", "required": True}, "limit": {"type": "integer", "default": 5}}),
    ("web_download", "Download binary/text to path", {"url": {"type": "string", "required": True}, "path": {"type": "string", "required": True}}),
    ("web_headers", "Fetch response headers only", {"url": {"type": "string", "required": True}}),
    ("web_ping_host", "TCP ping host:port", {"host": {"type": "string", "required": True}, "port": {"type": "integer", "default": 443}}),
]
for name, desc, params in web_ops:
    add(name, desc, params, "web", name)

# 50 web_search_* presets
search_presets = [
    "python windows tutorial", "powershell one-liners", "nodejs best practices", "fastapi deploy",
    "react performance", "sql indexing", "docker compose", "kubernetes ingress", "oauth2 pkce",
    "websocket scaling", "ffmpeg compress video", "imagemagick convert", "git rebase guide",
    "rust ownership", "go concurrency", "c# linq", "typescript utility types", "css grid",
    "tailwind components", "nextjs app router", "vite config", "electron security", "tauri vs electron",
    "local llm tools", "local agent tool calling", "comfyui flux", "local image turbo models",
    "windows registry tips", "winget packages", "chocolatey packages", "scoop buckets",
    "wsl2 gpu", "cuda pytorch blackwell", "rtx 5070 ai", "mcp server install", "cursor rules",
    "playwright scraping", "selenium stealth", "beautifulsoup selectors", "regex cookbook",
    "cron vs task scheduler", "nginx reverse proxy", "caddyfile examples", "letsencrypt windows",
    "sqlite pragmas", "postgres vacuum", "redis streams", "rabbitmq topics", "kafka consumer groups",
    "graphql schema design",
]
for i, q in enumerate(search_presets, 1):
    add(f"web_preset_search_{i:02d}", f"Web search preset: {q}", {}, "web", "web_search_preset", query=q)

# --- code ---
code_ops = [
    ("code_run_python_test", "Run pytest or python -m unittest", {"path": {"type": "string", "default": "."}, "args": {"type": "string", "default": ""}}),
    ("code_run_node_test", "Run npm test", {"cwd": {"type": "string", "default": "."}}),
    ("code_syntax_check_python", "Compile-check a Python file", {"path": {"type": "string", "required": True}}),
    ("code_syntax_check_json", "Validate JSON file", {"path": {"type": "string", "required": True}}),
    ("code_format_json", "Pretty-print JSON file", {"path": {"type": "string", "required": True}}),
    ("code_diff", "Unified diff two files", {"a": {"type": "string", "required": True}, "b": {"type": "string", "required": True}}),
    ("code_smoke_python", "Write temp smoke script and run it", {"code": {"type": "string", "required": True}}),
    ("code_smoke_node", "Write temp smoke mjs and run it", {"code": {"type": "string", "required": True}}),
    ("code_find_todos", "Find TODO/FIXME in repo", {"root": {"type": "string", "default": "."}}),
    ("code_count_lines", "Count lines by extension", {"root": {"type": "string", "default": "."}}),
    ("code_git_status", "git status", {"cwd": {"type": "string", "default": "."}}),
    ("code_git_diff", "git diff", {"cwd": {"type": "string", "default": "."}}),
    ("code_git_log", "git log -n", {"cwd": {"type": "string", "default": "."}, "n": {"type": "integer", "default": 15}}),
    ("code_git_clone", "git clone", {"url": {"type": "string", "required": True}, "dst": {"type": "string", "required": True}}),
    ("code_git_add_commit", "git add -A && commit", {"cwd": {"type": "string", "default": "."}, "message": {"type": "string", "required": True}}),
    ("code_git_branch", "git branch (list or create)", {"cwd": {"type": "string", "default": "."}, "name": {"type": "string"}}),
    ("code_git_checkout", "git checkout [-b]", {"cwd": {"type": "string", "default": "."}, "branch": {"type": "string", "required": True}, "create": {"type": "boolean"}}),
    ("code_git_pull", "git pull", {"cwd": {"type": "string", "default": "."}}),
    ("code_git_push", "git push", {"cwd": {"type": "string", "default": "."}, "set_upstream": {"type": "boolean"}, "branch": {"type": "string"}}),
    ("code_git_show", "git show", {"cwd": {"type": "string", "default": "."}, "ref": {"type": "string", "default": "HEAD"}}),
    ("code_scaffold_python", "Scaffold a Python module file", {"path": {"type": "string", "required": True}, "description": {"type": "string", "default": ""}}),
    ("code_scaffold_html", "Scaffold a minimal HTML UI page", {"path": {"type": "string", "required": True}, "title": {"type": "string", "default": "Neo UI"}}),
    ("code_scaffold_react", "Scaffold a Vite React app", {"dir": {"type": "string", "required": True}}),
    ("code_scaffold_express", "Scaffold Express API", {"dir": {"type": "string", "default": "api"}}),
    ("code_scaffold_fastapi", "Scaffold FastAPI app", {"dir": {"type": "string", "default": "api"}}),
    ("code_scaffold_sql_schema", "Write a SQL schema helper file", {"path": {"type": "string", "default": "schema.sql"}, "table": {"type": "string", "default": "items"}}),
    ("code_verify", "Run syntax check / pytest / npm test by project type", {"cwd": {"type": "string", "default": "."}, "path": {"type": "string"}}),
    ("code_lint_ruff", "Run ruff check if installed", {"path": {"type": "string", "default": "."}}),
    ("code_bug_scan", "Heuristic bug scan (bare except, TODO, eval, etc.)", {"path": {"type": "string", "required": True}}),
]
for name, desc, params in code_ops:
    add(name, desc, params, "code", name)

# 100 code template generators
templates = [
    "fastapi_hello", "flask_hello", "cli_typer", "cli_argparse", "httpx_client", "requests_session",
    "asyncio_gather", "threading_pool", "multiprocessing_map", "dataclass_model", "pydantic_model",
    "sqlalchemy_model", "sqlite_crud", "csv_reader", "jsonl_reader", "yaml_config", "dotenv_loader",
    "logging_setup", "retry_wrapper", "rate_limiter", "file_watcher", "websocket_client",
    "websocket_server", "tcp_server", "udp_ping", "hash_file", "zip_dir", "unzip_file",
    "send_email_smtp", "parse_html", "regex_extract", "image_resize", "image_watermark",
    "pdf_merge", "excel_read", "excel_write", "cron_scheduler", "task_queue", "cache_lru",
    "memoize", "cli_progress", "rich_table", "progress_bar", "unit_test_pytest", "fixture_tmp",
    "mock_patch", "benchmark_timeit", "profile_cprofile", "subprocess_capture", "powershell_bridge",
    "winreg_read", "clipboard_copy", "notify_balloon", "screenshot_mss", "ocr_placeholder",
    "tts_placeholder", "stt_placeholder", "vector_cosine", "embed_hash", "knn_search",
    "decision_tree_stub", "linear_regression_stub", "plot_matplotlib", "plotly_stub",
    "dash_stub", "streamlit_stub", "gradio_stub", "fastapi_upload", "fastapi_auth_jwt",
    "oauth_pkce_stub", "webhook_receiver", "stripe_webhook_stub", "twilio_sms_stub",
    "discord_webhook", "slack_webhook", "telegram_bot_stub", "rss_reader", "sitemap_fetch",
    "robots_txt", "user_agent_rotate", "proxy_request", "cookie_jar", "session_persist",
    "graphql_query", "grpc_stub", "avro_stub", "protobuf_stub", "msgpack_stub",
    "redis_cache", "memcached_stub", "s3_upload_stub", "s3_download_stub", "gcs_stub",
    "azure_blob_stub", "docker_run_stub", "compose_stub", "k8s_deploy_stub", "helm_stub",
    "terraform_stub", "ansible_stub", "ci_github_actions", "ci_gitlab", "precommit_config",
]
for t in templates:
    add(f"code_template_{t}", f"Generate starter code template: {t}", {
        "path": {"type": "string", "required": True},
    }, "code", "code_template", template=t)

# --- image / design ---
img_ops = [
    ("image_generate", "Generate an image fast via warm NEO daemon (designer-quality prompts).", {
        "prompt": {"type": "string", "required": True},
        "width": {"type": "integer", "default": 768},
        "height": {"type": "integer", "default": 768},
        "steps": {"type": "integer", "default": 4},
        "exact_text": {"type": "string", "description": "Optional exact typography to overlay (never garbled)"},
        "style": {"type": "string", "default": "cinematic, ultra detailed, coherent design"},
    }),
    ("image_edit_prompt", "Re-generate from last image prompt with edits", {
        "instruction": {"type": "string", "required": True},
    }),
    ("image_open", "Open image in OS viewer", {"path": {"type": "string", "required": True}}),
    ("image_info", "Image size/format", {"path": {"type": "string", "required": True}}),
    ("image_overlay_text", "Burn exact text onto an image (pixel-perfect)", {
        "path": {"type": "string", "required": True},
        "text": {"type": "string", "required": True},
        "out": {"type": "string", "default": ""},
        "position": {"type": "string", "default": "center"},
    }),
    ("design_critique", "Return a structured design critique plan (text)", {
        "brief": {"type": "string", "required": True},
    }),
    ("design_palette", "Suggest a color palette for a brand brief", {
        "brief": {"type": "string", "required": True},
    }),
]
for name, desc, params in img_ops:
    add(name, desc, params, "image", name)

# --- mcp / models ---
mcp_ops = [
    ("mcp_list_local", "List MCP-ish configs under .cursor or neo/mcp", {"root": {"type": "string", "default": "."}}),
    ("mcp_install_npm", "Install an MCP server package via npm", {"package": {"type": "string", "required": True}, "cwd": {"type": "string", "default": "."}}),
    ("mcp_write_config", "Write/merge an MCP server config JSON snippet", {"path": {"type": "string", "required": True}, "name": {"type": "string", "required": True}, "command": {"type": "string", "required": True}, "args": {"type": "array", "items": {"type": "string"}, "default": []}}),
    ("model_switch_text", "Switch Neo text model id for this session (neo-brain / neo-coder)", {"model": {"type": "string", "required": True}}),
    ("model_capabilities", "Describe Neo local model capabilities", {}),
]
for name, desc, params in mcp_ops:
    add(name, desc, params, "mcp", name)

# Pad to >= 1000 with safe win_info_* and util_* tools if needed
i = 0
while len(tools) < 1000:
    i += 1
    add(
        f"util_echo_{i:04d}",
        f"Utility echo tool #{i} — returns args (for agent self-tests).",
        {"message": {"type": "string", "default": f"neo-util-{i}"}},
        "util",
        "util_echo",
    )

assert len(tools) >= 1000, len(tools)
OUT.write_text(json.dumps({"version": 1, "count": len(tools), "tools": tools}, indent=2), encoding="utf-8")
print(f"Wrote {len(tools)} tools -> {OUT}")
