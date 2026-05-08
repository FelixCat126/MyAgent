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
DEFAULT_PORTRAIT_NEGATIVE = (
    "deformed face, distorted face, bad eyes, asymmetrical eyes, crossed eyes, "
    "blurry face, bad face, ugly face, plastic skin, doll face, bad anatomy, "
    "extra limbs, low quality, worst quality"
)
PORTRAIT_HINT_RE = (
    "portrait",
    "face",
    "model",
    "woman",
    "girl",
    "female",
    "fashion",
    "lingerie",
    "swimsuit",
    "underwear",
    "模特",
    "人像",
    "女性",
    "美女",
    "内衣",
    "泳装",
)


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


def truthy_env(name: str, default: str = "1") -> bool:
    return os.environ.get(name, default).strip().lower() not in ("0", "false", "no", "off")


def looks_like_portrait_request(prompt: str) -> bool:
    lower = prompt.lower()
    return any(k in lower for k in PORTRAIT_HINT_RE)


def enhance_portrait_prompt(prompt: str) -> str:
    if not truthy_env("MYAGENT_SD_AUTO_PORTRAIT_PROMPT", "1"):
        return prompt
    if not looks_like_portrait_request(prompt):
        return prompt
    hint = (
        "natural realistic face, symmetrical facial features, detailed eyes, "
        "clean skin texture, professional fashion photography, face clearly visible"
    )
    if "natural realistic face" in prompt.lower():
        return prompt
    return f"{prompt}, {hint}"


def enhance_negative_prompt(negative: str, prompt: str) -> str:
    if not truthy_env("MYAGENT_SD_AUTO_PORTRAIT_PROMPT", "1"):
        return negative
    if not looks_like_portrait_request(prompt):
        return negative
    merged = negative.strip()
    lower = merged.lower()
    extras = [x.strip() for x in DEFAULT_PORTRAIT_NEGATIVE.split(",") if x.strip() and x.strip().lower() not in lower]
    if extras:
        merged = f"{merged}, {', '.join(extras)}" if merged else ", ".join(extras)
    return merged


def default_vae_for_model(model_id: str) -> str:
    if "novae" in model_id.lower():
        return "stabilityai/sd-vae-ft-mse-original"
    return ""


def find_vae_single_file(repo_id: str, local_only: bool) -> str | None:
    try:
        from huggingface_hub import snapshot_download

        snapshot = Path(snapshot_download(repo_id=repo_id, local_files_only=local_only))
    except Exception:
        return None
    for pattern in ("*.safetensors", "*.ckpt"):
        matches = sorted(snapshot.glob(pattern))
        if matches:
            return str(matches[0])
    return None


def find_pipeline_vae_config(model_id: str, local_only: bool) -> str | None:
    try:
        from huggingface_hub import snapshot_download

        snapshot = Path(snapshot_download(repo_id=model_id, local_files_only=local_only))
    except Exception:
        return None
    config = snapshot / "vae" / "config.json"
    return str(config) if config.exists() else None


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

    prompt = enhance_portrait_prompt((args.prompt or "").strip())
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
    from diffusers import AutoencoderKL, DPMSolverMultistepScheduler, StableDiffusionPipeline

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

    local_only = os.environ.get("MYAGENT_SD_LOCAL_ONLY", "1") not in ("0", "false", "no")
    vae_id = os.environ.get("MYAGENT_SD_VAE", default_vae_for_model(MODEL_ID)).strip()
    vae = None
    if vae_id:
        print(f"Using VAE: {vae_id}", flush=True)
        try:
            vae = AutoencoderKL.from_pretrained(
                vae_id,
                torch_dtype=dtype,
                local_files_only=local_only,
            )
        except Exception as e:
            single_file = find_vae_single_file(vae_id, local_only)
            if not single_file:
                raise
            print(f"Loading VAE single file: {single_file}", flush=True)
            vae_config = find_pipeline_vae_config(MODEL_ID, local_only)
            vae_kwargs = {"torch_dtype": dtype, "local_files_only": local_only}
            if vae_config:
                vae_kwargs["config"] = vae_config
            vae = AutoencoderKL.from_single_file(single_file, **vae_kwargs)

    pipe = StableDiffusionPipeline.from_pretrained(
        MODEL_ID,
        torch_dtype=dtype,
        vae=vae,
        safety_checker=None,
        requires_safety_checker=False,
        local_files_only=local_only,
    )
    scheduler_name = os.environ.get("MYAGENT_SD_SCHEDULER", "dpmpp_karras").strip().lower()
    if scheduler_name in ("dpmpp", "dpmpp_karras", "dpmsolver", "dpmsolver_karras"):
        pipe.scheduler = DPMSolverMultistepScheduler.from_config(
            pipe.scheduler.config,
            algorithm_type="dpmsolver++",
            use_karras_sigmas=True,
        )
        print("Scheduler: DPM++ 2M Karras", flush=True)
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

    negative_prompt = enhance_negative_prompt(args.negative, prompt)
    result = pipe(
        prompt=prompt,
        negative_prompt=negative_prompt,
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
