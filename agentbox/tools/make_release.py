#!/usr/bin/env python3
"""Maak een private release van agentbox/main voor de live omg-boom (07-11-2026).

Stappen (niets live):
  1. kandidaat = kopie van live boom (zonder data/node_modules) + repo-bestanden
     die sinds BASE wijzigden (src, web/src, web/public) + web/dist samengevoegd
     (oude assets blijven voor open tabbladen).
  2. nieuwe release in ~/.local/lib/omg-private/releases/<naam> met manifest
     (oude custom-hash wordt 'previous'), plus rollback-release van de huidige.
  3. preflight: verse kopie van live, nieuwe release --apply, alle ExecStartPre-
     checks, terug naar rollback, weer heen; idempotent.

Gebruik: make_release.py <naam>   (web/dist moet al gebouwd zijn in de repo)
Daarna: cutover.sh <naam> (zie dossier).
"""
import hashlib, json, shutil, subprocess, sys
from pathlib import Path

HOME = Path.home()
REPO = HOME / "omg-agentbox"
LIVE = HOME / "omg"
BASE = "ab61609a"
RELEASES = HOME / ".local/lib/omg-private/releases"
CURRENT = HOME / ".local/lib/omg-private/current"
TMP = HOME / ".cache/agent-tmp"
ISO = HOME / ".local/lib/agentbox-isolation/current"
NO_THREADS = HOME / ".local/lib/omg-no-threads/check.py"
EXCL = ["--exclude=node_modules", "--exclude=/data", "--exclude=/.cache", "--exclude=/.git", "--exclude=/.perf"]


def sha(p: Path):
    return hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None


def run(*a, **k):
    return subprocess.run([str(x) for x in a], check=True, **k)


def chain(release: Path, root: Path):
    run("python3", release / "preserve.py", root, "--apply")
    for args in (
        [ISO / "sqlite_resilience_apply.py", root / "src"],
        [ISO / "ship_shared_apply.py", root / "src"],
        [ISO / "omg_isolation_source.py", root / "src"],
        [ISO / "omg_isolation_source.py", root / "src", "--check"],
        [ISO / "resume_opencode_model_apply.py", "--src-root", root],
        [ISO / "resume_lineage_apply.py", root / "src"],
        [NO_THREADS, root],
    ):
        run("python3", *args, stdout=subprocess.DEVNULL)
    out = subprocess.run(["python3", release / "preserve.py", root], capture_output=True, text=True)
    if out.returncode != 0:
        raise SystemExit(f"niet idempotent: {out.stdout}{out.stderr}")


def main():
    name = sys.argv[1]
    cur = CURRENT.resolve()
    new = RELEASES / name
    rb = RELEASES / f"rollback-{cur.name}-voor-{name}"
    if new.exists() or rb.exists():
        raise SystemExit(f"bestaat al: {new} of {rb}")
    if not (REPO / "web/dist/index.html").is_file():
        raise SystemExit("eerst bouwen: cd ~/omg-agentbox/web && bun --bun vite build")

    cand = TMP / f"omg-candidate-{name}"
    shutil.rmtree(cand, ignore_errors=True)
    cand.mkdir(parents=True)
    run("rsync", "-a", *EXCL, f"{LIVE}/", f"{cand}/")
    changed = subprocess.check_output(
        ["git", "-C", REPO, "diff", "--name-only", f"{BASE}..HEAD", "--", "src", "web/src", "web/public"], text=True
    ).split()
    for rel in changed:
        src = REPO / rel
        dst = cand / rel
        if src.is_file():
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
    run("cp", "-a", f"{REPO}/web/dist/.", f"{cand}/web/dist/")

    m = json.loads((cur / "manifest.json").read_text())
    files = m["files"]
    names = set(files)
    extra = changed + [str(p.relative_to(cand)) for p in (cand / "web/dist").rglob("*") if p.is_file()]
    for rel in extra:
        if rel not in names:
            files[rel] = {"upstream": sha(LIVE / rel), "custom": None}
            names.add(rel)
    nchanged = 0
    for rel, e in files.items():
        s = sha(cand / rel)
        if s != e["custom"]:
            if e["custom"] is not None and (LIVE / rel).is_file():
                prev = list(e.get("previous", []))
                if e["custom"] not in prev:
                    prev.append(e["custom"])
                e["previous"] = prev
            e["custom"] = s
            nchanged += 1
    (new / "files").mkdir(parents=True)
    for rel in files:
        src = cand / rel
        if src.is_file():
            d = new / "files" / rel
            d.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, d)
    shutil.copy2(cur / "preserve.py", new / "preserve.py")
    (new / "manifest.json").write_text(json.dumps(m, indent=1))

    # rollback: huidige release die de nieuwe bytes als 'previous' accepteert
    shutil.copytree(cur, rb, symlinks=True)
    o = json.loads((cur / "manifest.json").read_text())
    for rel, e in o["files"].items():
        nc = files.get(rel, {}).get("custom")
        if nc and nc != e["custom"]:
            prev = list(e.get("previous", []))
            if nc not in prev:
                prev.append(nc)
            e["previous"] = prev
    (rb / "manifest.json").write_text(json.dumps(o, indent=1))

    pre = TMP / f"omg-preflight-{name}"
    shutil.rmtree(pre, ignore_errors=True)
    pre.mkdir(parents=True)
    run("rsync", "-a", *EXCL, f"{LIVE}/", f"{pre}/")
    chain(new, pre)
    chain(rb, pre)
    chain(new, pre)
    diff = subprocess.run(["diff", "-rq", pre / "src", cand / "src"], capture_output=True, text=True).stdout
    if diff.strip():
        raise SystemExit("preflight wijkt af van kandidaat:\n" + diff[:2000])
    print(f"RELEASE_OK {new.name} entries={len(files)} changed={nchanged} rollback={rb.name}")


if __name__ == "__main__":
    main()
