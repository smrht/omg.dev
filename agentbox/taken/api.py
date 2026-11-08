#!/usr/bin/env python3
"""Taken-API voor de omg-UI. Leest items.json van de collector en bewaart Sams afvinkstatus.

GET  /api/taken                 -> items met status (open, later, gedaan)
POST /api/taken/item/<id>       -> body {"status": "gedaan"|"later"|"open"}
POST /api/taken/verversen       -> start de collector op de achtergrond
POST /api/taken/item/<id>/antwoord -> body {"antwoord": "Ja"}: Bezos-knop, stuurt het antwoord
                                   naar de chat die de vraag stelde (alleen als die vraag nog staat)
POST /api/taken/alles-gezien    -> body {"ids": [...]}: meldingen afhandelen, één voor één
Luistert alleen op 127.0.0.1. Stuurt alleen Sams eigen antwoord naar zijn eigen omg-chat.

Mail (Sam, 07-11-2026): "gedaan" op een mailtaak (ook via Opdracht geven, dat zet hem
op gedaan zodra de chat start) archiveert die ene Gmail-draad: label INBOX eraf. Terug
naar open of later zet INBOX er weer op. Sams klik is de goedkeuring voor precies die
draad; de Executor-pauze wordt alleen hervat als adres, draad en labels kloppen.
Nooit verwijderen, nooit andere labels.
"""
from __future__ import annotations
import json, os, re, subprocess, sys, threading, time, urllib.error, urllib.parse, urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from beslis import laatste_jij, sleutel  # noqa: E402

STATE = Path(os.environ.get("TAKEN_STATE", Path.home() / ".local/state/taken"))
PORT = int(os.environ.get("TAKEN_PORT", "8790"))
COLLECT = Path(__file__).with_name("collect.py")
LOCK = threading.Lock()
GMAIL_LOCK = threading.Lock()
EXECUTOR = str(Path.home() / "bin/executor-mcp")
MODIFY = "tools.google_gmail.user.contactexpertly.gmail.users.threads.modify"
running = {"p": None}


def _executor(tool: str, args: dict) -> dict:
    p = subprocess.run([EXECUTOR, "call", tool, json.dumps(args)], capture_output=True, text=True, timeout=120)
    res = json.loads(p.stdout)["result"]
    return res.get("structuredContent") or {"status": "error", "error": str(res)[:200]}


def gmail_inbox(thread: str, archive: bool) -> tuple[bool, str]:
    """Haal INBOX van een draad af (archive) of zet hem terug. Eén draad, alleen INBOX."""
    if not re.fullmatch(r"[0-9a-f]{10,24}", thread):
        return False, "ongeldige draad-id"
    if os.environ.get("TAKEN_DRY_SEND") == "1":
        return True, "dry: niet gearchiveerd"  # staging: Gmail blijft onaangeroerd
    key = "removeLabelIds" if archive else "addLabelIds"
    code = (f'const m = await {MODIFY}({{userId:"me", id:{json.dumps(thread)}, body:{{{key}:["INBOX"]}}}});'
            ' return {ok: m.ok === true, status: m.http?.status ?? null};')
    with GMAIL_LOCK:
        r = _executor("execute", {"code": code})
        if r.get("status") == "waiting_for_interaction":
            it = r.get("interaction") or {}
            a = it.get("args") or {}
            if it.get("address") != MODIFY or a.get("id") != thread or a.get("body") != {key: ["INBOX"]}:
                _executor("resume", {"executionId": r["executionId"], "action": "decline", "content": "{}"})
                return False, "onverwachte goedkeuringsvraag, geweigerd"
            r = _executor("resume", {"executionId": r["executionId"], "action": "accept", "content": "{}"})
    out = r.get("result") or {}
    if r.get("status") == "completed" and out.get("ok") and out.get("status") == 200:
        return True, "ok"
    return False, str(r.get("error") or out)[:160]


def mail_bijwerken(iid: str, archive: bool) -> None:
    ok, msg = gmail_inbox(iid[len("mail:"):], archive)
    with LOCK:
        st = load("status.json", {})
        rec = st.get(iid)
        if archive and rec is not None:
            rec["gearchiveerd"] = ok
            if not ok:
                rec["archieffout"] = msg
            save_status(st)
        elif not archive and ok and rec is not None:
            rec.pop("gearchiveerd", None)
            save_status(st)
    print(f"gmail {'archief' if archive else 'terug'} {iid}: {msg}", file=sys.stderr, flush=True)


