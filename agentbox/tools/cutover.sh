#!/usr/bin/env bash
# omg live-overstap: cutover.sh <nieuwe-release> [rollback-release]
# Hardening (21-11-2026):
# - Verplichte pre-flight vóór aanraken van live symlink of herstarten van omg.service.
# - Rollback wordt automatisch afgeleid van de huidige gezonde `current` als $2 ontbreekt.
# - Faalt één checksum of ontbreekt preserve.py/manifest.json: abort met 0s downtime.
set -euo pipefail

LOG=/home/agent/.cache/agent-tmp/omg-cutover/cutover.log
R=/home/agent/.local/lib/omg-private/releases
CUR_LINK=/home/agent/.local/lib/omg-private/current
LIVE=/home/agent/omg
mkdir -p "$(dirname "$LOG")"

if [ $# -lt 1 ] || [ -z "${1:-}" ]; then
  echo "FOUT: gebruik: cutover.sh <nieuwe-release> [rollback-release]" >&2
  exit 2
fi

NEW="$R/$1"
if [ -n "${2:-}" ]; then
  RB="$R/$2"
else
  RB="$(readlink -f "$CUR_LINK" 2>/dev/null || true)"
fi

# ── Pre-flight (voordat we ook maar iets aan live aanraken!) ──────────────
for label_dir in "NEW:$NEW" "ROLLBACK:$RB"; do
  lbl="${label_dir%%:*}"
  dir="${label_dir#*:}"
  if [ -z "$dir" ] || [ ! -d "$dir" ] || [ "$dir" = "$R" ]; then
    echo "PREFLIGHT FOUT: $lbl-release bestaat niet of is ongeldig: '$dir' (OMG blijft ongewijzigd online)" >&2
    exit 2
  fi
  for req in preserve.py manifest.json files; do
    if [ ! -e "$dir/$req" ]; then
      echo "PREFLIGHT FOUT: $dir/$req ontbreekt (OMG blijft ongewijzigd online)" >&2
      exit 2
    fi
  done
done

if [ "$(readlink -f "$NEW")" = "$(readlink -f "$RB")" ]; then
  echo "PREFLIGHT FOUT: nieuwe release en rollback zijn identiek ($NEW)" >&2
  exit 2
fi

# Controleer alle checksums in NEW én verifieer dat preserve.py zonder drift op LIVE mag toepassen
python3 - "$NEW" "$LIVE" <<'PY'
import hashlib, json, sys
from pathlib import Path

bundle = Path(sys.argv[1])
live = Path(sys.argv[2])
manifest = json.loads((bundle / "manifest.json").read_text())
live_ver = json.loads((live / "package.json").read_text())["version"]
if live_ver != manifest["version"]:
    raise SystemExit(f"PREFLIGHT FOUT: versie-mismatch (live={live_ver}, release={manifest['version']})")

def sha(p: Path):
    return hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None

for name, entry in manifest["files"].items():
    rel = Path(name)
    if rel.is_absolute() or ".." in rel.parts:
        raise SystemExit(f"PREFLIGHT FOUT: onveilig pad {name}")
    src = bundle / "files" / rel
    if sha(src) != entry["custom"]:
        raise SystemExit(f"PREFLIGHT FOUT: snapshot checksum mismatch voor {name}")
    actual = sha(live / rel)
    if actual == entry["custom"]:
        continue
    if actual != entry.get("upstream") and actual not in (entry.get("previous") or ()):
        raise SystemExit(f"PREFLIGHT FOUT: ongereviewde lokale wijziging op {name} (actual={actual})")
print(f"PREFLIGHT OK: {bundle.name} ({len(manifest['files'])} files geverifieerd, rollback={sys.argv[1]})")
PY

# ── Vanaf hier: gecontroleerde live cutover + automatische rollback ───────
exec > >(tee -a "$LOG") 2>&1
echo "== $(date -Is) start, NEW=$(basename "$NEW") RB=$(basename "$RB") oude_current=$(readlink "$CUR_LINK" 2>/dev/null || echo none)"

healthy() {
  for i in $(seq 1 45); do
    sleep 2
    if curl -sf -m4 127.0.0.1:8766/api/sessions | grep -q '"sessions"' \
       && curl -sf -m6 127.0.0.1:8766/api/taken | grep -q '"bijgewerkt"' \
       && curl -sf -m4 127.0.0.1:8766/ | grep -q '<div id="root"'; then
      echo "gezond na $((i*2))s"
      return 0
    fi
  done
  return 1
}

ln -sfn "$NEW" "$CUR_LINK"
if systemctl --user restart omg && healthy; then
  echo "RESULT=OK"
  systemctl --user show omg -p MainPID -p ActiveState
  exit 0
fi

echo "NIET GEZOND -> automatische rollback naar $RB"
journalctl --user -u omg -n 40 --no-pager || true
ln -sfn "$RB" "$CUR_LINK"
systemctl --user reset-failed omg || true
systemctl --user restart omg || true
if healthy; then
  echo "RESULT=ROLLED_BACK_OK"
  exit 1
else
  echo "RESULT=ROLLBACK_FAILED"
  exit 1
fi
