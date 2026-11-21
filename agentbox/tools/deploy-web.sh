#!/usr/bin/env bash
# Eén veilig commando om een Agentbox-release te bouwen en live te zetten.
# Gebruik: deploy-web.sh <release-naam>
# Stappen: tsc --noEmit -> vite build -> make_release.py (incl. preflight) -> cutover.sh (met automatische rollback).
set -euo pipefail

if [ $# -ne 1 ] || [ -z "${1:-}" ]; then
  echo "Gebruik: deploy-web.sh <release-naam>  (bijv. ux-v4-20261121)" >&2
  exit 2
fi

NAME="$1"
REPO=/home/agent/omg-agentbox
TOOLS="$REPO/agentbox/tools"

cd "$REPO"
echo "== [1/3] Typecheck & Vite build =="
bun run --cwd web build

echo "== [2/3] Release + rollback bouwen en preflighten =="
OUT="$(python3 "$TOOLS/make_release.py" "$NAME")"
echo "$OUT"
RB="$(printf '%s\n' "$OUT" | sed -n 's/.*rollback=\([^ ]*\).*/\1/p' | tail -n 1)"
if [ -z "$RB" ]; then
  echo "FOUT: kon rollback-naam niet uitlezen uit make_release.py" >&2
  exit 1
fi

echo "== [3/3] Geharde cutover ($NAME, rollback=$RB) =="
exec bash "$TOOLS/cutover.sh" "$NAME" "$RB"
