#!/usr/bin/env python3
"""Vaste automatische mails vanzelf uit de inbox (Sam, 07-11-2026: "Ja").

Alleen drie soorten, niets anders:
  - previews van de converters ("Preview: <klant>" van paintingbynumbers / Diamond Painting Converter);
  - DMARC-rapporten;
  - LinkedIn-meldingen.
Draait na elke collector-ronde (ExecStartPost) en gaat via de taken-API, dezelfde route als
"Alles gezien": één archivering per mail, alleen meldingen, alleen de inbox-label eraf.
Elke archivering komt in auto-archief.jsonl.
"""
from __future__ import annotations
import json, os, re, sys, urllib.request
from datetime import datetime, timezone
from pathlib import Path

STATE = Path(os.environ.get("TAKEN_STATE", Path.home() / ".local/state/taken"))
API = f"http://127.0.0.1:{os.environ.get('TAKEN_PORT', '8790')}"

REGELS = [
    ("preview", lambda w, t: t.startswith("Preview:") and re.search(r"paintingbynumbers|diamond painting converter", w, re.I)),
    ("dmarc", lambda w, t: re.search(r"dmarc", w, re.I) or t.startswith("[Preview] Report Domain:")),
    ("linkedin", lambda w, t: re.fullmatch(r"linkedin", w.strip(), re.I)),
]


def soort(i: dict) -> str | None:
    if i.get("bron") != "mail" or i.get("soort") != "melding" or not i["id"].startswith("mail:"):
        return None
    w, t = i.get("wie") or "", i.get("titel") or ""
    return next((n for n, f in REGELS if f(w, t)), None)


def main() -> int:
    items = json.loads((STATE / "items.json").read_text()).get("items", [])
    st = json.loads((STATE / "status.json").read_text()) if (STATE / "status.json").exists() else {}
    doel = [(i, s) for i in items if (s := soort(i)) and st.get(i["id"], {}).get("status") != "gedaan"][:40]
    if not doel:
        return 0
    req = urllib.request.Request(f"{API}/api/taken/alles-gezien", method="POST", headers={"Content-Type": "application/json"},
                                 data=json.dumps({"ids": [i["id"] for i, _ in doel]}).encode())
    uit = {r["id"]: r for r in json.load(urllib.request.urlopen(req, timeout=300)).get("resultaat", [])}
    nu = datetime.now(timezone.utc).isoformat()
    with open(STATE / "auto-archief.jsonl", "a") as f:
        for i, s in doel:
            r = uit.get(i["id"], {})
            f.write(json.dumps({"om": nu, "id": i["id"], "regel": s, "van": i.get("wie"), "onderwerp": i.get("titel"),
                                "ok": r.get("ok"), "fout": r.get("fout")}, ensure_ascii=False) + "\n")
    print(f"auto-archief: {sum(1 for r in uit.values() if r.get('ok'))} van {len(doel)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
