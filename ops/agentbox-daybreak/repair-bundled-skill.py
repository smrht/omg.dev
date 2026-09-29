"""Add the missing official builder skill without overwriting personal agents."""
import pathlib,hashlib,json,shutil,sys
h=pathlib.Path.home();w=h/'.cache/agent-tmp/omg-daybreak-sessions';private=h/'.local/lib/omg-private/current';expected=h/'.local/lib/omg-private/releases/06143-daybreak-sessions-20260929';assert private.resolve()==expected
name='agents/skills/omg-app-builder/SKILL.md';source=w/'official-builder-SKILL.md';digest=hashlib.sha256(source.read_bytes()).hexdigest();assert digest==sys.argv[1]
dest=h/'omg'/name;assert not dest.exists(),'existing agent instructions are protected'
m=json.loads((private/'manifest.json').read_text());assert name not in m['files']
shutil.copy2(private/'manifest.json',w/'manifest-before-bundled-skill.json')
file=private/'files'/name;file.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,file)
m['files'][name]={'upstream':digest,'custom':digest,'previous':None}
tmp=private/'manifest.next-skill.json';tmp.write_text(json.dumps(m,indent=2)+'\n');tmp.replace(private/'manifest.json')
import subprocess
subprocess.run(['python3',str(private/'preserve.py'),str(h/'omg'),'--apply'],check=True)
assert hashlib.sha256(dest.read_bytes()).hexdigest()==digest
print('OFFICIAL_MISSING_BUILDER_SKILL_RESTORED_NO_OVERWRITE')