def load(name: str, default):
    try:
        return json.loads((STATE / name).read_text())
    except Exception:
        return default


def save_status(st: dict) -> None:
    tmp = STATE / "status.tmp"
    tmp.write_text(json.dumps(st, ensure_ascii=False, indent=1))
    tmp.replace(STATE / "status.json")


OMG = os.environ.get("OMG_API", "http://127.0.0.1:8766")
_sessies = {"om": 0.0, "ids": None}


def live_sessies() -> set[str] | None:
    """Sessie-ids die omg nu toont (15 s cache). None = onbekend, dan niets wegfilteren."""
    if time.time() - _sessies["om"] > 15:
        try:
            data = json.load(urllib.request.urlopen(f"{OMG}/api/sessions", timeout=5))["sessions"]
            _sessies["ids"] = {s["sessionId"] for s in data}
        except Exception:
            _sessies["ids"] = None
        _sessies["om"] = time.time()
    return _sessies["ids"]


def merged() -> dict:
    data = load("items.json", {"items": [], "bronnen": {}})
    # Een chat die sinds de laatste collectorronde is gearchiveerd of gesloten, is geen
    # open vraag meer; een tik erop opende niets (Sam, 07-11-2026). Direct weglaten.
    live = live_sessies()
    if live is not None:
        data["items"] = [i for i in data.get("items", [])
                         if not (i.get("sessie") and i.get("soort") in ("vraag", "vast") and i["sessie"] not in live)]
    st = load("status.json", {})
    now = datetime.now(timezone.utc)
    items = []
    for i in data.get("items", []):
        s = st.get(i["id"], {})
        status = s.get("status", "open")
        if status == "later" and s.get("tot") and datetime.fromisoformat(s["tot"]) <= now:
            status = "open"
        # Nieuw bericht in dezelfde draad, opnieuw gemarkeerde bestelling: weer open.
        if status != "open" and i.get("tijd") and s.get("om") and i.get("soort") != "gedaan":
            try:
                if datetime.fromisoformat(i["tijd"]) > datetime.fromisoformat(s["om"]):
                    status = "open"
            except ValueError:
                pass
        items.append({**i, "status": status, "afgevinkt": s.get("om")})
    return {"bijgewerkt": data.get("bijgewerkt"), "bronnen": data.get("bronnen", {}),
            "ververst": running["p"] is not None and running["p"].poll() is None, "items": items}


DRY = os.environ.get("TAKEN_DRY_SEND") == "1"
OMG_USER = os.environ.get("TAKEN_USER", "contactexpertly@gmail.com")
ANTWOORD_ID = re.compile(r"gesprek:([0-9a-f-]{36}):([0-9a-f]{8}|vast)")


def antwoord_tekst(antwoord: str, vraag: str) -> str:
    # Antwoord eerst: de agent leest de eerste regel als Sams keuze (zelfde reden als
    # formatPushbackAnswerText in omg: een afgeknipte staart mag de keuze niet kosten).
    return f"{antwoord}\n\n(Gekozen in Bezos, op je vraag: \"{vraag}\")"


def _omg_post(path: str, body: dict, timeout: int = 30) -> None:
    req = urllib.request.Request(f"{OMG}{path}", method="POST", headers={"Content-Type": "application/json"},
                                 data=json.dumps(body).encode())
    try:
        urllib.request.urlopen(req, timeout=timeout).read()
    except urllib.error.HTTPError as e:
        try:
            fout = json.loads(e.read().decode() or "{}").get("error") or ""
        except Exception:
            fout = ""
        raise RuntimeError(fout[:160] or f"HTTP {e.code}") from None


MODEL_RE = re.compile(r"[A-Za-z0-9._:/@+-]{1,80}")
DENK_RE = re.compile(r"[a-z]{2,12}")


