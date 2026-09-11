#!/usr/bin/env python3
"""NEO image worker — uses neo-image weights when installed."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


def _neo_image_src() -> str:
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "daemon"))
        from neo_paths import data_root as _dr  # type: ignore

        root = _dr()
    except Exception:
        env = os.environ.get("NEO_HOME")
        if env:
            root = Path(env)
        elif os.name == "nt":
            base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
            root = Path(base) / "Neo"
        elif sys.platform == "darwin":
            root = Path.home() / "Library" / "Application Support" / "Neo"
        else:
            root = Path.home() / ".local" / "share" / "neo"
    cfg = root / "config.json"
    if cfg.is_file():
        try:
            p = json.loads(cfg.read_text(encoding="utf-8")).get("image_path")
            if p and Path(p).is_dir():
                return str(p)
        except Exception:
            pass
    local = root / "models" / "neo-image"
    if local.is_dir() and (local / ".neo-ready").is_file():
        return str(local)
    # upstream mirror only when neo-image not installed yet
    return "stabilityai/sd-turbo"


def generate_neo_image(args) -> Path:
    import torch
    from diffusers import AutoPipelineForText2Image

    dtype = torch.float16 if torch.cuda.is_available() else torch.float32
    device = "cuda" if torch.cuda.is_available() else "cpu"
    src = _neo_image_src()
    print(f"[neo-worker] model=neo-vision src={src} device={device}", flush=True)
    kwargs = {"torch_dtype": dtype}
    if device == "cuda" and not Path(src).is_dir():
        kwargs["variant"] = "fp16"
    pipe = AutoPipelineForText2Image.from_pretrained(src, **kwargs)
    pipe = pipe.to(device)
    if hasattr(pipe, "set_progress_bar_config"):
        pipe.set_progress_bar_config(disable=True)

    image = pipe(
        prompt=args.prompt,
        negative_prompt=args.negative or None,
        num_inference_steps=max(1, min(args.steps, 8)),
        guidance_scale=0.0,
        width=args.width,
        height=args.height,
    ).images[0]

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    image.save(out)
    return out


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--model", default="neo-image")
    p.add_argument("--prompt", required=True)
    p.add_argument("--negative", default="")
    p.add_argument("--width", type=int, default=512)
    p.add_argument("--height", type=int, default=512)
    p.add_argument("--steps", type=int, default=4)
    p.add_argument("--out", required=True)
    args = p.parse_args()

    try:
        path = generate_neo_image(args)
    except Exception as e:
        print(f"[neo-worker] ERROR: {e}", file=sys.stderr, flush=True)
        return 1
    print(str(path.resolve()), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
