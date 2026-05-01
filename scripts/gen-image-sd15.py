#!/usr/bin/env python3
"""Generate an image with a lightweight Stable Diffusion 1.5 pipeline.

This script is designed for MyAgent's CLI image generator integration:
it accepts prompt/size/output args and writes a PNG file to the requested path.
It intentionally avoids FLUX-class models so it can run on Apple Silicon Macs
with 24 GB unified memory without forcing large CPU offload.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path


MODEL_ID = os.environ.get("MYAGENT_SD_MODEL", "runwayml/stable-diffusion-v1-5")
MAX_PIXELS = int(os.environ.get("MYAGENT_SD_MAX_PIXELS", str(512 * 768)))


def clamp_size(value: int | None, default: int) -> int:
    if value is None:
        return default
    return max(256, min(2048, int(value)))


def round_to_multiple(value: int, multiple: int = 8) -> int:
    return max(multiple, int(round(value / multiple)) * multiple)


def fit_size(width: int, height: int) -> tuple[int, int]:
    pixels = width * height
    if pixels <= MAX_PIXELS:
        return round_to_multiple(width), round_to_multiple(height)

    scale = (MAX_PIXELS / pixels) ** 0.5
    fitted_width = round_to_multiple(width * scale)
    fitted_height = round_to_multiple(height * scale)
    return max(256, fitted_width), max(256, fitted_height)


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate image with Stable Diffusion 1.5")
    parser.add_argument("--prompt", default=os.environ.get("MYAGENT_PROMPT", ""), help="Prompt")
    parser.add_argument("--out", default=os.environ.get("MYAGENT_OUTPUT_PATH", ""), help="Output PNG path")
    parser.add_argument("--width", type=int, default=None)
    parser.add_argument("--height", type=int, default=None)
    parser.add_argument("--steps", type=int, default=int(os.environ.get("MYAGENT_SD_STEPS", "20")))
    parser.add_argument("--guidance", type=float, default=float(os.environ.get("MYAGENT_SD_GUIDANCE", "7.0")))
    parser.add_argument("--negative", default=os.environ.get("MYAGENT_SD_NEGATIVE", "low quality, blurry, distorted"))
    args = parser.parse_args()

    prompt = (args.prompt or "").strip()
    if not prompt:
        raise SystemExit("Missing prompt")
    if not args.out:
        raise SystemExit("Missing output path")

    requested_width = clamp_size(args.width or int(os.environ.get("MYAGENT_WIDTH", "512")), 512)
    requested_height = clamp_size(args.height or int(os.environ.get("MYAGENT_HEIGHT", "512")), 512)
    width, height = fit_size(requested_width, requested_height)
    steps = max(1, min(40, int(args.steps)))

    out_path = Path(args.out).expanduser().resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if out_path.suffix.lower() != ".png":
        out_path = out_path.with_suffix(".png")

    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

    import torch
    from diffusers import StableDiffusionPipeline

    if torch.backends.mps.is_available():
      device = "mps"
      # Stable Diffusion 1.5 can produce NaNs/black images on some MPS fp16 paths.
      # float32 is still practical for SD1.5 on 24 GB Apple Silicon and is much safer.
      dtype = torch.float32
    elif torch.cuda.is_available():
      device = "cuda"
      dtype = torch.float16
    else:
      device = "cpu"
      dtype = torch.float32

    print(f"Using model: {MODEL_ID}", flush=True)
    if (width, height) != (requested_width, requested_height):
        print(
            f"Requested size {requested_width}x{requested_height} exceeds lightweight limit; "
            f"using {width}x{height}. Set MYAGENT_SD_MAX_PIXELS to override.",
            flush=True,
        )
    print(f"Device: {device}; size={width}x{height}; steps={steps}", flush=True)

    pipe = StableDiffusionPipeline.from_pretrained(
        MODEL_ID,
        torch_dtype=dtype,
        safety_checker=None,
        requires_safety_checker=False,
        local_files_only=os.environ.get("MYAGENT_SD_LOCAL_ONLY", "1") not in ("0", "false", "no"),
    )
    pipe = pipe.to(device)

    if hasattr(pipe, "enable_attention_slicing"):
        pipe.enable_attention_slicing()
    if hasattr(pipe, "enable_vae_slicing"):
        pipe.enable_vae_slicing()

    generator = None
    seed = os.environ.get("MYAGENT_SD_SEED")
    if seed and seed.strip().isdigit():
        gen_device = "cpu" if device == "mps" else device
        generator = torch.Generator(device=gen_device).manual_seed(int(seed))

    result = pipe(
        prompt=prompt,
        negative_prompt=args.negative,
        width=width,
        height=height,
        num_inference_steps=steps,
        guidance_scale=args.guidance,
        generator=generator,
    )
    image = result.images[0]
    image.save(out_path)
    print(str(out_path), flush=True)


if __name__ == "__main__":
    main()