def beantwoord(iid: str, antwoord: str, model: str | None = None, denk: str | None = None) -> tuple[int, dict]:
    """Bezos-knop. Drie sloten: de vraag moet nog precies zo in de chat staan (geen laat 'Ja'
    op een nieuwe vraag), één antwoord per vraag (dubbel tikken, tweede toestel), en pas
    daarna versturen."""
    m = ANTWOORD_ID.fullmatch(iid)
    antwoord = (antwoord or "").strip()
    if not m or not antwoord or len(antwoord) > 160:
        return 400, {"error": "ongeldige vraag of antwoord"}
    sid, key = m.groups()
    if (model and not MODEL_RE.fullmatch(model)) or (denk and not DENK_RE.fullmatch(denk)):
        return 400, {"error": "ongeldig model of denkniveau"}
    item = next((i for i in load("items.json", {}).get("items", []) if i["id"] == iid), None)
    if not item:
        return 404, {"error": "vraag niet gevonden"}
    try:
        data = json.load(urllib.request.urlopen(f"{OMG}/api/sessions", timeout=8))["sessions"]
    except Exception:
        return 503, {"error": "omg niet bereikbaar"}
    sess = next((x for x in data if x.get("sessionId") == sid), None)
    if not sess:
        return 409, {"error": "gesprek bestaat niet meer", "verouderd": True}
    last = sess.get("last") or {}
    if key == "vast":
        if sess.get("status") != "blocked":
            return 409, {"error": "gesprek loopt alweer", "verouderd": True}
    else:
        nu = laatste_jij(last.get("text") or "") if last.get("role") in (None, "assistant") else None
        if sess.get("busy") or not nu or sleutel(nu[0]) != key:
            return 409, {"error": "de vraag is veranderd, open het gesprek", "verouderd": True}
    with LOCK:
        st = load("status.json", {})
        if (st.get(iid) or {}).get("beantwoord"):
            return 409, {"error": "al beantwoord", "beantwoord": st[iid]["beantwoord"]}
        now = datetime.now(timezone.utc).isoformat()
        st[iid] = {"status": "gedaan", "om": now, "beantwoord": {"antwoord": antwoord, "om": now, "dry": DRY}}
        save_status(st)
    b = item.get("beslis") or {}
    text = antwoord_tekst(antwoord, b.get("vraag") or b.get("ja") or item.get("titel") or "")
    # Sam (07-11): in de kaart kiest hij welk model en denkniveau het uitvoert. Pas wisselen
    # na de versheidscontrole en de reservering, zodat een verouderde vraag niets omzet.
    model = model if model and model != sess.get("model") else None
    denk = denk if denk and denk != sess.get("thinkingLevel") else None
    stap = "versturen"
    try:
        if DRY:
            with open(STATE / "antwoorden-dry.jsonl", "a") as f:
                f.write(json.dumps({"sessie": sid, "text": text, "model": model, "denk": denk, "om": now}, ensure_ascii=False) + "\n")
        else:
            if model:
                stap = "model wisselen"
                _omg_post(f"/api/sessions/{sid}/model", {"model": model}, 60)
            if denk:
                stap = "denkniveau wisselen"
                _omg_post(f"/api/sessions/{sid}/thinking-level", {"thinkingLevel": denk})
            stap = "versturen"
            _omg_post(f"/api/sessions/{sid}/send", {"text": text, "mode": "steer", "user": OMG_USER})
    except Exception as e:
        with LOCK:  # niet aangekomen: vraag weer open, zodat Sam het opnieuw kan doen
            st = load("status.json", {})
            st.pop(iid, None)
            save_status(st)
        reden = str(e) if isinstance(e, RuntimeError) else type(e).__name__
        return 502, {"error": f"{stap} mislukt: {reden}"}
    print(f"bezos {iid}: {antwoord}{' (dry)' if DRY else ''}", file=sys.stderr, flush=True)
    return 200, {"ok": True, "id": iid, "antwoord": antwoord, "dry": DRY}


