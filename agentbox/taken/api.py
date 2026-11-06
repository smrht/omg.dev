#!/usr/bin/env python3
"""Taken-API voor de omg-UI. Leest items.json van de collector en bewaart Sams afvinkstatus.

GET  /api/taken                 -> items met status (open, later, gedaan)
POST /api/taken/item/<id>       -> body {"status": "gedaan"|"later"|"open"}
POST /api/taken/verversen       -> start de collector op de achtergrond
Luistert alleen op 127.0.0.1. Verstuurt niets naar buiten.
"""
from __future__ import annotations
import json, os, subprocess, sys, threading, time, urllib.parse
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

STATE = Path(os.environ.get("TAKEN_STATE", Path.home() / ".local/state/taken"))
PORT = int(os.environ.get("TAKEN_PORT", "8790"))
COLLECT = Path(__file__).with_name("collect.py")
LOCK = threading.Lock()
running = {"p": None}


def load(name: str, default):
    try:
        return json.loads((STATE / name).read_text())
    except Exception:
        return default


def save_status(st: dict) -> None:
    tmp = STATE / "status.tmp"
    tmp.write_text(json.dumps(st, ensure_ascii=False, indent=1))
    tmp.replace(STATE / "status.json")


def merged() -> dict:
    data = load("items.json", {"items": [], "bronnen": {}})
    st = load("status.json", {})
    now = datetime.now(timezone.utc)
    items = []
    for i in data.get("items", []):
        s = st.get(i["id"], {})
        status = s.get("status", "open")
        if status == "later" and s.get("tot") and datetime.fromisoformat(s["tot"]) <= now:
            status = "open"
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
                if status == "open":
                    st.pop(iid, None)
                else:
                    now = datetime.now(timezone.utc)
                    st[iid] = {"status": status, "om": now.isoformat()}
                    if status == "later":
                        st[iid]["tot"] = (now + timedelta(hours=int(body.get("uren", 20)))).isoformat()
                save_status(st)
            return self._send(200, {"ok": True, "id": iid, "status": status})
        self._send(404, {"error": "not found"})


if __name__ == "__main__":
    STATE.mkdir(parents=True, exist_ok=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
