"""Owned read-only ordinary Codex session canary; never touches another chat."""
import json,pathlib,time,sys,urllib.request,urllib.error,secrets
w=pathlib.Path.home()/'.cache/agent-tmp/omg-daybreak-sessions';root='http://127.0.0.1:8766';identity=w/'qa-session.json'
def api(path,body=None):
 request=urllib.request.Request(root+path,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json'},method='GET' if body is None else 'POST')
 with urllib.request.urlopen(request,timeout=30) as r:return json.load(r)
def row(sid):return next((x for x in api('/api/sessions')['sessions'] if x.get('sessionId')==sid),None)
def messages(sid):return api('/api/sessions/'+sid+'/messages?full=1')['messages']
def wait_idle(sid,needle=None,after=0):
 deadline=time.monotonic()+130
 while time.monotonic()<deadline:
  s=row(sid)
  try: rows=messages(sid)
  except urllib.error.HTTPError: rows=[]
  errors=[r for r in rows[after:] if r.get('apiError') or (r.get('role')=='assistant' and 'Codex turn failed:' in r.get('text',''))]
  assert not errors,'own canary returned provider/protocol error: '+errors[-1].get('text','') if errors else ''
  if s and not s.get('busy') and s.get('nativeSessionId') and (needle is None or any(r.get('role')=='assistant' and needle in r.get('text','') for r in rows[after:])):return s,rows
  time.sleep(1)
 raise RuntimeError('owned canary timed out')
mode=sys.argv[1]
if mode=='create':
 assert not identity.exists(),'owned QA session already exists'
 before={x['sessionId'] for x in api('/api/sessions')['sessions']}
 for agent,model in [('codex-aisdk','gpt-6.1-sol'),('opencode','zai-coding-plan/glm-5.3')]:
  try:api('/api/sessions/new',{'agent':agent,'model':model,'cyberAccessProgram':'daybreakBlue','unassigned':True,'title':'QA invalid Daybreak'})
  except urllib.error.HTTPError as e:assert e.code==400
  else:raise RuntimeError('unsupported program accepted')
 assert before=={x['sessionId'] for x in api('/api/sessions')['sessions']},'rejected request created a session'
 print('NEGATIVE_MODEL_BACKEND_NO_SPAWN_OK',flush=True)
 nonce='DB-'+secrets.token_hex(6);fixture=w/'qa-fixture.txt';fixture.write_text(nonce+'\n')
 result=api('/api/sessions/new',{'agent':'codex-aisdk','model':'gpt-6-sol','thinkingLevel':'low','cyberAccessProgram':'daybreakBlue','unassigned':True,'title':'QA Daybreak gewone chat (tijdelijk)','prompt':f'Verbindingstest. Lees uitsluitend met een shell-command het bestand {fixture}. Antwoord met alleen de inhoud. Bewaar die inhoud voor de volgende beurt. Geen andere bestanden lezen of wijzigen; geen agents starten.'})
 sid=result['sessionId'];state={'sessionId':sid,'nonce':nonce};identity.write_text(json.dumps(state));identity.chmod(0o600)
 s,rows=wait_idle(sid,nonce);assert s['cyberAccessProgram']=='daybreakBlue' and s['cyberAccessProgramControl'] is True
 assert any(r.get('role')=='tool' or r.get('kind') in ('tool_use','tool_result','tool') for r in rows),'no real tool transcript'
 state['nativeSessionId']=s['nativeSessionId'];identity.write_text(json.dumps(state))
 print('LIVE_BLUE_REAL_COMMAND_NATIVE_HISTORY_OK',flush=True)
elif mode=='off':
 state=json.loads(identity.read_text());sid=state['sessionId'];before=len(messages(sid));api('/api/sessions/'+sid+'/cyber-access-program',{'cyberAccessProgram':'standard'})
 api('/api/sessions/'+sid+'/send',{'text':'Wat was de inhoud die je in de vorige beurt las? Gebruik geen tools; antwoord alleen die inhoud.','mode':'queue'})
 s,rows=wait_idle(sid,state['nonce'],before);assert s['cyberAccessProgram']=='standard' and s['nativeSessionId']==state['nativeSessionId']
 print('LIVE_EXPLICIT_OFF_SAME_NATIVE_HISTORY_OK',flush=True)
elif mode=='interrupt':
 state=json.loads(identity.read_text());sid=state['sessionId'];before=len(messages(sid));api('/api/sessions/'+sid+'/cyber-access-program',{'cyberAccessProgram':'daybreakBlue'})
 api('/api/sessions/'+sid+'/send',{'text':'Voer alleen het shell-command sleep 20 uit en antwoord daarna WACHTTEST. Geen andere acties.','mode':'queue'})
 deadline=time.monotonic()+35
 while time.monotonic()<deadline:
  s=row(sid)
  if s and s.get('busy'):break
  time.sleep(.3)
 else:raise RuntimeError('interrupt canary did not start')
 try:api('/api/sessions/'+sid+'/cyber-access-program',{'cyberAccessProgram':'standard'})
 except urllib.error.HTTPError as e:assert e.code==409
 else:raise RuntimeError('busy program change accepted')
 api('/api/sessions/'+sid+'/interrupt',{});wait_idle(sid)
 time.sleep(2);s=row(sid);assert s['nativeSessionId']==state['nativeSessionId'] and s['cyberAccessProgram']=='daybreakBlue'
 print('LIVE_BUSY_409_INTERRUPT_OK',flush=True)
elif mode=='resume':
 state=json.loads(identity.read_text());sid=state['sessionId'];api('/api/sessions/'+sid+'/close',{'source':'daybreak-owned-canary'})
 deadline=time.monotonic()+30
 while time.monotonic()<deadline:
  s=row(sid)
  if not s or not s.get('pid'):break
  time.sleep(.5)
 else:raise RuntimeError('owned QA harness remained alive')
 result=api('/api/sessions/resume',{'sessionId':sid,'prompt':'Wat was de inhoud van het bestand uit de eerste beurt? Geen tools; antwoord alleen die inhoud.'});resumed=result['sessionId'];state['sessionId']=resumed;identity.write_text(json.dumps(state))
 s,rows=wait_idle(resumed,state['nonce']);assert s['nativeSessionId']==state['nativeSessionId'] and s['cyberAccessProgram']=='daybreakBlue' and s['cyberAccessProgramControl'] is True
 print('LIVE_COLD_RESUME_PROGRAM_AND_NATIVE_HISTORY_OK',flush=True)
elif mode=='cleanup':
 if identity.exists():
  state=json.loads(identity.read_text());s=row(state['sessionId'])
  if s and s.get('pid'):api('/api/sessions/'+state['sessionId']+'/close',{'source':'daybreak-owned-canary-cleanup'})
  print('OWNED_QA_CLOSED',flush=True)
else:raise SystemExit('unknown mode')
