#!/usr/bin/env python3
"""Taken-collector: verzamelt open werk voor Sam uit bestaande bronnen. Alleen lezen.

Bronnen:
- gesprek: omg-sessies waarvan het laatste bericht eindigt op een echte "Jij: ..." (niet "niks"),
  of die vastgelopen zijn.
- gedaan:  omg-sessies die vandaag eindigden op "Jij: niks".
- mail:    Gmail-inbox (contactexpertly, primair, 7 dagen, niet aan agent@) waar het laatste
           bericht niet van ons komt. Via Executor, alleen lezen.
- bestelling: orders in dpit met open aandachtspunt of zonder track & trace na 6 dagen.

Schrijft ~/.local/state/taken/items.json. Verstuurt niets, wijzigt niets in de bronnen.
"""
from __future__ import annotations
import hashlib, html, json, os, re, subprocess, sys, time, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from beslis import beslis, laatste_jij, sleutel  # noqa: E402
from datetime import datetime, timezone
from pathlib import Path

STATE = Path(os.environ.get("TAKEN_STATE", Path.home() / ".local/state/taken"))
OMG = os.environ.get("OMG_API", "http://127.0.0.1:8766")
EXECUTOR = str(Path.home() / "bin/executor-mcp")
NOW = time.time()


def iso(ts: float | None) -> str | None:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat() if ts else None


def one_line(t: str, n: int = 160) -> str:
    t = html.unescape(t or "")  # eerst &#39; -> ', anders sloopt de #-filter hieronder hem tot "&39;"
    t = re.sub(r"[`*#>]|\[([^\]]*)\]\([^)]*\)", lambda m: m.group(1) or "", t or "")
    t = re.sub(r"\s+", " ", t).strip()
    return t if len(t) <= n else t[: n - 1].rsplit(" ", 1)[0] + "…"


def first_sentence(t: str) -> str:
    t = re.sub(r"\s+", " ", re.sub(r"[`*#>]", "", t or "")).strip()
    t = re.sub(r"^Jij hoeft niets te doen[^.!?]*[.!?:]\s*", "", t) or t
    m = re.match(r"(.{20,220}?[.!?])(\s|$)", t)
    return one_line(m.group(1) if m else t, 200)


def vast_detail(text: str) -> str:
    """Leesbare reden voor een vastgelopen sessie; ruwe JSON-oordelen worden één zin."""
    t = (text or "").strip()
    m = re.search(r'"verdict"\s*:\s*"([A-Z_]+)"', t)
    if m:
        b = re.search(r'"blockers"\s*:\s*\[\s*"([^"]{3,200})', t)
        return one_line(f"Oordeel {m.group(1).lower()}" + (f": {b.group(1)}" if b else ", wacht op afronding"), 140)
    if re.search(r"capacity|rate.?limit|overloaded", t, re.I):
        return "Model had geen capaciteit, opnieuw starten"
    if re.search(r"terminated by signal|stopped unexpectedly", t, re.I):
        return "Agent stopte onverwacht, opnieuw starten"
    return one_line(t.split("\n")[-1] or "Vastgelopen", 140)


ARTIFACTS = Path(os.environ.get("OMG_DATA_DIR", Path.home() / "omg/data")) / "artifacts/index.json"


def artifacts_per_sessie() -> dict[str, list[dict]]:
    try:
        idx = json.loads(ARTIFACTS.read_text())
    except Exception:
        return {}
    out: dict[str, list[dict]] = {}
    for a in idx.values():
        if isinstance(a, dict) and a.get("sessionId"):
            out.setdefault(a["sessionId"], []).append(a)
    return out


def presentatie(arts: list[dict], at: float | None, text: str) -> list[dict]:
    """Bezos (Sam, 07-11-2026): wat de agent liet zien bij zijn vraag (beeld, video,
    audio, bestand) plus de links uit zijn laatste bericht, zodat Sam kan kiezen
    zonder het gesprek te openen. Alleen van de laatste uren van dit gesprek."""
    out = []
    if at:
        recent = [a for a in arts if a.get("createdAt", 0) / 1000 >= at - 6 * 3600]
        for a in sorted(recent, key=lambda a: a.get("createdAt", 0))[-4:]:
            mime = a.get("mimeType") or ""
            soort = "audio" if mime.startswith("audio") else a.get("media") or "file"
            out.append({"soort": soort, "id": a["id"], "naam": a.get("name") or "",
                        "onderschrift": one_line(a.get("caption") or a.get("title") or "", 120)})
    # Sam (07-11): "presentatie" = de pagina waar de agent laat zien wat hij wil gaan doen.
    # Eigen tailnet-pagina's zijn het voorstel (hoofdlink); overige links hooguit twee.
    eigen, rest, gezien = [], [], set()
    for u in re.findall(r"https?://[^\s)<>`\"'\]]+", text or ""):
        u = u.rstrip(".,;:!?*_")
        if u in gezien:
            continue
        gezien.add(u)
        if re.match(r"https?://[^/]*\.ts\.net(:\d+)?/", u):
            pad = re.sub(r"^https?://[^/]+", "", u).strip("/") or "pagina"
            eigen.append({"soort": "link", "hoofd": True, "url": u, "naam": one_line(pad.split("/")[0].replace("-", " "), 40)})
        else:
            rest.append({"soort": "link", "url": u, "naam": one_line(re.sub(r"^https?://(www\.)?", "", u), 60)})
    for a in out:
        if a["soort"] == "html":
            a["hoofd"] = True
    out += eigen[:3] + rest[:2]
    return out


