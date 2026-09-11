#!/usr/bin/env python3
"""NEO image worker — runs inside ComfyUI's CUDA venv."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


def generate_sd_turbo(args) -> Path:
    import torch
    from diffusers import AutoPipelineForText2Image

    dtype = torch.float16 if torch.cuda.is_available() else torch.float32
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"[neo-worker] device={device} dtype={dtype}", flush=True)
    pipe = AutoPipelineForText2Image.from_pretrained(
        "stabilityai/sd-turbo",
        torch_dtype=dtype,
        variant="fp16" if device == "cuda" else None,
    )
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


def generate_flux_schnell(args) -> Path:
    """Prefer ComfyUI API if up; else try Diffusers FluxSchnell."""
    import json
    import time
    import urllib.error
    import urllib.request

    comfy = (args.comfy_url or "http://127.0.0.1:8188").rstrip("/")
    try:
        urllib.request.urlopen(f"{comfy}/system_stats", timeout=2)
        # If Comfy is up but workflow/models may be missing — fall through to diffusers.
    except Exception:
        pass

    # Diffusers Flux Schnell (needs model download first run)
    import torch
    from diffusers import FluxPipeline

    dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"[neo-worker] flux-schnell device={device}", flush=True)
    pipe = FluxPipeline.from_pretrained(
        "black-forest-labs/FLUX.1-schnell",
        torch_dtype=dtype,
    )
    pipe.enable_model_cpu_offload()
    image = pipe(
        args.prompt,
        guidance_scale=0.0,
        num_inference_steps=max(1, min(args.steps, 8)),
        max_sequence_length=256,
        width=args.width,
        height=args.height,
    ).images[0]
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    image.save(out)
    return out


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--model", default="sd-turbo")
    p.add_argument("--prompt", required=True)
    p.add_argument("--negative", default="")
    p.add_argument("--width", type=int, default=512)
    p.add_argument("--height", type=int, default=512)
    p.add_argument("--steps", type=int, default=4)
    p.add_argument("--out", required=True)
    p.add_argument("--comfy-url", default="http://127.0.0.1:8188")
    args = p.parse_args()

    try:
        if args.model.startswith("flux"):
            path = generate_flux_schnell(args)
        else:
            path = generate_sd_turbo(args)
    except Exception as e:
        print(f"[neo-worker] ERROR: {e}", file=sys.stderr, flush=True)
        return 1

    print(f"NEO_IMAGE_PATH={path.resolve()}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
