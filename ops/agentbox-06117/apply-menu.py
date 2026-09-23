import pathlib,json,hashlib,shutil,os,subprocess,fcntl
h=pathlib.Path.home();base=h/'.local/lib/omg-private';old=base/'releases/06117-1021-20260923';new=base/'releases/06117-1021-menu-20260923';live=h/'omg'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None
with (h/'.local/state/omg-update-backups/.update.lock').open('a') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 assert (base/'current').resolve()==old
 subprocess.run(['python3',str(old/'preserve.py'),str(live)],check=True)
 before=json.loads((old/'manifest.json').read_text())['files'];after=json.loads((new/'manifest.json').read_text())['files'];plan=[]
 for rel,e in after.items():
  p=live/rel
  assert sha(new/'files'/rel)==e['custom']
  if sha(p)==e['custom']:continue
  assert sha(p)==(before[rel]['custom'] if rel in before else e['upstream']),rel
  plan.append(rel)
 # Publish entrypoints after all content-addressed chunks exist.
 plan.sort(key=lambda p:(p in ['web/dist/index.html','web/dist/sw.js'],p))
 done=[]
 try:
  for rel in plan:
   p=live/rel;p.parent.mkdir(parents=True,exist_ok=True);temp=p.with_name(p.name+'.update1021');shutil.copy2(new/'files'/rel,temp);temp.replace(p);done.append(rel)
  subprocess.run(['python3',str(new/'preserve.py'),str(live)],check=True)
  temp=base/'current.next-1021';temp.symlink_to(new);temp.replace(base/'current')
 except:
  for rel in reversed(done):
   p=live/rel
   if rel in before:shutil.copy2(old/'files'/rel,p)
   else:p.unlink()
  raise
 print('QUICK_MENU_LAYER_ACTIVATED',len(plan),'files; no service restart')
