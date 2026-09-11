#!/usr/bin/env python3
"""Warm NEO image daemon — keeps Neo Vision weights loaded for fast generations."""

from __future__ import annotations

import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "outputs"
OUT.mkdir(parents=True, exist_ok=True)

PIPE = None
LOCK = threading.Lock()
DEVICE = "cpu"
MODEL_ID = "neo-vision"


def _neo_data_root() -> Path:
    try:
        from neo_paths import data_root as _dr

        return _dr()
    except Exception:
        pass
    env = os.environ.get("NEO_HOME")
    if env:
        return Path(env)
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "Neo"
    import sys

    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Neo"
    return Path.home() / ".local" / "share" / "neo"


def resolve_image_model():
    """Prefer local Neo Vision weights under models/neo-image."""
    cfg_path = _neo_data_root() / "config.json"
    if cfg_path.is_file():
        try:
            cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
            p = cfg.get("image_path")
            if p and Path(p).is_dir() and (Path(p) / ".neo-ready").is_file():
                return Path(p)
        except Exception:
            pass
    local = _neo_data_root() / "models" / "neo-image"
    if local.is_dir() and (local / ".neo-ready").is_file():
        return local
    # Fallback: upstream mirror id (first run / missing install) — not a product name
    return "stabilityai/sd-turbo"


def load_pipeline():
    global PIPE, DEVICE
    import torch
    from diffusers import AutoPipelineForText2Image

    DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.float16 if DEVICE == "cuda" else torch.float32
    model_src = resolve_image_model()
    print(f"[neo-vision] loading {MODEL_ID} from {model_src} on {DEVICE}…", flush=True)
    t0 = time.time()
    kwargs = {"torch_dtype": dtype}
    if DEVICE == "cuda" and not isinstance(model_src, Path):
        kwargs["variant"] = "fp16"
    pipe = AutoPipelineForText2Image.from_pretrained(str(model_src), **kwargs)
    pipe = pipe.to(DEVICE)
    if hasattr(pipe, "set_progress_bar_config"):
        pipe.set_progress_bar_config(disable=True)
    PIPE = pipe
    print(f"[neo-vision] ready in {time.time() - t0:.1f}s", flush=True)


def generate(payload: dict) -> dict:
    from PIL import ImageDraw, ImageFont

    prompt = payload.get("prompt") or "abstract design"
    width = int(payload.get("width") or 768)
    height = int(payload.get("height") or 768)
    steps = max(1, min(int(payload.get("steps") or 4), 8))
    exact = str(payload.get("exact_text") or "")

    width -= width % 8
    height -= height % 8

    with LOCK:
        assert PIPE is not None
        t0 = time.time()
        image = PIPE(
            prompt=prompt,
            num_inference_steps=steps,
            guidance_scale=0.0,
            width=width,
            height=height,
        ).images[0]
        elapsed = time.time() - t0

    if exact:
        draw = ImageDraw.Draw(image)
        try:
            font = ImageFont.truetype("arial.ttf", size=max(28, width // 16))
        except Exception:
            font = ImageFont.load_default()
        bbox = draw.textbbox((0, 0), exact, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        x, y = (width - tw) // 2, (height - th) // 2
        draw.text((x + 2, y + 2), exact, fill=(0, 0, 0), font=font)
        draw.text((x, y), exact, fill=(255, 244, 230), font=font)

    path = OUT / f"neo-{int(time.time() * 1000)}.png"
    image.save(path)
    return {
        "ok": True,
        "path": str(path.resolve()),
        "seconds": round(elapsed, 3),
        "device": DEVICE,
        "steps": steps,
        "size": [width, height],
        "exact_text": exact or None,
        "model": MODEL_ID,
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print("[neo-vision]", fmt % args, flush=True)

    def _json(self, code: int, obj: dict):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            self._json(200, {"ok": True, "ready": PIPE is not None, "device": DEVICE, "model": MODEL_ID})
            return
        self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if self.path != "/generate":
            self._json(404, {"ok": False, "error": "not found"})
            return
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        try:
            payload = json.loads(raw.decode() or "{}")
            if PIPE is None:
                self._json(503, {"ok": False, "error": "model loading"})
                return
            self._json(200, generate(payload))
        except Exception as e:
            self._json(500, {"ok": False, "error": str(e)})


def main():
    load_pipeline()
    host, port = "127.0.0.1", int(os.environ.get("NEO_IMAGE_PORT", "8765"))
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"[neo-vision] listening http://{host}:{port}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
