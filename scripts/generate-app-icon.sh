#!/usr/bin/env bash
# 使用本机 Flux Schnell（与 Cursor generate-image-free 技能相同脚本）生成应用图标。
# 依赖: pip3 install diffusers transformers accelerate torch
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${ROOT}/resources/icon.png"
GEN="${HOME}/.cursor/skills/generate-image-free/scripts/gen.py"
mkdir -p "${ROOT}/resources"
if [[ ! -f "$GEN" ]]; then
  echo "未找到生图脚本: $GEN" >&2
  exit 1
fi
PROMPT='App icon for AI desktop assistant MyAgent, flat vector style, rounded square canvas, deep teal and slate blue gradient background, single abstract symbol combining a friendly spark and a soft chat bubble or neural node, no text no letters, high contrast, crisp edges, professional macOS application icon, centered composition, readable silhouette at 32 pixels, clean minimal design'
python3 "$GEN" --model flux --steps 4 --width 1024 --height 1024 --prompt "$PROMPT" --out "$OUT"
mkdir -p "${ROOT}/public"
cp -f "$OUT" "${ROOT}/public/icon.png"
echo "已写入: $OUT 与 public/icon.png"
