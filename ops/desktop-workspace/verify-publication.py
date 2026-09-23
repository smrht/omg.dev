#!/usr/bin/env python3
"""Verify publication without treating a concurrently archived chat as data loss."""
import argparse,json,pathlib,sqlite3,subprocess
p=argparse.ArgumentParser();p.add_argument('--baseline',type=pathlib.Path,required=True);a=p.parse_args();base=a.baseline.expanduser();h=pathlib.Path.home()
# Reuse the reviewed capture definition, never its capture/write command branch.
scope={};exec((base/'state.py').read_text().split("if sys.argv[1]")[0],scope)
before=json.loads((base/'before-state.json').read_text());now=scope['capture']()
for cat in ['settings','configs','routines','pids']:
 changed=[k for k,v in before[cat].items() if now[cat].get(k)!=v]
 assert not changed,cat+' changed: '+', '.join(changed)
missing=set(before['sessions'])-set(now['sessions']);archived=[]
with sqlite3.connect('file:'+str(h/'omg/data/resume-cache.sqlite')+'?mode=ro',uri=True,timeout=2) as cache, sqlite3.connect('file:'+str(h/'omg/data/transcript-index.sqlite')+'?mode=ro',uri=True,timeout=2) as transcripts:
 for sid in sorted(missing):
  row=cache.execute('SELECT archived_at,resumable FROM resumable_sessions WHERE session_id=?',(sid,)).fetchone()
  assert row and row[0] and row[0]>=(base/'before-state.json').stat().st_mtime*1000 and row[1], 'Missing session without a new archive record'
  count=transcripts.execute('SELECT count(*) FROM transcript_messages WHERE session_id=?',(sid,)).fetchone()[0]
  assert count>0,'Archived session has no retained transcript'
  archived.append({'sessionId':sid,'messages':count,'archivedAt':row[0]})
assert (h/'.local/lib/omg-private/current').resolve().name=='06117-1024-desktop-20260923'
subprocess.run(['python3',str(h/'.local/lib/omg-private/current/preserve.py'),str(h/'omg')],check=True)
service=subprocess.check_output(['systemctl','--user','show','omg.service','-p','MainPID','-p','ExecMainStartTimestamp','-p','ActiveState'],text=True)
assert service==(base/'service-before.txt').read_text(),'OMG service identity/state changed'
catalog=scope['api']('/api/coding-agents');op=next(x for x in catalog['agents'] if x['key']=='opencode');assert op['visible'] and op['status']['configured'] and op['status']['accountConnected']
assert 'zai-coding-plan/glm-5.3-flash' in next(x for x in catalog['models'] if x['key']=='opencode')['models']
print(json.dumps({'result':'PUBLICATION_PRESERVATION_OK','settings':len(before['settings']),'routines':len(before['routines']),'baseline_sessions':len(before['sessions']),'still_live':len(set(before['sessions'])&set(now['sessions'])),'archived_with_transcript':archived,'Computer_processes':len(before['pids']),'service_unchanged':True}))
