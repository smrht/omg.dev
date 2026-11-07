#!/bin/bash
# Pollt Albins overstaplog; bij RESULT= een Telegram naar Sam via de alertbot op netcup-vps8000.
for i in $(seq 1 600); do
  r=$(ssh -o BatchMode=yes -o ConnectTimeout=10 broer-box 'grep -h "RESULT=" ~/.cache/omg-cutover/cutover.log | tail -1; grep -h "nieuw gezond" ~/.cache/omg-cutover/cutover.log | tail -1' 2>/dev/null)
  if echo "$r" | grep -q RESULT=; then
    res=$(echo "$r" | grep -o 'RESULT=[A-Z_]*' | cut -d= -f2)
    case $res in OK)
        pc=$(ssh -o BatchMode=yes broer-box 'grep -h POSTCHECK ~/.cache/omg-cutover/cutover.log | tail -1' | grep -oE 'ontbrekend=.*')
        ssh -o BatchMode=yes -o ExitOnForwardFailure=yes -N -L 18766:127.0.0.1:8766 broer-box & TP=$!; sleep 4
        PRE_JS='localStorage.removeItem("lfg_user");localStorage.removeItem("lfg_v2_user_filter")' SCHEME=dark timeout 180 agentbox-test-browser --name albin-overstap --run-test /home/agent/.bun/bin/bun /home/agent/omg-agentbox/agentbox/tools/shot.ts http://127.0.0.1:18766/ /home/agent/.cache/agent-tmp/omg-cutover/albin >> ~/.cache/agent-tmp/omg-cutover/broer-melder.log 2>&1
        kill $TP 2>/dev/null
        txt="Albins box draait nu onze omg-versie (profiel neutraal, updates uit). $(echo "$r" | grep -o 'sessies=[0-9]* (voor [0-9]*)'). Nacontrole: $pc. Screenshots staan op agentbox2 in ~/.cache/agent-tmp/omg-cutover/albin-*.png";;
      ROLLED_BACK_OK) txt="Overstap Albins box mislukte de check en is automatisch teruggezet naar zijn oude versie. Niks kapot; ik kijk ernaar.";;
      GEEN_STIL_VENSTER) txt="Albins box was 36 uur nooit 20 min stil; overstap niet gedaan.";;
      *) txt="LET OP: overstap Albins box: $res. Zijn omg draait mogelijk niet.";; esac
    echo "$(date -Is) $res" >> ~/.cache/agent-tmp/omg-cutover/broer-melder.log
    printf '%s' "$txt" | ssh netcup-vps8000 'sudo python3 -c "
import json,subprocess,sys
c={}
for l in open(\"/root/.telegram-alert.conf\"):
    if \"=\" in l: k,v=l.strip().split(\"=\",1); c[k.strip()]=v.strip().strip(chr(34)).strip(chr(39))
t,ch=c.get(\"TG_TOKEN\") or c.get(\"TOKEN\"), c.get(\"TG_CHAT\") or c.get(\"CHAT_ID\")
r=subprocess.run([\"curl\",\"-s\",\"--data-urlencode\",\"chat_id=\"+ch,\"--data-urlencode\",\"text=\"+sys.stdin.read(),\"https://api.telegram.org/bot\"+t+\"/sendMessage\"],capture_output=True,text=True)
print(\"ok\" if json.loads(r.stdout or \"{}\").get(\"ok\") else \"FOUT\")"' >> ~/.cache/agent-tmp/omg-cutover/broer-melder.log 2>&1
    exit 0
  fi
  sleep 300
done