def alles_gezien(ids: list) -> tuple[int, dict]:
    """Ter-info-meldingen afhandelen. Alleen meldingen (geen mail van mensen), één voor één,
    zodat een mislukte archivering zichtbaar blijft in plaats van stil over te slaan."""
    items = {i["id"]: i for i in load("items.json", {}).get("items", [])}
    if not isinstance(ids, list) or len(ids) > 40:
        return 400, {"error": "maximaal 40 ids"}
    uit = []
    for iid in ids:
        i = items.get(iid)
        if not i or i.get("soort") != "melding":
            uit.append({"id": iid, "ok": False, "fout": "geen melding"})
            continue
        with LOCK:
            st = load("status.json", {})
            st[iid] = {"status": "gedaan", "om": datetime.now(timezone.utc).isoformat()}
            save_status(st)
        if iid.startswith("mail:"):
            mail_bijwerken(iid, True)
            rec = load("status.json", {}).get(iid, {})
            uit.append({"id": iid, "ok": bool(rec.get("gearchiveerd")), "fout": rec.get("archieffout")})
        else:
            uit.append({"id": iid, "ok": True})
    return 200, {"ok": all(u["ok"] for u in uit), "resultaat": uit}


class H(BaseHTTPRequestHandler):
    def _send(self, code: int, body: dict) -> None:
        raw = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.split("?")[0] in ("/api/taken", "/api/taken/"):
            return self._send(200, merged())
        self._send(404, {"error": "not found"})

    def do_POST(self):
        path = self.path.split("?")[0]
        if path == "/api/taken/perf":
            # Meting van de terugswipe op Sams iPhone (08-11-2026): alleen aanvullen, max 8 KB per regel.
            raw = self.rfile.read(min(int(self.headers.get("Content-Length") or 0), 8192))
            try:
                rec = json.loads(raw or b"{}")
            except Exception:
                return self._send(400, {"error": "geen geldige json"})
            rec["ontvangen"] = datetime.now(timezone.utc).isoformat()
            with open(STATE / "perf.jsonl", "a") as f:
                f.write(json.dumps(rec, ensure_ascii=False)[:8192] + "\n")
            return self._send(200, {"ok": True})
        if path == "/api/taken/verversen":
            with LOCK:
                if running["p"] is None or running["p"].poll() is not None:
                    running["p"] = subprocess.Popen([sys.executable, str(COLLECT)],
                                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return self._send(202, {"ok": True})
        if path in ("/api/taken/alles-gezien",) or (path.startswith("/api/taken/item/") and path.endswith("/antwoord")):
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            except Exception:
                return self._send(400, {"error": "geen geldige json"})
            if path == "/api/taken/alles-gezien":
                return self._send(*alles_gezien(body.get("ids") or []))
            iid = urllib.parse.unquote(path[len("/api/taken/item/"):-len("/antwoord")])
            return self._send(*beantwoord(iid, str(body.get("antwoord") or ""),
                                          str(body.get("model") or "") or None, str(body.get("denk") or "") or None))
        if path.startswith("/api/taken/item/"):
            iid = urllib.parse.unquote(path[len("/api/taken/item/"):])
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            except Exception:
                return self._send(400, {"error": "geen geldige json"})
            status = body.get("status")
            if status not in ("gedaan", "later", "open"):
                return self._send(400, {"error": "status moet gedaan, later of open zijn"})
            with LOCK:
                st = load("status.json", {})
                was_archief = bool(st.get(iid, {}).get("gearchiveerd"))
                if status == "open":
                    st.pop(iid, None)
                else:
                    now = datetime.now(timezone.utc)
                    st[iid] = {"status": status, "om": now.isoformat()}
                    if status == "later":
                        st[iid]["tot"] = (now + timedelta(hours=int(body.get("uren", 20)))).isoformat()
                    if status != "gedaan" and was_archief:
                        st[iid]["gearchiveerd"] = True  # tot de terugzet gelukt is
                save_status(st)
            if iid.startswith("mail:"):
                if status == "gedaan":  # ook opnieuw: een nieuw antwoord zet de draad terug in de inbox
                    threading.Thread(target=mail_bijwerken, args=(iid, True), daemon=True).start()
                elif status != "gedaan" and was_archief:
                    threading.Thread(target=mail_bijwerken, args=(iid, False), daemon=True).start()
            return self._send(200, {"ok": True, "id": iid, "status": status})
        self._send(404, {"error": "not found"})


if __name__ == "__main__":
    STATE.mkdir(parents=True, exist_ok=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
