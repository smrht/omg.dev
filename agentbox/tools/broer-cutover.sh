#!/bin/bash
# Overstap Albins box (broer-box) van upstream 0.6.361 naar onze agentbox-boom (07-11-2026).
# Draait op broer-box als transient unit. Wacht tot er IDLE_MIN minuten niets bezig is
# (busy/launching = 0), stopt omg, maakt tar van data, zet drop-in 40-agentbox.conf,
# start en controleert. Faalt de check: drop-in weg, oude unit terug.
# Log: ~/.cache/omg-cutover/cutover.log  (RESULT=OK | ROLLED_BACK_OK | ROLLBACK_FAILED | GEEN_STIL_VENSTER)
set -u
W=$HOME/.cache/omg-cutover; mkdir -p "$W"; LOG=$W/cutover.log
D=$HOME/.config/systemd/user/omg.service.d; NEW=$HOME/omg-agentbox
IDLE_MIN=${IDLE_MIN:-20}; DEADLINE=$(( $(date +%s) + ${MAX_WAIT_H:-36}*3600 ))
log(){ echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }
busy(){ curl -s -m10 127.0.0.1:8766/api/sessions | python3 -c '
import json,sys
d=json.load(sys.stdin); L=d if isinstance(d,list) else d.get("sessions",[])
print(sum(1 for s in L if s.get("busy") or s.get("launching")), len(L))' 2>/dev/null || echo "x 0"; }
health(){ for i in $(seq 1 90); do
  set -- $(busy); n=$2
  cfg=$(curl -s -m5 127.0.0.1:8766/ | grep -o '"profile":"neutral"' | head -1)
  if [ "$n" -ge 1 ] && [ -n "$cfg" ] && curl -sf -m5 -o /dev/null 127.0.0.1:8766/api/settings; then echo "$n"; return 0; fi
  sleep 2; done; return 1; }
log "START wacht op $IDLE_MIN min stil"
quiet=0
while :; do
  set -- $(busy)
  if [ "$1" = "0" ]; then quiet=$((quiet+1)); else quiet=0; fi
  [ $quiet -ge $IDLE_MIN ] && break
  if [ $(date +%s) -gt $DEADLINE ]; then log "RESULT=GEEN_STIL_VENSTER"; exit 0; fi
  sleep 60
done
set -- $(busy); before=$2; log "stil sinds $IDLE_MIN min, sessies=$before; overstap"
ids(){ curl -s -m10 127.0.0.1:8766/api/sessions | python3 -c '
import json,sys
d=json.load(sys.stdin); L=d if isinstance(d,list) else d.get("sessions",[])
for s in L: print(s.get("sessionId",""), s.get("status",""))' 2>/dev/null; }
ids | cut -d" " -f1 | sort > "$W/voor-ids.txt"
systemctl --user stop omg.service
tar -C "$HOME/omg" -cf "$W/data-voor-overstap.tar" data && log "tar ok $(du -sh "$W/data-voor-overstap.tar" | cut -f1)" || log "tar FOUT"
cat > "$D/40-agentbox.conf" <<CONF
# Onze agentbox-boom (Sam, 07-11-2026). Terug: dit bestand weg + daemon-reload + restart.
[Service]
WorkingDirectory=$NEW
Environment=OMG_DATA_DIR=$HOME/omg/data
Environment=OMG_ENV_FILE=$HOME/omg/.env
Environment=AGENTBOX_PROFILE=neutral
Environment=AGENTBOX_OWNER_NAME=Albin
Environment=LFG_AUTO_UPDATE=0
ExecStartPre=
ExecStartPre=/usr/bin/node $HOME/.local/share/omg/runtime-fixes/codex-replay-guard/install.mjs --root $NEW
ExecStart=
ExecStart=$HOME/.bun/bin/bun run $NEW/src/cli.ts serve
CONF
systemctl --user daemon-reload; systemctl --user start omg.service
if n=$(health); then
  log "nieuw gezond sessies=$n (voor $before) pid=$(systemctl --user show omg.service -p MainPID --value)"
  sleep 30; ids > "$W/na-ids.txt"
  missing=$(cut -d" " -f1 "$W/na-ids.txt" | sort | comm -23 "$W/voor-ids.txt" - | wc -l)
  errs=$(awk '$2=="error"||$2=="failed"' "$W/na-ids.txt" | wc -l)
  idx=$(curl -s -m10 127.0.0.1:8766/); sam=0
  for a in $(echo "$idx" | grep -oE '/assets/[^"]+\.js' | sort -u); do
    c=$(curl -s -m20 "127.0.0.1:8766$a" | grep -cE 'tailda028c|kie-usage|samht|agentbox-mac'); sam=$((sam+c)); done
  log "POSTCHECK ontbrekend=$missing fout=$errs samstrings_bundle=$sam"
  log "RESULT=OK"; exit 0
fi
log "nieuw ONGEZOND, terug naar oude boom"
journalctl --user -u omg.service -n 40 --no-pager | cut -c1-200 | grep -iE "error|fail|cannot" | tail -5 >> "$LOG"
rm -f "$D/40-agentbox.conf"; systemctl --user daemon-reload; systemctl --user restart omg.service
for i in $(seq 1 60); do curl -sf -m5 -o /dev/null 127.0.0.1:8766/api/settings && { log "RESULT=ROLLED_BACK_OK"; exit 0; }; sleep 2; done
log "RESULT=ROLLBACK_FAILED"; exit 1
