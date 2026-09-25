import pathlib,subprocess,json
h=pathlib.Path.home();r=h/'.cache/agent-tmp/omg-update-06127/pristine';guard=h/'.local/lib/omg-private/releases/06127-agentbox-20260925/preserve.py'
p=r/'src/agent-catalog.ts';original=p.read_bytes();p.write_bytes(original+b'\n// simulated unreviewed drift\n')
try:
 out=subprocess.run(['python3',str(guard),str(r),'--apply'],capture_output=True,text=True)
 assert out.returncode!=0 and 'Unreviewed local change' in out.stderr
finally:p.write_bytes(original)
p=r/'package.json';original=p.read_text();value=json.loads(original);value['version']='0.6.128';p.write_text(json.dumps(value))
try:
 out=subprocess.run(['python3',str(guard),str(r),'--apply'],capture_output=True,text=True)
 assert out.returncode!=0 and 'not verified' in out.stderr
finally:p.write_text(original)
subprocess.run(['python3',str(guard),str(r)],check=True)
print('GUARD_NEGATIVE_CONTROLS_PASS')
