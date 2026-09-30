"""Pinned 0.6.150 cutover; invoke only through the existing safe updater."""
import hashlib,json,os,pathlib,sqlite3,subprocess,sys,urllib.request,shutil
h=pathlib.Path.home();w=h/'.cache/agent-tmp/omg-update-06150';private=h/'.local/lib/omg-private';live=h/'omg'
old=private/'releases/06143-daybreak-sessions-20260929';new=private/'releases/06150-agentbox-20260930'
backups=h/'.local/state/omg-update-backups/update-06150'
def run(*args):subprocess.run(list(map(str,args)),check=True)
def point(target):
 p=private/'current.next-06150';p.symlink_to(target);p.replace(private/'current')
def sha(p):
 with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def api(path):
 with urllib.request.urlopen('http://127.0.0.1:8766'+path,timeout=20) as r:return json.load(r)
def failures():
 rows=[]
 for prefix in [('systemctl','--user'),('systemctl',)]:
  out=subprocess.check_output([*prefix,'--failed','--no-legend','--plain'],text=True)
  rows.extend(line.split()[0] for line in out.splitlines() if '.service' in line or '.mount' in line)
 return sorted(rows)
def version():return json.loads((live/'package.json').read_text())['version']
mode=sys.argv[1]
if mode=='preflight':
 assert (private/'current').resolve()==old,'private changes appeared'
 run('python3',old/'preserve.py',live);run('python3',new/'preserve.py',w/'candidate')
 run('python3',h/'.local/lib/agentbox-isolation/current/omg_isolation_source.py',w/'candidate/src','--check')
 run('python3',w/'agents.py','check')
 run('python3',w/'state.py','capture')
 (w/'failed-before.json').write_text(json.dumps(failures()))
 print('PINNED_06150_READY')
elif mode=='activate':
 assert os.environ.get('OMG_SAFE_UPDATE')=='1'
 assert (private/'current').resolve()==old
 run('python3',old/'preserve.py',live);run('python3',new/'preserve.py',w/'candidate')
 backup=max(backups.glob('*/manifest.json'),key=lambda p:p.stat().st_mtime).parent
 m=json.loads((backup/'manifest.json').read_text());assert m['result']=='snapshot-created'
 assert sha(backup/m['releaseArchive'])==m['releaseSha256']
 dbs=0
 for rec in m['data']:
  p=backup/'data'/rec['path'];assert sha(p)==rec['sha256']
  with p.open('rb') as f:sqlite=f.read(16)==b'SQLite format 3\0'
  if sqlite:
   with sqlite3.connect('file:'+str(p)+'?mode=ro',uri=True) as db:assert db.execute('pragma quick_check').fetchall()==[('ok',)]
   dbs+=1
 for rec in m['config']:assert sha(backup/rec['backup'])==rec['sha256']
 run('python3',w/'state.py','capture');shutil.copy2(w/'before-state.json',backup/'setup-before.json')
 (backup/'private-before.txt').write_text(str(old)+'\n')
 for name in ['omg-safe-update','omg-pilot-check']:shutil.copy2(h/'bin'/name,backup/(name+'.before'))
 shutil.copy2(w/'rollback-runtime.py',backup/'rollback-runtime.py')
 print('VERIFIED_BACKUP',str(backup),'databases',dbs,flush=True)
 run('python3',w/'agents.py','apply',backup)
 # Change only replaceable runtime trees; retain data/, agents/ and env files.
 archive=w/'old-runtime';assert not archive.exists();archive.mkdir()
 for item in sorted((w/'candidate').iterdir()):
  if item.name in ['agents','data'] or item.name.startswith('.env'):continue
  target=live/item.name
  if target.exists() or target.is_symlink():target.rename(archive/item.name)
  item.rename(target)
 point(new)
 shutil.copy2(w/'omg-pilot-check',h/'bin/omg-pilot-check');(h/'bin/omg-pilot-check').chmod(0o755)
 run('python3',new/'preserve.py',live)
 print('Updated.',flush=True)
elif mode=='restart':
 v=version();assert v in ['0.6.143','0.6.150']
 target=new if v=='0.6.150' else old
 if v=='0.6.143':
  backup=max(backups.glob('*/manifest.json'),key=lambda p:p.stat().st_mtime).parent
  run('python3',w/'agents.py','rollback',backup)
 point(target)
 if v=='0.6.143':
  backup=max(backups.glob('*/manifest.json'),key=lambda p:p.stat().st_mtime).parent
  shutil.copy2(backup/'omg-pilot-check.before',h/'bin/omg-pilot-check')
 run('python3',target/'preserve.py',live)
 run('systemctl','--user','restart','omg.service')
elif mode=='health':
 v=version();identity=api('/api/install?ready=1');assert identity['version']==v and identity.get('bootId')
 run('python3',w/'state.py','check');assert set(failures())<=set(json.loads((w/'failed-before.json').read_text()))
 p=subprocess.run([str(h/'bin/omg-pilot-check')],text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
 (w/'pilot-current.log').write_text(p.stdout)
 faults=[l for l in p.stdout.splitlines() if l.startswith('FAIL:') and not l.startswith('FAIL: failed units aanwezig')]
 assert not faults,'; '.join(faults)
 assert 'PASS: chat-roster overlay actief' in p.stdout
 print('RUNNING_VERSION',v,'HEALTH_OK')
else:raise SystemExit('unknown mode')
