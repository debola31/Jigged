#!/usr/bin/env bash
# Re-encode the marketing screenshots to WebP at the two widths the page actually renders.
#
# WHY THIS EXISTS. The landing page shipped ~10.7 MB of raw PNG — three phone mockups
# alone were 5.2 MB, served 1428px wide to be drawn at 244–322 CSS px — and `next/image`
# is used nowhere in this repo, so nothing was resizing or re-encoding anything. Adding
# feature content to that pipeline makes the page slower with every section.
#
# WHY NOT `next/image`. These are eight fixed assets that change only when someone
# re-shoots them. Build-time WebP costs nothing at runtime and adds no Vercel
# image-optimisation units; `next/image` would bill a transformation per variant per
# deployment for files that never vary per request.
#
# RUN IT after dropping new captures into public/screenshots, then commit the .webp files
# alongside the .png originals — the PNGs stay as the <img> src fallback and as the
# masters to re-encode from.
#
#   ./scripts/optimizeMarketingImages.sh
#
# Requires cwebp (brew install webp).

set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v cwebp >/dev/null 2>&1; then
  echo "cwebp not found. Install it with: brew install webp" >&2
  exit 1
fi

# Desktop captures are drawn at most ~820 CSS px wide inside the lg container, so 1600px
# covers a 2x display with room to spare and 900px covers a phone. Phone mockups are drawn
# at 244–322 CSS px, so 720px is already 2x for the largest of them.
optimise() {
  local src="$1" width="$2" quality="$3" out="$4"
  cwebp -quiet -q "$quality" -resize "$width" 0 "$src" -o "$out"
  printf '  %-46s %6s KB\n' "$(basename "$out")" "$(( $(stat -f%z "$out") / 1024 ))"
}

echo "Desktop captures →  .webp (1600w) + @900w"
for src in public/screenshots/feature-job-status.png \
           public/screenshots/feature-drawings.png \
           public/screenshots/feature-insights.png; do
  [ -f "$src" ] || { echo "  (missing: $src — skipped)"; continue; }
  base="${src%.png}"
  optimise "$src" 1600 82 "${base}.webp"
  optimise "$src" 900 80 "${base}@900w.webp"
done

echo "Phone mockups →  .webp (720w)"
for src in public/screenshots/feature-operator-queue.png \
           public/screenshots/feature-operator-step.png \
           public/screenshots/feature-knowledge-note.png; do
  [ -f "$src" ] || { echo "  (missing: $src — skipped)"; continue; }
  base="${src%.png}"
  # -alpha_q keeps the transparent device silhouette clean; PhoneShot drop-shadows it,
  # so a ragged alpha edge shows up as a halo rather than as softness.
  cwebp -quiet -q 84 -alpha_q 100 -resize 720 0 "$src" -o "${base}.webp"
  printf '  %-46s %6s KB\n' "$(basename "${base}.webp")" "$(( $(stat -f%z "${base}.webp") / 1024 ))"
done

echo "Hero backdrop"
if [ -f public/wireframe-scene.png ]; then
  optimise public/wireframe-scene.png 1456 74 public/wireframe-scene.webp
fi

echo
echo "Done. Total delivered weight:"
find public/screenshots public/wireframe-scene.webp -name '*.webp' 2>/dev/null \
  | xargs stat -f%z 2>/dev/null | awk '{t+=$1} END {printf "  %.2f MB across %d files\n", t/1048576, NR}'
