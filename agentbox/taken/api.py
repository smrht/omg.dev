#!/usr/bin/env python3
"""Taken-API voor de omg-UI. Leest items.json van de collector en bewaart Sams afvinkstatus.

GET  /api/taken                 -> items met status (open, later, gedaan)
POST /api/taken/item/<id>       -> body {"status": "gedaan"|"later"|"open"}
POST /api/taken/verversen       -> start de collector op de achtergrond
Luistert alleen op 127.0.0.1. Verstuurt niets naar buiten.

Mail (Sam, 07-11-2026): "gedaan" op een mailtaak (ook via Opdracht geven, dat zet hem
op gedaan zodra de chat start) archiveert die ene Gmail-draad: label INBOX eraf. Terug
naar open of later zet INBOX er weer op. Sams klik is de goedkeuring voor precies die
draad; de Executor-pauze wordt alleen hervat als adres, draad en labels kloppen.
Nooit verwijderen, nooit andere labels.
"""
from __future__ import annotations
import json, os, re, subprocess, sys, threading, time, urllib.parse, urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

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
        if path == "/api/taken/verversen":
            with LOCK:
                if running["p"] is None or running["p"].poll() is not None:
                    running["p"] = subprocess.Popen([sys.executable, str(COLLECT)],
                                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return self._send(202, {"ok": True})
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
