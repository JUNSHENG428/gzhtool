#!/usr/bin/env bash
# 从 @fontsource 包复制 woff2 并生成 src/pages/fonts.css（离线扩展用，无需访问 Google）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FONTS="$ROOT/src/pages/fonts"
DM="$ROOT/node_modules/@fontsource/dm-sans"
NS="$ROOT/node_modules/@fontsource/noto-serif-sc"

if [[ ! -d "$DM/files" || ! -d "$NS/files" ]]; then
  echo "请先执行: npm install" >&2
  exit 1
fi

mkdir -p "$FONTS"
rm -f "$FONTS"/*.woff2

cp "$DM/files/dm-sans-latin-"{400,500,600,700}"-normal.woff2" "$FONTS/"
cp "$NS/files/noto-serif-sc-"*-700-normal.woff2 "$FONTS/"

OUT="$ROOT/src/pages/fonts.css"
{
  printf '%s\n' "/* 自托管 woff2，离线可用。DM Sans 覆盖拉丁；Noto Serif SC 700 为中文标题（分片 + unicode-range）。 */"
  printf '%s\n' "/* 重新生成：npm run fonts:sync */"
  printf '\n'
  cat << 'EOF'
/* —— DM Sans (latin) —— */
@font-face {
  font-family: "DM Sans";
  font-style: normal;
  font-display: swap;
  font-weight: 400;
  src: url("./fonts/dm-sans-latin-400-normal.woff2") format("woff2");
}
@font-face {
  font-family: "DM Sans";
  font-style: normal;
  font-display: swap;
  font-weight: 500;
  src: url("./fonts/dm-sans-latin-500-normal.woff2") format("woff2");
}
@font-face {
  font-family: "DM Sans";
  font-style: normal;
  font-display: swap;
  font-weight: 600;
  src: url("./fonts/dm-sans-latin-600-normal.woff2") format("woff2");
}
@font-face {
  font-family: "DM Sans";
  font-style: normal;
  font-display: swap;
  font-weight: 700;
  src: url("./fonts/dm-sans-latin-700-normal.woff2") format("woff2");
}

EOF
  sed 's|url(./files/|url(./fonts/|g' "$NS/700.css" | sed "s|, url([^)]*\\.woff)[^)]*||g" | sed "s|format('woff2'));|format('woff2');|g"
} > "$OUT"

cp "$DM/LICENSE" "$FONTS/LICENSE-DM-Sans-OFL.txt"
cp "$NS/LICENSE" "$FONTS/LICENSE-Noto-Serif-SC-OFL.txt"

echo "OK: $(ls -1 "$FONTS"/*.woff2 | wc -l | tr -d ' ') woff2 files, $(wc -l < "$OUT") lines in fonts.css"
