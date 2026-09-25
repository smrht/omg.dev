#!/usr/bin/env python3
"""Derive a new immutable private-layer snapshot from the current one.

The hash guard (`preserve.py`, run as ExecStartPre of omg.service) only accepts
bytes it has reviewed. A follow-up change to a reviewed file therefore needs a
new snapshot: same `upstream` hash (the pristine 0.6.98 bytes), new `custom`
hash, new bytes under `files/`. This script builds that snapshot from a build
tree without touching the live install or the live `current` pointer.

    make_snapshot.py --from ~/.local/lib/omg-private/current \
        --build ~/.cache/agent-tmp/omg-opus55-build --name 0698-opus55-20260922 \
        --changed src/agent-catalog.ts ... --dist-from web/dist

Rules:
- a changed file must already be in the manifest (its `upstream` hash is kept)
  or be pristine upstream on the live install (then live bytes = `upstream`);
- new build assets (`--dist-from`) get `upstream: null`, like the 0698 layer;
- non-hashed dist files (`index.html`, `sw.js`) are replaced with the new build;
- old dist assets stay in the manifest so open tabs keep loading.
"""
import argparse, hashlib, json, os, re, shutil, sys
from pathlib import Path


def sha(p: Path):
    return hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="src", type=Path, required=True, help="current snapshot dir")
    ap.add_argument("--build", type=Path, required=True, help="build tree with the new bytes")
    ap.add_argument("--live", type=Path, default=Path.home() / "omg", help="live install (for pristine hashes)")
    ap.add_argument("--name", required=True, help="new release name")
    ap.add_argument("--releases", type=Path, default=Path.home() / ".local/lib/omg-private/releases")
    ap.add_argument("--changed", nargs="*", default=[], help="repo-relative source files that changed")
    ap.add_argument("--new", nargs="*", default=[], help="repo-relative NEW source files (upstream: null)")
    ap.add_argument("--dist-from", default=None, help="repo-relative dist dir in the build tree (e.g. web/dist)")
    a = ap.parse_args()

    src = a.src.resolve()
    dest = a.releases / a.name
    if dest.exists():
        sys.exit(f"{dest} exists; pick another name")
    manifest = json.loads((src / "manifest.json").read_text())
    files = manifest["files"]

    plan = {}  # rel -> (source path in build tree, upstream hash)
    for rel in a.changed:
        b = a.build / rel
        if not b.is_file():
            sys.exit(f"missing in build tree: {rel}")
        if rel in files:
            upstream = files[rel]["upstream"]
            live_hash = sha(a.live / rel)
            if live_hash != files[rel]["custom"]:
                sys.exit(f"live {rel} does not match the current snapshot; refusing")
        else:
            upstream = sha(a.live / rel)  # unlisted file = pristine upstream bytes on the live install
            if upstream is None:
                sys.exit(f"{rel} is neither in the manifest nor on the live install")
        plan[rel] = (b, upstream)

    for rel in a.new:
        b = a.build / rel
        if not b.is_file():
            sys.exit(f"missing in build tree: {rel}")
        if rel in files or (a.live / rel).exists():
            sys.exit(f"{rel} is not new (in manifest or on the live install); use --changed")
        plan[rel] = (b, None)

    if a.dist_from:
        droot = a.build / a.dist_from
        if not droot.is_dir():
            sys.exit(f"missing dist dir {droot}")
        for p in droot.rglob("*"):
            if not p.is_file() or p.suffix == ".map":
                continue
            rel = os.path.relpath(p, a.build)
            if rel in files:
                if sha(p) == files[rel]["custom"]:
                    continue  # unchanged shared chunk
                if re.search(r"-[A-Za-z0-9_-]{8}\.", p.name):
                    # a hashed asset with the same name but other bytes would be a build bug
                    sys.exit(f"dist file {rel} exists in manifest with other bytes; refusing")
                # index.html, sw.js: non-hashed files that legitimately change per build
                plan[rel] = (p, files[rel]["upstream"])
            else:
                plan[rel] = (p, None)

    shutil.copytree(src, dest, symlinks=False)
    for rel, (b, upstream) in plan.items():
        target = dest / "files" / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(b, target)
        files[rel] = {"upstream": upstream, "custom": sha(target)}
    manifest["files"] = dict(sorted(files.items()))
    (dest / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    # every manifest entry must have its bytes in files/
    for rel, entry in manifest["files"].items():
        if sha(dest / "files" / rel) != entry["custom"]:
            sys.exit(f"snapshot incomplete: {rel}")
    print(f"snapshot {dest}: {len(plan)} updated/new entries, {len(manifest['files'])} total")
    for rel in sorted(plan):
        print("  ", rel)


if __name__ == "__main__":
    main()