def sessions() -> list[dict]:
    out = []
    data = json.load(urllib.request.urlopen(f"{OMG}/api/sessions", timeout=20))["sessions"]
    arts = artifacts_per_sessie()
    today = datetime.now().date()
    for s in data:
        last = (s.get("last") or {})
        text = last.get("text") or ""
        if last.get("role") not in (None, "assistant"):
            continue
        sid = s["sessionId"]
        title = one_line(s.get("title") or "Gesprek", 70)
        at = (s.get("lastActivityAt") or 0) / 1000 or None
        machine = bool(s.get("botName")) or title.startswith(("Mailtaak", "Mail-intake"))
        jij = laatste_jij(text)
        # bericht: id van het laatste bericht; de UI ziet zo meteen dat het gesprek verder ging.
        base = {"sessie": sid, "tijd": iso(at), "machine": machine, "bericht": last.get("id")}
        if s.get("status") == "blocked":
            # Een gesprek dat al een week vastzit is geen taak meer, alleen ruis in Ter info.
            if at and time.time() - at > 7 * 86400:
                continue
            out.append({**base, "id": f"gesprek:{sid}:vast", "bron": "gesprek", "soort": "vast",
                        "titel": title, "detail": vast_detail(text)})
            continue
        if s.get("busy"):
            continue
        if jij:
            j, j_vol = jij
            if re.match(r"niks\b", j, re.I):
                if at and datetime.fromtimestamp(at).date() == today:
                    out.append({**base, "id": f"gedaan:{sid}:{int(at)}", "bron": "gedaan", "soort": "gedaan",
                                "titel": title, "detail": first_sentence(text)})
            else:
                # sleutel op de tekst: een nieuwe vraag in hetzelfde gesprek is een nieuwe taak
                key = sleutel(j)
                # Bezos: welke knoppen (ja/nee, A/B, gedaan) en wat er gebeurde, in één zin.
                out.append({**base, "id": f"gesprek:{sid}:{key}", "bron": "gesprek", "soort": "vraag",
                            "titel": one_line(j, 200), "detail": title,
                            "beslis": beslis(j_vol, text),
                            "presentatie": presentatie(arts.get(sid, []), at, text),
                            "wat": first_sentence("\n".join(l for l in text.splitlines() if not re.match(r"\W*Jij\b", l)))})
    return out


GMAIL_JS = r"""
const q = "in:inbox category:primary newer_than:7d -to:agent@1704media.nl";
const g = tools.google_gmail.user.contactexpertly.gmail.users;
const r = await g.threads.list({userId:"me", q, maxResults:40});
if (!r || r.ok !== true || r.http?.status !== 200) throw new Error("threadlijst mislukt");
const out = [];
for (const t of (r.data.threads || [])) {
  const d = await g.threads.get({userId:"me", id:t.id, format:"metadata", metadataHeaders:["From","Subject","Date"]});
  if (!d || d.ok !== true) continue;
  const msgs = d.data.messages || [];
  const last = msgs[msgs.length-1] || {};
  const h = Object.fromEntries((last.payload?.headers||[]).map(x=>[x.name,x.value]));
  const first = Object.fromEntries((msgs[0]?.payload?.headers||[]).map(x=>[x.name,x.value]));
  out.push({id:t.id, from:h.From||"", subject:first.Subject||h.Subject||"", snippet:last.snippet||"",
            labels:last.labelIds||[], internalDate:Number(last.internalDate||0), count:msgs.length});
}
return {ok:true, complete:!r.data.nextPageToken, threads:out};
"""


AUTOMAAT = re.compile(r"no-?reply|noreply|notificat|mailer|administratie|beheer|wordpress@|woocommerce|"
                      r"^\[|nieuwe bestelling|factuur|invoice|receipt|backlink offline|bevestiging|ahrefs|site audit|slow page|slow server|orphan page|broken page", re.I)


def is_melding(van: str, onderwerp: str) -> bool:
    """Automatische meldingen (shopnotificaties, facturen, monitors): wel tonen, niet als taak."""
    return bool(AUTOMAAT.search(van) or AUTOMAAT.search(onderwerp))


