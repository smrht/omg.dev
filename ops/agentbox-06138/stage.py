"""Stage the reviewed 0.6.138 candidate and its immutable private snapshot.

candidate = official 0.6.138 release + Agentbox source deltas + new build,
with every older hashed web asset kept for already-open tabs."""
import pathlib,json,hashlib,shutil,subprocess,gzip
try:
 import brotli
except ImportError:brotli=None
h=pathlib.Path.home(); r=h/'.cache/agent-tmp/omg-port-06138/tree'; w=h/'.cache/agent-tmp/omg-update-06138'; pristine=w/'pristine'; candidate=w/'candidate'
snap=h/'.local/lib/omg-private/releases/06138-agentbox-20260928'
RELEASE_SHA='0c3e542cfa34c56ee28bf4009da7bda0c1fa77ed797fb624e83bd10b1fffff41'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None
def raw(p):
 b=p.read_bytes()
 if p.suffix=='.gz':return gzip.decompress(b)
 if p.suffix=='.br':
  if brotli:return brotli.decompress(b)
  js="process.stdout.write(require('zlib').brotliDecompressSync(require('fs').readFileSync(0)))"
  return subprocess.run([str(h/'.bun/bin/bun'),'-e',js],input=b,capture_output=True,check=True).stdout
 return b
def place(src,dest,label):
 """Copy src to dest. An existing same-name asset must hold the same bytes;
 a compressed twin may differ only in its container, never in its content."""
 if dest.exists():
  if sha(src)==sha(dest):return
  if dest.suffix in('.gz','.br') and raw(src)==raw(dest):return  # keep the existing bytes
  raise SystemExit(f'{label}: same-name asset with other content: {dest}')
 dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(src,dest)
assert sha(w/'release.tar.gz')==RELEASE_SHA
assert json.loads((pristine/'package.json').read_text())['version']=='0.6.138'
assert json.loads((r/'package.json').read_text())['version']=='0.6.138'
assert not candidate.exists() and not snap.exists()
shutil.copytree(pristine,candidate,symlinks=True)
paths=(r/'delta-paths.txt').read_text().splitlines()
review=set()
for rel in paths:
 if rel.startswith('ops/') or rel=='design-qa.md':continue
 if not rel.startswith(('src/','web/src/','packages/','test/')):raise SystemExit('unexpected source path '+rel)
 if not (r/rel).exists():
  # Deleted in the fork. Only allowed when the release does not ship it.
  if (pristine/rel).exists():raise SystemExit('fork deletes a shipped file: '+rel)
  continue
 target=candidate/rel;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(r/rel,target);review.add(rel)
for rel in ['packages/protocol/dist','packages/client/dist']:
 shutil.rmtree(candidate/rel,ignore_errors=True);shutil.copytree(r/rel,candidate/rel)
# Every old hashed asset stays for already-open clients.
live_assets=h/'omg/web/dist/assets'
for p in live_assets.rglob('*'):
 if p.is_file():place(p,candidate/'web/dist/assets'/p.relative_to(live_assets),'live')
# The new build: hashed assets must agree with what is there; entrypoints replace.
for p in (r/'web/dist').rglob('*'):
 if not p.is_file() or p.suffix=='.map':continue
 rel=p.relative_to(r);dest=candidate/rel
 if 'assets' in rel.parts:place(p,dest,'build')
 else:dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,dest)
for d in ['web/dist','packages/protocol/dist','packages/client/dist']:
 review.update(str(p.relative_to(candidate)) for p in (candidate/d).rglob('*') if p.is_file())
files={}
snap.mkdir(parents=True)
for rel in sorted(review):
 p=candidate/rel;old=sha(pristine/rel);new=sha(p)
 if old==new:continue
 assert new is not None
 dest=snap/'files'/rel;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,dest)
 files[rel]={'upstream':old,'custom':new}
(snap/'manifest.json').write_text(json.dumps({'version':'0.6.138','files':files},indent=2)+'\n')
shutil.copy2(r/'ops/agentbox-06138/preserve.py',snap/'preserve.py')
subprocess.run(['python3',str(snap/'preserve.py'),str(candidate)],check=True)
entry=[l for l in (candidate/'web/dist/index.html').read_text().split('"') if l.startswith('/assets/index-') and l.endswith('.js')]
assert entry and (candidate/'web/dist'/entry[0].lstrip('/')).is_file(),entry
print('STAGED_REVIEWED_RELEASE',len(files),'manifest entries;',len(review),'reviewed;',sum(1 for p in paths if not p.startswith('ops/')),'source deltas; entry',entry[0])
