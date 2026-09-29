"""Extend an exact, still-current private layer with reviewed source/build files."""
import hashlib,json,pathlib,shutil,subprocess,sys,os,gzip
h=pathlib.Path.home();w=h/'.cache/agent-tmp/omg-daybreak-sessions';live=h/'omg';private=h/'.local/lib/omg-private';old=private/'releases/06143-agentbox-20260929';new=private/'releases/06143-daybreak-sessions-20260929';source=w/'tree';candidate=w/'candidate'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None
assert (private/'current').resolve()==old
subprocess.run(['python3',str(old/'preserve.py'),str(live)],check=True)
assert not new.exists() and not candidate.exists()
# Source checksums bind the local HEAD baseline to the exact live source.
changes=json.loads((source/'changes.json').read_text())
for name,row in changes.items():
 assert name.startswith(('src/','web/src/','packages/')) and '..' not in pathlib.Path(name).parts
 assert sha(live/name)==row['before'], 'new live source drift: '+name
 assert sha(source/name)==row['after'], 'uploaded source checksum mismatch: '+name
candidate.mkdir()
# Candidate has only runtime-owned trees; never copy credentials or userdata.
for name in ['src','web','packages','test']:
 if (live/name).is_dir():shutil.copytree(live/name,candidate/name,symlinks=True)
shutil.copy2(live/'package.json',candidate/'package.json')
# Reuse exact installed dependency bytes through hardlinks; no workspace
# node_modules symlink, and candidate workspace links resolve its own packages.
shutil.copytree(live/'node_modules',candidate/'node_modules',symlinks=True,copy_function=os.link)
for name in ['tsconfig.json','bunfig.toml']:
 if (live/name).is_file():shutil.copy2(live/name,candidate/name)
for name in changes:
 target=candidate/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source/name,target)
for name in ['web/dist','packages/protocol/dist','packages/client/dist']:
 for p in (source/name).rglob('*'):
  if not p.is_file() or p.suffix=='.map':continue
  target=candidate/p.relative_to(source);target.parent.mkdir(parents=True,exist_ok=True)
  if target.exists() and 'assets' in p.relative_to(source).parts:
   if sha(target)!=sha(p):
    # Compression implementations may differ; keep the existing compressed
    # asset only when its decoded bytes prove exactly the same hashed content.
    assert p.suffix=='.gz' and gzip.decompress(target.read_bytes())==gzip.decompress(p.read_bytes()),'same hashed asset name differs: '+p.name
  else:shutil.copy2(p,target)
# Independent startup overlays must be idempotent before the final snapshot.
safety=h/'.local/lib/agentbox-isolation/current'
for script in ['sqlite_resilience_apply.py','ship_shared_apply.py','omg_isolation_source.py']:
 subprocess.run(['python3',str(safety/script),str(candidate/'src')],check=True)
subprocess.run(['python3',str(safety/'omg_isolation_source.py'),str(candidate/'src'),'--check'],check=True)
new.mkdir();manifest=json.loads((old/'manifest.json').read_text());shutil.copytree(old/'files',new/'files')
review=set(changes)
for name in ['web/dist','packages/protocol/dist','packages/client/dist']:
 review.update(str(p.relative_to(candidate)) for p in (candidate/name).rglob('*') if p.is_file())
# Detect overlay edits outside the explicit source change set.
for p in (candidate/'src').rglob('*'):
 if p.is_file() and sha(p)!=sha(live/p.relative_to(candidate)):
  assert str(p.relative_to(candidate)) in changes,'unreviewed startup edit '+str(p)
for name in sorted(review):
 p=candidate/name;actual=sha(p);prior=sha(live/name)
 if actual==prior:continue
 row=manifest['files'].get(name,{'upstream':None});row['previous']=prior;row['custom']=actual;manifest['files'][name]=row
 dest=new/'files'/name;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,dest)
(new/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
text=(old/'preserve.py').read_text()
needle="if actual!=entry['upstream']:"
assert needle in text
text=text.replace(needle,"if actual not in (entry['upstream'], entry.get('previous', entry['upstream'])):")
(new/'preserve.py').write_text(text)
subprocess.run(['python3',str(new/'preserve.py'),str(candidate)],check=True)
print('DAYBREAK_STAGED',len(changes),'source paths',len(manifest['files']),'total preservation files')
