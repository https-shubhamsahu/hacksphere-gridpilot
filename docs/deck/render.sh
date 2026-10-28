#!/usr/bin/env bash
# Render the GridPilot submission deck to PDF.
#
# Usage:
#   APP_URL=https://... REPO_URL=https://github.com/... \
#   RMSE=12.34 MAE=9.87 MODEL_NAME="Ridge + GBM residuals" ./render.sh
#
# Optional: SRC=other.html OUT=other.pdf
# Output: docs/deck/GridPilot_NO_SUS_HackSphere3.pdf
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${SRC:-$DIR/deck.html}"
OUT="${OUT:-$DIR/GridPilot_NO_SUS_HackSphere3.pdf}"

missing=()
for v in APP_URL REPO_URL RMSE MAE MODEL_NAME; do
  [ -n "${!v:-}" ] || missing+=("$v")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "render.sh: missing env vars: ${missing[*]}" >&2
  exit 1
fi

CHROME="${CHROME:-$(command -v google-chrome-stable || command -v google-chrome || command -v chromium || true)}"
[ -n "$CHROME" ] || { echo "render.sh: Chrome not found (set CHROME=...)" >&2; exit 1; }

# Build copy sits next to deck.html so ../screens/*.png still resolves.
BUILD="$(dirname "$SRC")/.deck.build.html"
PROFILE="$(mktemp -d)"
trap 'rm -f "$BUILD"; rm -rf "$PROFILE"' EXIT

python3 -I - "$SRC" "$BUILD" <<'PY'
import html, os, sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src, encoding="utf-8").read()
for k in ("APP_URL", "REPO_URL", "RMSE", "MAE", "MODEL_NAME"):
    s = s.replace("{{%s}}" % k, html.escape(os.environ[k]))
left = [t for t in ("{{APP_URL}}", "{{REPO_URL}}", "{{RMSE}}", "{{MAE}}", "{{MODEL_NAME}}") if t in s]
if left:
    sys.exit("unfilled tokens: %s" % left)
open(dst, "w", encoding="utf-8").write(s)
PY

"$CHROME" --headless=new --disable-gpu --no-pdf-header-footer \
  --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check \
  --run-all-compositor-stages-before-draw --virtual-time-budget=8000 \
  --print-to-pdf="$OUT" "file://$BUILD" 2>/dev/null

echo "wrote $OUT"
command -v pdfinfo >/dev/null && pdfinfo "$OUT" | grep -E '^(Pages|Page size)'
