import pathlib,json,hashlib,shutil,subprocess,os
h=pathlib.Path.home(); r=h/'omg-update-06117'; w=h/'.cache/agent-tmp/omg-update-06117'; pristine=w/'pristine'; candidate=w/'candidate'; snap=h/'.local/lib/omg-private/releases/06117-1021-20260923'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None
assert sha(w/'release.tar.gz')=='89b4ef87e3edeb49afa2f5382aa71217ffdc92d7380923efe1451311f1854be0'
assert not candidate.exists() and not snap.exists()
shutil.copytree(pristine,candidate,symlinks=True)
paths=subprocess.check_output(['git','-C',str(r),'diff','v0.6.117','--name-only'],text=True).splitlines()
for rel in paths:
 if not rel.startswith(('src/','web/src/','packages/','test/')):raise Exception('unexpected source path '+rel)
 target=candidate/rel; target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(r/rel,target)
for rel in ['packages/protocol/dist','packages/client/dist']:
 shutil.rmtree(candidate/rel,ignore_errors=True);shutil.copytree(r/rel,candidate/rel)
# Keep every old hashed asset for already-open clients. Same names must be identical.
for p in (h/'omg/web/dist/assets').rglob('*'):
 if not p.is_file():continue
 dest=candidate/'web/dist/assets'/p.relative_to(h/'omg/web/dist/assets')
 if dest.exists():assert sha(p)==sha(dest),str(dest)
 else:dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,dest)
for p in (r/'web/dist').rglob('*'):
 if not p.is_file():continue
 rel=p.relative_to(r);dest=candidate/rel
 if 'assets' in rel.parts and dest.exists():assert sha(p)==sha(dest),str(rel)
 dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,dest)
files={}
review=set(paths)
for d in ['web/dist','packages/protocol/dist','packages/client/dist']:
 review.update(str(p.relative_to(candidate)) for p in (candidate/d).rglob('*') if p.is_file())
snap.mkdir(parents=True)
for rel in sorted(review):
 p=candidate/rel; old=sha(pristine/rel);new=sha(p)
 if old==new:continue
 assert new is not None
 dest=snap/'files'/rel;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,dest)
 files[rel]={'upstream':old,'custom':new}
(snap/'manifest.json').write_text(json.dumps({'version':'0.6.117','files':files},indent=2)+'\n')
shutil.copy2(h/'.local/lib/omg-private/current/preserve.py',snap/'preserve.py')
subprocess.run(['python3',str(snap/'preserve.py'),str(candidate)],check=True)
print('STAGED_REVIEWED_RELEASE',len(files),'paths',len(paths),'source deltas')
