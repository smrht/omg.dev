#!/bin/bash
# Bijwerken Albins box (broer-box) na de overstap van 07-11-2026 (broer-cutover.sh).
# Vooraf vanaf agentbox2 (stagen, raakt de draaiende boom niet):
#   ssh broer-box 'rm -rf ~/omg-agentbox.nieuw && cp -al ~/omg-agentbox ~/omg-agentbox.nieuw'
#   rsync -a --exclude=/data --exclude=/node_modules --exclude=/web/node_modules --exclude='.?*' \
#     ~/omg/ broer-box:omg-agentbox.nieuw/      (package.json/bun.lock eerst gelijk checken)
# Dan op broer-box als transient unit:
#   systemd-run --user --unit=omg-bijwerken --collect bash ~/omg-agentbox.nieuw/agentbox/tools/broer-update.sh LABEL
# Wacht tot IDLE_MIN minuten niets bezig is, stopt omg, wisselt de mappen
# (oude boom -> ~/omg-agentbox.voor-LABEL), start, health + nacontrole. Faalt het: terug.
# Log: ~/.cache/omg-cutover/update.log  (RESULT=OK | ROLLED_BACK_OK | ROLLBACK_FAILED | GEEN_STIL_VENSTER)
set -u
LABEL=${1:?label}
W=$HOME/.cache/omg-cutover; mkdir -p "$W"; LOG=$W/update.log
CUR=$HOME/omg-agentbox; NEW=$HOME/omg-agentbox.nieuw; OLD=$HOME/omg-agentbox.voor-$LABEL
IDLE_MIN=${IDLE_MIN:-15}; DEADLINE=$(( $(date +%s) + ${MAX_WAIT_H:-36}*3600 ))
log(){ echo "$(date -u +%FT%TZ) [$LABEL] $*" >> "$LOG"; }
busy(){ curl -s -m10 127.0.0.1:8766/api/sessions | python3 -c '
import json,sys
d=json.load(sys.stdin); L=d if isinstance(d,list) else d.get("sessions",[])
print(sum(1 for s in L if s.get("busy") or s.get("launching")), len(L))' 2>/dev/null || echo "x 0"; }
health(){ for i in $(seq 1 90); do
  set -- $(busy); n=$2
  cfg=$(curl -s -m5 127.0.0.1:8766/ | grep -o '"profile":"neutral"' | head -1)
  if [ "$n" -ge 1 ] && [ -n "$cfg" ] && curl -sf -m5 -o /dev/null 127.0.0.1:8766/api/settings; then echo "$n"; return 0; fi
  sleep 2; done; return 1; }
ids(){ curl -s -m10 127.0.0.1:8766/api/sessions | python3 -c '
import json,sys
d=json.load(sys.stdin); L=d if isinstance(d,list) else d.get("sessions",[])
for s in L: print(s.get("sessionId",""), s.get("status",""))' 2>/dev/null; }
[ -d "$NEW/src" ] || { log "RESULT=GEEN_STAGING"; exit 1; }
[ -e "$OLD" ] && { log "RESULT=OUDE_MAP_BESTAAT $OLD"; exit 1; }
log "START wacht op $IDLE_MIN min stil"
quiet=0
while :; do
  set -- $(busy)
  if [ "$1" = "0" ]; then quiet=$((quiet+1)); else quiet=0; fi
  [ $quiet -ge $IDLE_MIN ] && break
  if [ $(date +%s) -gt $DEADLINE ]; then log "RESULT=GEEN_STIL_VENSTER"; exit 0; fi
  sleep 60
done
set -- $(busy); before=$2; log "stil sinds $IDLE_MIN min, sessies=$before; wissel"
ids | cut -d" " -f1 | sort > "$W/voor-ids-$LABEL.txt"
systemctl --user stop omg.service
mv "$CUR" "$OLD" && mv "$NEW" "$CUR" || { log "mv FOUT"; [ -d "$CUR" ] || mv "$OLD" "$CUR"; systemctl --user start omg.service; log "RESULT=ROLLED_BACK_OK"; exit 1; }
systemctl --user start omg.service
if n=$(health); then
  log "nieuw gezond sessies=$n (voor $before) pid=$(systemctl --user show omg.service -p MainPID --value)"
  sleep 30; ids > "$W/na-ids-$LABEL.txt"
  missing=$(cut -d" " -f1 "$W/na-ids-$LABEL.txt" | sort | comm -23 "$W/voor-ids-$LABEL.txt" - | wc -l)
  errs=$(awk '$2=="error"||$2=="failed"' "$W/na-ids-$LABEL.txt" | wc -l)
  taken=$(curl -s -m5 -o /dev/null -w '%{http_code}' 127.0.0.1:8766/api/taken)
  idx=$(curl -s -m10 127.0.0.1:8766/); sam=0
  for a in $(echo "$idx" | grep -oE '/assets/[^"]+\.js' | sort -u); do
    c=$(curl -s -m20 "127.0.0.1:8766$a" | grep -cE 'tailda028c|kie-usage|samht|agentbox-mac'); sam=$((sam+c)); done
  log "POSTCHECK ontbrekend=$missing fout=$errs samstrings_bundle=$sam api_taken=$taken"
  log "RESULT=OK"; exit 0
fi
log "nieuw ONGEZOND, terug naar vorige boom"
journalctl --user -u omg.service -n 40 --no-pager | cut -c1-200 | grep -iE "error|fail|cannot" | tail -5 >> "$LOG"
systemctl --user stop omg.service
mv "$CUR" "$NEW.mislukt-$LABEL"; mv "$OLD" "$CUR"; systemctl --user start omg.service
for i in $(seq 1 60); do curl -sf -m5 -o /dev/null 127.0.0.1:8766/api/settings && { log "RESULT=ROLLED_BACK_OK"; exit 0; }; sleep 2; done
log "RESULT=ROLLBACK_FAILED"; exit 1
