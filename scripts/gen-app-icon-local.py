#!/usr/bin/env python3
"""
使用本机已缓存的 Flux Schnell（diffusers）生成应用图标。
避免 MPS float16 NaN 导致全黑：在导入 torch 后禁用 MPS，使用 CPU + float32 + sequential offload。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "resources" / "icon.png"
PUBLIC = ROOT / "public" / "icon.png"

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

MODEL_ID = "YuCollection/FLUX.1-schnell-Diffusers"

PROMPT = (
    "Minimal flat macOS application icon for AI assistant software MyAgent, rounded square canvas, "
    "teal to emerald gradient background, abstract speech bubble with tiny neural sparkle, "
    "clean geometric vector style, no text, no letters, centered, soft shadow, professional dock icon"
)


def main() -> None:
    import torch

    # 强制不走 MPS（部分机型上 Flux float16 会 NaN → 黑图）
    torch.backends.mps.is_available = lambda: False  # type: ignore[method-assign]

    from diffusers import FluxPipeline

    dtype = torch.float32
    print(f"Loading {MODEL_ID} on CPU ({dtype})...", file=sys.stderr)
    pipe = FluxPipeline.from_pretrained(MODEL_ID, torch_dtype=dtype)
    pipe.enable_sequential_cpu_offload()

    h = w = 512
    steps = 4
    print(f"Generating {w}x{h}, steps={steps}...", file=sys.stderr)
    out = pipe(
        PROMPT,
        num_inference_steps=steps,
        guidance_scale=0.0,
        height=h,
        width=w,
        max_sequence_length=256,
    )
    image = out.images[0]

    OUT.parent.mkdir(parents=True, exist_ok=True)
    image.save(str(OUT))
    PUBLIC.parent.mkdir(parents=True, exist_ok=True)
    image.save(str(PUBLIC))
    print(str(OUT))
    print(str(PUBLIC))


if __name__ == "__main__":
    main()
