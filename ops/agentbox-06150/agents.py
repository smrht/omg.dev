"""Upgrade four canonical bundled files only; protect every personal instruction."""
import pathlib,json,hashlib,shutil,sys
h=pathlib.Path.home();w=h/'.cache/agent-tmp/omg-update-06150';live=h/'omg';source=h/'.cache/agent-tmp/omg-port-06150/tree'
meta=json.loads((w/'bundled-agents-hashes.json').read_text()) if sys.argv[1]!='rollback' else json.loads((pathlib.Path(sys.argv[2])/'agents-before.json').read_text());paths=sorted(meta)
assert all(n=='agents/skills/omg-app-builder/SKILL.md' or n.startswith('agents/templates/expo/') for n in paths)
assert all('..' not in pathlib.Path(n).parts for n in paths)
def sha(p):
 if not p.is_file():return None
 with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
mode=sys.argv[1]
if mode=='plan':
 rows={}
 for n in paths:
  before=sha(live/n);after=meta[n]['after'];assert before is None or before==meta[n]['before'],'personal edit: '+n
  assert sha(source/n)==after
  rows[n]={'before':before,'after':after}
 (w/'agents-plan.json').write_text(json.dumps(rows));print('BUNDLED_AGENT_PLAN_OK',len(rows),'canonical/missing files')
elif mode=='sync-candidate':
 rows=json.loads((w/'agents-plan.json').read_text());snap=h/'.local/lib/omg-private/releases/06150-agentbox-20260930';m=json.loads((snap/'manifest.json').read_text())
 for n,row in rows.items():
  assert sha(live/n)==row['before'] and sha(source/n)==row['after']
  for root in [w/'candidate',snap/'files']:
   p=root/n;p.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source/n,p)
  m['files'][n]={'upstream':sha(w/'pristine'/n),'custom':row['after']}
 (snap/'manifest.json').write_text(json.dumps(m,indent=2)+'\n');print('BUNDLED_CANDIDATE_OK')
elif mode=='check':
 rows=json.loads((w/'agents-plan.json').read_text())
 for n,row in rows.items():assert sha(live/n)==row['before'],'bundled file changed: '+n
 print('BUNDLED_LIVE_UNCHANGED')
elif mode=='apply':
 backup=pathlib.Path(sys.argv[2]);assert (backup/'manifest.json').is_file()
 rows=json.loads((w/'agents-plan.json').read_text())
 for n,row in rows.items():assert sha(live/n)==row['before'] and sha(source/n)==row['after'],'bundled file drift: '+n
 for n,row in rows.items():
  if row['before']:
   p=backup/'bundled-agents'/n;p.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(live/n,p);assert sha(p)==row['before']
 (backup/'agents-before.json').write_text(json.dumps(rows));shutil.copy2(pathlib.Path(__file__),backup/'agents.py')
 for n,row in rows.items():
  p=live/n;p.parent.mkdir(parents=True,exist_ok=True);tmp=p.with_name(p.name+'.06150-next');shutil.copy2(source/n,tmp);tmp.replace(p);assert sha(p)==row['after']
 print('BUNDLED_AGENT_UPGRADE_OK')
elif mode=='rollback':
 backup=pathlib.Path(sys.argv[2]);record=backup/'agents-before.json'
 if not record.exists():raise SystemExit(0)
 rows=json.loads(record.read_text());assert sorted(rows)==sorted(paths)
 for n,row in rows.items():assert sha(live/n) in [row['before'],row['after']],'personal edit since update: '+n
 for n,row in rows.items():
  if sha(live/n)==row['before']:continue
  p=live/n
  if row['before']:
   old=backup/'bundled-agents'/n;assert sha(old)==row['before'];shutil.copy2(old,p)
  else:p.unlink()
 print('BUNDLED_AGENT_SOFTWARE_ROLLBACK_OK')
else:raise SystemExit('unknown mode')
