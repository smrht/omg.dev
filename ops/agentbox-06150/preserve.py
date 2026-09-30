#!/usr/bin/env python3
"""Verify/apply a reviewed, version-pinned private layer without clobbering drift."""
import argparse, hashlib, json, os
from pathlib import Path

def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None

def main():
    a=argparse.ArgumentParser();a.add_argument('root',type=Path);a.add_argument('--apply',action='store_true');args=a.parse_args()
    bundle=Path(__file__).resolve().parent
    manifest=json.loads((bundle/'manifest.json').read_text())
    version=json.loads((args.root/'package.json').read_text())['version']
    if version!=manifest['version']:raise SystemExit(f'Private features are not verified for {version}; keep the current installation and port first.')
    plan=[]
    for name,entry in manifest['files'].items():
        rel=Path(name)
        if rel.is_absolute() or '..' in rel.parts:raise SystemExit('Unsafe manifest path')
        target=args.root/rel;source=bundle/'files'/rel
        if sha(source)!=entry['custom']:raise SystemExit(f'Private snapshot checksum mismatch: {name}')
        actual=sha(target)
        if actual==entry['custom']:continue
        if not args.apply:raise SystemExit(f'Private feature missing or changed: {name}')
        if actual!=entry['upstream']:raise SystemExit(f'Unreviewed local change: {name}; refusing to overwrite')
        plan.append((target,source))
    # Validate every path first. Never leave a half-applied layer after drift detection.
    for target,source in plan:
        target.parent.mkdir(parents=True,exist_ok=True)
        temp=target.with_name(target.name+f'.private-{os.getpid()}')
        temp.write_bytes(source.read_bytes());temp.chmod(source.stat().st_mode & 0o777);temp.replace(target)
    for name,entry in manifest['files'].items():
        if sha(args.root/name)!=entry['custom']:raise SystemExit('Readback mismatch: '+name)
    print(f'PRIVATE_PRESERVATION_OK version={version} files={len(manifest["files"])} applied={len(plan)}')

if __name__=='__main__':main()
