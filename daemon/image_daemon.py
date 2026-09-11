#!/usr/bin/env python3
"""Warm NEO image daemon — keeps SD-Turbo loaded for fast generations."""

from __future__ import annotations

import json
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


def load_pipeline():
    global PIPE, DEVICE
    import torch
    from diffusers import AutoPipelineForText2Image

    DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.float16 if DEVICE == "cuda" else torch.float32
    print(f"[neo-image] loading sd-turbo on {DEVICE}…", flush=True)
    t0 = time.time()
    pipe = AutoPipelineForText2Image.from_pretrained(
        "stabilityai/sd-turbo",
        torch_dtype=dtype,
        variant="fp16" if DEVICE == "cuda" else None,
    )
    pipe = pipe.to(DEVICE)
    if hasattr(pipe, "set_progress_bar_config"):
        pipe.set_progress_bar_config(disable=True)
    PIPE = pipe
    print(f"[neo-image] ready in {time.time() - t0:.1f}s", flush=True)


def generate(payload: dict) -> dict:
    from PIL import ImageDraw, ImageFont

    prompt = payload.get("prompt") or "abstract design"
    width = int(payload.get("width") or 768)
    height = int(payload.get("height") or 768)
    steps = max(1, min(int(payload.get("steps") or 4), 8))
    exact = str(payload.get("exact_text") or "")

    # snap to multiples of 8
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
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print("[neo-image]", fmt % args, flush=True)

    def _json(self, code: int, obj: dict):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            self._json(200, {"ok": True, "ready": PIPE is not None, "device": DEVICE})
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
    host, port = "127.0.0.1", int(__import__("os").environ.get("NEO_IMAGE_PORT", "8765"))
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"[neo-image] listening http://{host}:{port}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
