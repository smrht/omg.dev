#!/usr/bin/env python3
"""Atomically publish a reviewed web-only layer; rollback never touches data."""
import argparse,pathlib,json,hashlib,shutil,subprocess,fcntl,os
h=pathlib.Path.home();base=h/'.local/lib/omg-private';live=h/'omg'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None
p=argparse.ArgumentParser();p.add_argument('target',type=pathlib.Path);p.add_argument('--expected',required=True);a=p.parse_args()
new=a.target.resolve();old=(base/'current').resolve()
assert new.parent==base/'releases' and old.name==a.expected
with (h/'.local/state/omg-update-backups/.update.lock').open('a') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 assert (base/'current').resolve()==old
 subprocess.run(['python3',str(old/'preserve.py'),str(live)],check=True)
 before=json.loads((old/'manifest.json').read_text())['files'];after=json.loads((new/'manifest.json').read_text())['files'];plan=[]
 for rel,e in after.items():
  assert rel.startswith('web/') or before.get(rel)==e, 'Frontend-only scope'
  assert sha(new/'files'/rel)==e['custom']
  if sha(live/rel)==e['custom']:continue
  assert sha(live/rel)==(before[rel]['custom'] if rel in before else e['upstream']),rel
  plan.append(rel)
 # Assets and sources before HTML and service worker; keep old assets for open tabs.
 plan.sort(key=lambda r:(r in ['web/dist/index.html','web/dist/sw.js'],r))
 changed=[];pointer=base/'current.next-picker'
 try:
  for rel in plan:
   target=live/rel;target.parent.mkdir(parents=True,exist_ok=True);tmp=target.with_name(target.name+'.picker-tmp');shutil.copy2(new/'files'/rel,tmp);tmp.replace(target);changed.append(rel)
  subprocess.run(['python3',str(new/'preserve.py'),str(live)],check=True)
  pointer.symlink_to(new);pointer.replace(base/'current')
 except BaseException:
  for rel in reversed(changed):
   target=live/rel
   if rel in before:shutil.copy2(old/'files'/rel,target)
   else:target.unlink(missing_ok=True)
  pointer.unlink(missing_ok=True)
  raise
 print('PICKER_LAYER_ACTIVATED',len(changed),'files; service unchanged; previous',old)
