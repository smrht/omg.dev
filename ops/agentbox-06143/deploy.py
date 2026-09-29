"""Pinned, reviewed Agentbox migration. Invoked only by omg-safe-update."""
import pathlib,json,hashlib,subprocess,os,sys,shutil,sqlite3,urllib.request
h=pathlib.Path.home();w=h/'.cache/agent-tmp/omg-update-06143';live=h/'omg';private=h/'.local/lib/omg-private';new=private/'releases/06143-agentbox-20260929';backups=h/'.local/state/omg-update-backups/update-06143';old=private/'releases/06138-threads-grouplabel-20260928'
codex=h/'.local/lib/codex-0159/node_modules/.bin/codex'
dropin=h/'.config/systemd/user/omg.service.d/90-codex-06143.conf'
codex_config=f'[Service]\nEnvironment=LFG_CODEX_PATH={codex}\n'
def run(*args):subprocess.run(list(map(str,args)),check=True)
def point(target):
 p=private/'current.next-06143';p.symlink_to(target);p.replace(private/'current')
def failed():
 result=[]
 for prefix in [['systemctl','--user'],['systemctl']]:
  text=subprocess.check_output(prefix+['--failed','--no-legend','--plain'],text=True)
  result.extend(line.split()[0] for line in text.splitlines() if '.service' in line or '.mount' in line)
 return sorted(result)
def hashfile(p):
 d=hashlib.sha256()
 with p.open('rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''):d.update(b)
 return d.hexdigest()
mode=sys.argv[1]
if mode=='preflight':
 assert (private/'current').resolve()==old,'private layer changed during preparation'
 assert not dropin.exists() or dropin.read_text()==codex_config,'unreviewed Codex service override'
 assert subprocess.check_output([str(codex),'--version'],text=True).strip()=='codex-cli 0.159.0'
 run('python3',new/'preserve.py',w/'candidate')
 run('python3',w/'state.py','check')
 (w/'failed-before.json').write_text(json.dumps(failed()))
 print('PINNED_06143_READY')
elif mode=='restart':
 version=json.loads((live/'package.json').read_text())['version']
 assert version in ['0.6.138','0.6.143']
 target=new if version=='0.6.143' else old
 run('python3',target/'preserve.py',live)
 if version=='0.6.143':
  assert dropin.read_text()==codex_config,'Codex override missing'
 elif dropin.exists():
  assert dropin.read_text()==codex_config,'refusing to remove another service override'
  dropin.unlink()
 point(target)
 run('systemctl','--user','daemon-reload')
 run('systemctl','--user','restart','omg.service')
elif mode=='health':
 with urllib.request.urlopen('http://127.0.0.1:8766/api/install?ready=1',timeout=15) as response: identity=json.load(response)
 if not identity.get('version'):
  with urllib.request.urlopen('http://127.0.0.1:8766/api/bootstrap',timeout=20) as response: identity['version']=json.load(response)['version']
 assert identity.get('bootId') and identity['version']==json.loads((live/'package.json').read_text())['version'],'running version differs from installed version'
 print('RUNNING_VERSION',identity['version'])
 run('python3',w/'state.py','check')
 previous=json.loads((w/'failed-before.json').read_text());current=failed()
 assert set(current)<=set(previous),'new failed units: '+str(set(current)-set(previous))
 p=subprocess.run([str(h/'bin/omg-pilot-check')],text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
 (w/'pilot-current.log').write_text(p.stdout)
 faults=[l for l in p.stdout.splitlines() if l.startswith('FAIL:') and not l.startswith('FAIL: failed units aanwezig')]
 assert not faults,'; '.join(faults)
 assert 'PASS: chat-roster overlay actief' in p.stdout
 print('HEALTH_OK; existing failed units unchanged:',len(current))
elif mode=='activate':
 assert os.environ.get('OMG_SAFE_UPDATE')=='1','use the safe-update wrapper'
 assert (private/'current').resolve()==old,'private layer changed during preparation'
 run('python3',old/'preserve.py',live)
 run('python3',new/'preserve.py',w/'candidate')
 # Verify the wrapper-created backup BEFORE touching runtime files.
 backup=max(backups.glob('*/manifest.json'),key=lambda p:p.stat().st_mtime).parent
 m=json.loads((backup/'manifest.json').read_text());assert m['result']=='snapshot-created'
 assert hashfile(backup/m['releaseArchive'])==m['releaseSha256']
 count=0
 for rec in m['data']:
  p=backup/'data'/rec['path'];assert hashfile(p)==rec['sha256']
  with p.open('rb') as f:sql=f.read(16)==b'SQLite format 3\0'
  if sql:
   with sqlite3.connect('file:'+str(p)+'?mode=ro',uri=True) as db:assert db.execute('pragma quick_check').fetchall()==[('ok',)],p.name
   count+=1
 for rec in m['config']:assert hashfile(backup/rec['backup'])==rec['sha256']
 print('VERIFIED_BACKUP',backup,'databases',count,flush=True)
 # A fresh baseline narrows the preservation comparison to the actual cutover.
 run('python3',w/'state.py','capture')
 (backup/'private-before.txt').write_text(str(old)+'\n')
 (backup/'safety-before.txt').write_text(str((h/'.local/lib/agentbox-isolation/current').resolve())+'\n')
 shutil.copy2(w/'before-state.json',backup/'setup-before.json')
 # Only the restarted server selects the versioned CLI. Existing agent
 # processes and the global binary/config/auth remain untouched.
 assert not dropin.exists(),'new Codex drop-in appeared during preparation'
 dropin.parent.mkdir(parents=True,exist_ok=True)
 dropin.write_text(codex_config);dropin.chmod(0o600)
 (backup/'codex-override.txt').write_text(str(dropin)+'\n')
 archive=w/'old-runtime';archive.mkdir()
 for item in sorted((w/'candidate').iterdir()):
  if item.name in ['agents','data'] or item.name.startswith('.env'):continue
  target=live/item.name
  if target.exists() or target.is_symlink():target.rename(archive/item.name)
  item.rename(target)
 point(new)
 # Keep the reviewed health gate and safety wrapper persistent.
 for name in ['omg-safe-update','omg-pilot-check']:
  shutil.copy2(h/'bin'/name,backup/(name+'.before'))
  shutil.copy2(w/name,h/'bin'/name);(h/'bin'/name).chmod(0o755)
 run('python3',new/'preserve.py',live)
 print('Updated.',flush=True)
else:raise SystemExit('Unknown mode')
