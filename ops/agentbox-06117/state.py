import json,hashlib,pathlib,urllib.request,sys,subprocess,time,os
h=pathlib.Path.home(); w=pathlib.Path(os.environ.get('OMG_UPDATE_BASELINE_DIR',str(h/'.cache/agent-tmp/omg-update-06117')))
def api(path):
 with urllib.request.urlopen('http://127.0.0.1:8766'+path,timeout=20) as response:return json.load(response)
def digest(x):return hashlib.sha256(json.dumps(x,sort_keys=True).encode()).hexdigest()
def capture():
 settings=api('/api/settings')['settings']; routines=api('/api/auto/agents?full=1')['agents']
 record=json.loads((h/'.omg/computer/desktop.json').read_text());pids={}
 for k,pid in record['pids'].items():
  p=pathlib.Path('/proc')/str(pid)/'stat'
  if p.exists():pids[k]={'pid':pid,'tick':p.read_text().split(') ')[1].split()[19]}
  elif k!='wm':raise Exception('Required Computer process missing '+k)
 configs={}
 for p in [h/'omg/.env',h/'.config/omg/agentbox-runs.env',h/'.config/opencode/opencode.json',h/'.config/opencode/opencode.jsonc',h/'omg/data/claude-accounts.json',h/'omg/data/connectors.json',h/'omg/data/connector-oauth.enc']:
  if p.is_file():configs[str(p)]=hashlib.sha256(p.read_bytes()).hexdigest()
 return {'settings':{k:digest(v) for k,v in settings.items()},'routines':{a['id']:digest({k:a.get(k) for k in ['name','prompt','schedule','enabled','quiet','agent','model','thinkingLevel','cwd','owner']}) for a in routines},'quiet':sum(bool(a.get('quiet')) for a in routines),'configs':configs,'pids':pids,'sessions':sorted(x['sessionId'] for x in api('/api/sessions')['sessions'] if isinstance(x.get('sessionId'),str)),'private':str((h/'.local/lib/omg-private/current').resolve())}
if sys.argv[1]=='capture':
 state=capture();p=w/'before-state.json';p.write_text(json.dumps(state));p.chmod(0o600)
 print('BASELINE_CAPTURED',len(state['settings']),'settings',len(state['routines']),'routines',state['quiet'],'quiet',len(state['sessions']),'sessions',len(state['pids']),'Computer processes')
else:
 old=json.loads((w/'before-state.json').read_text());now=capture()
 for cat in ['settings','configs','routines','pids']:
  changed=[k for k,v in old[cat].items() if now[cat].get(k)!=v]
  assert not changed,cat+' changed: '+', '.join(changed)
 assert set(old['sessions'])<=set(now['sessions']),'session identities disappeared'
 subprocess.run(['python3',str(h/'.local/lib/omg-private/current/preserve.py'),str(h/'omg')],check=True)
 catalog=api('/api/coding-agents')
 op=next(a for a in catalog['agents'] if a['key']=='opencode')
 assert op['visible'] and op['status']['configured'] and op['status']['accountConnected']
 models=next(m for m in catalog['models'] if m['key']=='opencode')
 assert 'zai-coding-plan/glm-5.3-flash' in models['models']
 print('SETUP_PRESERVED',len(old['settings']),len(old['routines']),len(old['sessions']),len(old['pids']))
