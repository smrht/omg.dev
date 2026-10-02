import json,hashlib,shutil,subprocess
from pathlib import Path
h=Path.home();w=Path(__file__).resolve().parent; live=h/'omg'; candidate=w/'candidate'
private=h/'.local/lib/omg-private';isolation=h/'.local/lib/agentbox-isolation'
oldp=(private/'current').resolve();oldi=(isolation/'current').resolve()
newp=private/'releases/06150-no-threads-20261002';newi=isolation/'releases/06150-no-threads-20261002'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None
def run(*a):subprocess.run(list(map(str,a)),check=True)
assert not newp.exists() and not newi.exists()
run('python3',oldp/'preserve.py',live)
paths=json.loads((w/'changed-paths.json').read_text())
paths += [str(p.relative_to(candidate)) for p in (candidate/'web/dist').rglob('*') if p.is_file() and p.suffix!='.map']
assert any(p=='web/dist/index.html' for p in paths)
shutil.copytree(oldp,newp);shutil.copytree(oldi,newi)
manifest=json.loads((newp/'manifest.json').read_text());plan={}
for rel in sorted(set(paths)):
 assert rel.startswith(('src/','web/','test/')) and '..' not in Path(rel).parts
 source=candidate/rel;target=live/rel;newhash=sha(source);oldhash=sha(target)
 if newhash==oldhash:continue
 if rel.startswith('web/dist/assets/') and oldhash is not None:raise Exception('hashed asset collision '+rel)
 plan[rel]={'before':oldhash,'after':newhash}
 upstream=manifest['files'].get(rel,{}).get('upstream',oldhash)
 manifest['files'][rel]={'upstream':upstream,'custom':newhash}
 dest=newp/'files'/rel
 if newhash is None:dest.unlink(missing_ok=True)
 else:dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,dest)
(newp/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
shutil.copy2(w/'preserve.py',newp/'preserve.py')
for name in ['omg-isolation-runtime.ts','omg-isolation-worker.ts']:
 shutil.copy2(candidate/'src'/name,newi/name)
# Check the exact reviewed candidate against every startup source transform.
for script in ['sqlite_resilience_apply.py','ship_shared_apply.py','omg_isolation_source.py']:
 before={str(p):sha(p) for p in (candidate/'src').rglob('*') if p.is_file()}
 run('python3',newi/script,candidate/'src')
 after={str(p):sha(p) for p in (candidate/'src').rglob('*') if p.is_file()}
 assert before==after,'startup transform would change candidate: '+script
run('python3',newi/'omg_isolation_source.py',candidate/'src','--check')
(w/'plan.json').write_text(json.dumps({'oldPrivate':str(oldp),'newPrivate':str(newp),'oldIsolation':str(oldi),'newIsolation':str(newi),'files':plan},indent=2))
print('REMOVAL_STAGED',len(plan),'paths',sum(x['after'] is None for x in plan.values()),'deletions')
