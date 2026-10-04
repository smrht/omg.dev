#!/usr/bin/env python3
"""Fixture provider for the E2E suite: answers --version / auth status /
login status, then speaks the claude stream-json or codex app-server JSON-RPC
protocol on stdin/stdout, and records its argv/env/cwd + every received turn
into dump files for assertions. Deterministic; no model, no network."""
import json, os, sys

def dump(name, data):
    out = os.environ.get("E2E_DUMP_DIR")
    if out:
        with open(os.path.join(out, name), "a") as f:
            f.write(json.dumps(data, sort_keys=True) + "\n")

args = sys.argv[1:]
if args[:1] == ["--version"]:
    print("e2e-fixture-1.0.0")
    sys.exit(0)
if args[:2] == ["auth", "status"]:
    print('{\n  "loggedIn": true,\n  "authMethod": "claude.ai",\n  "subscriptionType": "max"\n}')
    sys.exit(0)
if args[:2] == ["login", "status"]:
    print("Logged in using ChatGPT")
    sys.exit(0)

dump("provider-launch.json", {"argv": args, "cwd": os.getcwd(),
      "env_keys": sorted(os.environ.keys())})

def out(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

codex = "app-server" in args
buffer = ""
while True:
    data = os.read(0, 65536)
    if not data:
        break
    buffer += data.decode("utf-8", "replace")
    while "\n" in buffer:
        line, buffer = buffer.split("\n", 1)
        if not line.strip():
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        dump("provider-turns.jsonl", msg)
        if codex:
            method, mid = msg.get("method"), msg.get("id")
            if method == "initialize":
                out({"jsonrpc": "2.0", "id": mid, "result": {"capabilities": {"experimentalApi": True}}})
            elif method == "thread/start":
                out({"jsonrpc": "2.0", "id": mid, "result": {"thread": {"id": "e2e-thread-1"}}})
                out({"jsonrpc": "2.0", "method": "thread/started", "params": {"threadId": "e2e-thread-1"}})
            elif method == "thread/resume":
                out({"jsonrpc": "2.0", "id": mid, "result": {"thread": {"id": msg["params"]["threadId"]}}})
            elif method == "turn/start":
                text = "|".join(p.get("text", "<%s>" % p.get("type")) for p in msg["params"].get("input", []))
                out({"jsonrpc": "2.0", "id": mid, "result": {"turn": {"id": "t1", "status": "inProgress"}}})
                out({"jsonrpc": "2.0", "method": "item/completed",
                     "params": {"threadId": msg["params"]["threadId"],
                                "item": {"type": "agentMessage", "id": "i1", "text": "e2e:" + text[:120]}}})
                out({"jsonrpc": "2.0", "method": "turn/completed",
                     "params": {"threadId": msg["params"]["threadId"], "turn": {"id": "t1", "status": "completed"}}})
            elif method and mid is not None:
                out({"jsonrpc": "2.0", "id": mid, "result": {}})
        else:
            if msg.get("type") == "control_request":
                out({"type": "control_response", "response": {"subtype": "success", "request_id": msg.get("request_id")}})
            elif msg.get("type") == "user":
                out({"type": "system", "subtype": "init", "session_id": "e2e-session"})
                content = msg.get("message", {}).get("content")
                text = content if isinstance(content, str) else json.dumps(content)
                out({"type": "assistant", "message": {"role": "assistant",
                     "content": [{"type": "text", "text": "e2e:" + text[:120]}]}})
                out({"type": "result", "subtype": "success", "result": "e2e-done",
                     "usage": {"input_tokens": 3, "output_tokens": 3}})
sys.exit(0)
