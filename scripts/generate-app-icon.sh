#!/usr/bin/env bash
# 使用本机轻量 Stable Diffusion 1.5 生成应用图标。
# 依赖: /usr/bin/python3 可 import diffusers transformers accelerate torch
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${ROOT}/resources/icon.png"
GEN="${ROOT}/scripts/gen-image-sd15.py"
mkdir -p "${ROOT}/resources"
if [[ ! -f "$GEN" ]]; then
  echo "未找到生图脚本: $GEN" >&2
  exit 1
fi
PROMPT='App icon for AI desktop assistant MyAgent, flat vector style, rounded square canvas, deep teal and slate blue gradient background, single abstract symbol combining a friendly spark and a soft chat bubble or neural node, no text no letters, high contrast, crisp edges, professional macOS application icon, centered composition, readable silhouette at 32 pixels, clean minimal design'
/usr/bin/python3 "$GEN" --steps 20 --width 512 --height 512 --prompt "$PROMPT" --out "$OUT"
mkdir -p "${ROOT}/public"
cp -f "$OUT" "${ROOT}/public/icon.png"
echo "已写入: $OUT 与 public/icon.png"
