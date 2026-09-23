#!/usr/bin/env python3
"""Restore previous web layer without removing assets used by open tabs or data."""
import pathlib,json,subprocess,hashlib,shutil,fcntl
h=pathlib.Path.home();base=h/'.local/lib/omg-private';live=h/'omg';old=base/'releases/06117-1022-overview-20260923'
with (h/'.local/state/omg-update-backups/.update.lock').open('a') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 current=(base/'current').resolve();assert current.name=='06117-1023-picker-20260923'
 subprocess.run(['python3',str(current/'preserve.py'),str(live)],check=True)
 before=json.loads((old/'manifest.json').read_text())['files'];now=json.loads((current/'manifest.json').read_text())['files']
 for rel,e in before.items():
  if now.get(rel)==e:continue
  assert rel.startswith('web/')
  target=live/rel;tmp=target.with_name(target.name+'.rollback-tmp');shutil.copy2(old/'files'/rel,tmp);tmp.replace(target)
 subprocess.run(['python3',str(old/'preserve.py'),str(live)],check=True)
 pointer=base/'current.rollback-picker';pointer.symlink_to(old);pointer.replace(base/'current')
 print('PREVIOUS_PICKER_RESTORED_NO_RESTART')
