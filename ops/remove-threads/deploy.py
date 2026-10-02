"""Pinned removal of Threads; activation only through omg-safe-update."""
import hashlib,json,os,shutil,sqlite3,subprocess,sys,urllib.request,urllib.error
from pathlib import Path
h=Path.home();w=Path(__file__).resolve().parent;live=h/'omg';p=json.loads((w/'plan.json').read_text());files=p['files'];backups=h/'.local/state/omg-update-backups/remove-threads-20261002'
def sha(f):return hashlib.sha256(f.read_bytes()).hexdigest() if f.is_file() else None
def run(*a,env=None):subprocess.run(list(map(str,a)),check=True,env=env)
def point(base,target):
 q=base/'current.next-remove-threads';q.unlink(missing_ok=True);q.symlink_to(target);q.replace(base/'current')
def deployed():return sha(live/'src/commands/serve.ts')==files['src/commands/serve.ts']['after']
def state(mode,backup=None):
 e=dict(os.environ,OMG_UPDATE_BASELINE_DIR=str(w),OMG_EXPECTED_PRIVATE=p['newPrivate'] if deployed() else p['oldPrivate'])
 run('python3',w/'state.py',mode,*([backup] if backup else []),env=e)
def failures():
 return sorted(set(line.split()[0] for prefix in [('systemctl','--user'),('systemctl',)] for line in subprocess.check_output([*prefix,'--failed','--no-legend','--plain'],text=True).splitlines() if line.strip()))
def check_before():
 assert str((h/'.local/lib/omg-private/current').resolve())==p['oldPrivate'],'private changed'
 assert str((h/'.local/lib/agentbox-isolation/current').resolve())==p['oldIsolation'],'isolation changed'
 for rel,v in files.items():assert sha(live/rel)==v['before'],'live drift: '+rel
 run('python3',Path(p['oldPrivate'])/'preserve.py',live)
 for rel,v in files.items():assert sha(w/'candidate'/rel)==v['after'],'candidate changed: '+rel
mode=sys.argv[1]
if mode=='preflight':
 check_before();state('capture');(w/'failures-before.json').write_text(json.dumps(failures()));print('THREAD_REMOVAL_PREFLIGHT_OK')
elif mode=='activate':
 assert os.environ.get('OMG_SAFE_UPDATE')=='1';check_before()
 backup=max(backups.glob('*/manifest.json'),key=lambda f:f.stat().st_mtime).parent
 m=json.loads((backup/'manifest.json').read_text());assert m['result']=='snapshot-created'
 assert sha(backup/m['releaseArchive'])==m['releaseSha256']
 dbs=0
 for rec in m['data']:
  f=backup/'data'/rec['path'];assert sha(f)==rec['sha256']
  with f.open('rb') as stream:head=stream.read(16)
  if head==b'SQLite format 3\0':
   with sqlite3.connect('file:'+str(f)+'?mode=ro',uri=True) as db:assert db.execute('pragma quick_check').fetchall()==[('ok',)]
   dbs+=1
 for rec in m['config']:assert sha(backup/rec['backup'])==rec['sha256']
 state('capture');shutil.copy2(w/'before-state.json',backup/'setup-before.json');shutil.copy2(w/'plan.json',backup/'removal-plan.json')
 (w/'active-backup.txt').write_text(str(backup))
 print('VERIFIED_BACKUP',backup,'databases',dbs,flush=True)
 # All preconditions are checked before any runtime file changes. Data is outside this plan.
 for rel,v in files.items():
  target=live/rel
  if v['after'] is None:target.unlink(missing_ok=True)
  else:
   target.parent.mkdir(parents=True,exist_ok=True);tmp=target.with_name(target.name+'.threads-removal');shutil.copy2(w/'candidate'/rel,tmp);tmp.replace(target)
 for rel,v in files.items():assert sha(live/rel)==v['after'],'readback mismatch: '+rel
 point(h/'.local/lib/omg-private',p['newPrivate']);point(h/'.local/lib/agentbox-isolation',p['newIsolation'])
 run('python3',Path(p['newPrivate'])/'preserve.py',live)
 print('Updated.',flush=True)
elif mode=='restart':
 new=deployed();private=p['newPrivate'] if new else p['oldPrivate'];isolation=p['newIsolation'] if new else p['oldIsolation']
 point(h/'.local/lib/omg-private',private);point(h/'.local/lib/agentbox-isolation',isolation)
 run('python3',Path(private)/'preserve.py',live);run('systemctl','--user','restart','omg.service')
elif mode=='health':
 with urllib.request.urlopen('http://127.0.0.1:8766/api/install?ready=1',timeout=20) as r:identity=json.load(r)
 assert identity['version']=='0.6.150' and identity.get('bootId')
 if (w/'active-backup.txt').exists():state('check-live',(w/'active-backup.txt').read_text().strip())
 else:state('check')
 assert set(failures())<=set(json.loads((w/'failures-before.json').read_text())),'new failed service'
 if deployed():
  for path in ['/api/threads','/api/threads/new']:
   try:urllib.request.urlopen('http://127.0.0.1:8766'+path,timeout=10);raise Exception('thread route remains')
   except urllib.error.HTTPError as e:assert e.code==404
  run('python3',Path(p['newIsolation'])/'omg_isolation_source.py',live/'src','--check')
 print('THREAD_REMOVAL_HEALTH_OK' if deployed() else 'BASELINE_HEALTH_OK')
else:raise SystemExit('unknown mode')
