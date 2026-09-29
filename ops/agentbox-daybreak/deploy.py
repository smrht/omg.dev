"""One-time guarded Daybreak extension for the already installed 0.6.143."""
import hashlib,json,os,pathlib,sqlite3,subprocess,sys,urllib.request,shutil
h=pathlib.Path.home();w=h/'.cache/agent-tmp/omg-daybreak-sessions';private=h/'.local/lib/omg-private';old=private/'releases/06143-agentbox-20260929';new=private/'releases/06143-daybreak-sessions-20260929';live=h/'omg'
backups=h/'.local/state/omg-update-backups/daybreak-sessions'
def run(*args):subprocess.run([str(x) for x in args],check=True)
def point(target):
 p=private/'current.next-daybreak';p.symlink_to(target);p.replace(private/'current')
def sha(p):
 digest=hashlib.sha256()
 with p.open('rb') as f:
  for block in iter(lambda:f.read(1024*1024),b''):digest.update(block)
 return digest.hexdigest()
def api(path):
 with urllib.request.urlopen('http://127.0.0.1:8766'+path,timeout=20) as response:return json.load(response)
def failures():
 rows=[]
 for prefix in [('systemctl','--user'),('systemctl',)]:
  out=subprocess.check_output([*prefix,'--failed','--no-legend','--plain'],text=True)
  rows.extend(line.split()[0] for line in out.splitlines() if '.service' in line or '.mount' in line)
 return sorted(rows)
mode=sys.argv[1]
if mode=='preflight':
 assert (private/'current').resolve()==old,'new private changes appeared'
 run('python3',old/'preserve.py',live)
 run('python3',new/'preserve.py',w/'candidate')
 run('python3',w/'state.py','capture')
 (w/'failed-before.json').write_text(json.dumps(failures()))
 print('DAYBREAK_PREFLIGHT_OK')
elif mode=='activate':
 assert os.environ.get('OMG_SAFE_UPDATE')=='1'
 assert (private/'current').resolve()==old
 run('python3',old/'preserve.py',live)
 run('python3',new/'preserve.py',w/'candidate')
 backup=max(backups.glob('*/manifest.json'),key=lambda p:p.stat().st_mtime).parent
 manifest=json.loads((backup/'manifest.json').read_text());assert manifest['result']=='snapshot-created'
 assert sha(backup/manifest['releaseArchive'])==manifest['releaseSha256']
 for row in manifest['data']:
  p=backup/'data'/row['path'];assert sha(p)==row['sha256']
  with p.open('rb') as f: header=f.read(16)
  if header==b'SQLite format 3\0':
   with sqlite3.connect('file:'+str(p)+'?mode=ro',uri=True) as db:assert db.execute('pragma quick_check').fetchall()==[('ok',)]
 for row in manifest['config']:assert sha(backup/row['backup'])==row['sha256']
 run('python3',w/'state.py','capture');shutil.copy2(w/'before-state.json',backup/'setup-before.json')
 (backup/'private-before.txt').write_text(str(old)+'\n')
 # Manifest permits only exact prior hashes for the reviewed upgrade. Guards
 # remain active; changing the pointer first makes both writers apply identical
 # verified content. Persistent data and every existing hashed asset remain.
 point(new)
 run('python3',new/'preserve.py',live,'--apply')
 print('Updated.',flush=True)
elif mode=='restart':
 # Safe-update restores software before invoking restart on failure. Presence
 # of this new owned module determines the matching preservation pointer.
 target=new if (live/'src/session-cyber-access.ts').is_file() else old
 point(target);run('python3',target/'preserve.py',live)
 run('systemctl','--user','restart','omg.service')
elif mode=='health':
 identity=api('/api/install?ready=1');assert identity['version']=='0.6.143' and identity.get('bootId')
 run('python3',w/'state.py','check')
 assert set(failures())<=set(json.loads((w/'failed-before.json').read_text()))
 run('python3',private/'current/preserve.py',live)
 print('DAYBREAK_HEALTH_OK')
else:raise SystemExit('unknown mode')