def mails() -> list[dict]:
    p = subprocess.run([EXECUTOR, "call", "execute", json.dumps({"code": GMAIL_JS})],
                       capture_output=True, text=True, timeout=240)
    res = json.loads(p.stdout)["result"]["structuredContent"]
    if res.get("status") != "completed":
        raise RuntimeError("executor gaf geen completed")
    out = []
    for t in res["result"]["threads"]:
        if "SENT" in t["labels"]:
            continue  # laatste bericht komt van ons
        name = re.sub(r"\s*<[^>]+>", "", t["from"]).strip().strip('"') or t["from"]
        melding = is_melding(t["from"], t["subject"] or "")
        out.append({"id": f"mail:{t['id']}", "bron": "mail", "soort": "melding" if melding else "mail",
                    "titel": one_line(t["subject"] or "(geen onderwerp)", 120),
                    "detail": one_line(t["snippet"], 160), "wie": one_line(name, 50),
                    "ongelezen": "UNREAD" in t["labels"],
                    "link": f"https://mail.google.com/mail/u/?authuser=contactexpertly@gmail.com#all/{t['id']}",
                    "tijd": iso(t["internalDate"] / 1000 if t["internalDate"] else None)})
    return out


ORDERS_PY = r"""
import json, datetime
from django.utils import timezone
from django.db.models import Q
from orders.models import Order
now = timezone.now()
qs = Order.objects.exclude(status__in=["delivered","cancelled","refunded"]).filter(
    Q(internal_attention_required_at__isnull=False, open_loops_dismissed_at__isnull=True)
    | Q(status__in=["new","processing"], created_at__lt=now-datetime.timedelta(days=6), tracking_number__in=["",None])
).filter(created_at__gte=now-datetime.timedelta(days=90), fraud_hold=False)
out = []
for o in qs.order_by("created_at")[:60]:
    out.append({"pk":o.pk, "nr":o.order_number, "shop":o.store.name if o.store else "", "status":o.status,
                "klant":o.customer_status, "naam":o.customer_name, "uitzondering":o.tracking_exception_label or "",
                "tracking":bool(o.tracking_number), "besteld":o.created_at.isoformat(),
                "aandacht":o.internal_attention_required_at.isoformat() if o.internal_attention_required_at else None})
print("TAKEN_JSON" + json.dumps(out))
"""


def orders() -> list[dict]:
    p = subprocess.run(["ssh", "-o", "BatchMode=yes", "netcup-vps8000-wp",
                        "sudo docker exec -i dpit_web python manage.py shell"],
                       input=ORDERS_PY, capture_output=True, text=True, timeout=90)
    line = next((l for l in p.stdout.splitlines() if l.startswith("TAKEN_JSON")), None)
    if line is None:
        raise RuntimeError("geen orderuitvoer")
    out = []
    for o in json.loads(line[len("TAKEN_JSON"):]):
        days = (NOW - datetime.fromisoformat(o["besteld"]).timestamp()) / 86400
        if o["uitzondering"] or o["klant"] == "delayed":
            why = f"vertraagd ({o['uitzondering'] or o['klant']})"
        elif not o["tracking"]:
            why = f"nog geen track & trace na {int(days)} dagen"
        else:
            why = "vraagt aandacht"
        out.append({"id": f"bestelling:{o['pk']}", "bron": "bestelling", "soort": "bestelling",
                    "titel": f"#{str(o['nr']).lstrip('#')} {o['shop']}", "detail": why, "wie": one_line(o["naam"] or "", 40),
                    "link": f"https://orders.nummerschilderen.com/admin/orders/order/{o['pk']}/change/",
                    "tijd": o["aandacht"] or o["besteld"]})
    return out


def main() -> int:
    STATE.mkdir(parents=True, exist_ok=True)
    prev = {}
    f = STATE / "items.json"
    if f.exists():
        try:
            prev = json.loads(f.read_text())
        except Exception:
            prev = {}
    result = {"bijgewerkt": iso(NOW), "bronnen": {}, "items": []}
    for name, fn in (("gesprek", sessions), ("mail", mails), ("bestelling", orders)):
        try:
            items = fn()
            result["items"] += items
            result["bronnen"][name] = {"ok": True, "aantal": len(items), "om": iso(NOW)}
        except Exception as e:  # bron faalt: vorige items van die bron blijven staan
            keep = [i for i in prev.get("items", []) if i["bron"] == name or (name == "gesprek" and i["bron"] == "gedaan")]
            result["items"] += keep
            old = prev.get("bronnen", {}).get(name, {})
            result["bronnen"][name] = {"ok": False, "fout": type(e).__name__ + ": " + str(e)[:160],
                                       "aantal": len(keep), "om": old.get("om")}
    first_seen = {i["id"]: i.get("gezien") for i in prev.get("items", [])}
    for i in result["items"]:
        i["gezien"] = first_seen.get(i["id"]) or iso(NOW)
    tmp = f.with_suffix(".tmp")
    tmp.write_text(json.dumps(result, ensure_ascii=False, indent=1))
    tmp.replace(f)
    print(json.dumps(result["bronnen"], ensure_ascii=False))
    return 0 if all(b["ok"] for b in result["bronnen"].values()) else 2


if __name__ == "__main__":
    sys.exit(main())
