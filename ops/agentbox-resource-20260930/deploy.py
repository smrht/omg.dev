"""Reviewed, same-version resource-policy cutover. Never restore user databases."""
import hashlib, json, os, pathlib, shutil, subprocess, sys, time, urllib.request

H = pathlib.Path.home()
LIVE = H / 'omg'
BASE = H / '.local/state/omg-update-backups/resource-policy-20260930'
INPUT = BASE / 'delivery'
PRIVATE = H / '.local/lib/omg-private'
ISOLATION = H / '.local/lib/agentbox-isolation'
RELEASE = '06150-resource-policy-20260930'
UNITS = H / '.config/systemd/user'

def run(*args):
    return subprocess.run(list(map(str, args)), check=True, text=True, capture_output=True).stdout

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None

def atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.resource-next')
    temp.write_bytes(data); temp.chmod(0o600); temp.replace(path)

def point(root, target):
    temp = root / 'current.resource-next'
    temp.symlink_to(target); temp.replace(root / 'current')

CONFIG = {
 'computer.slice.d/80-resource-policy.conf': '[Slice]\nMemoryHigh=12G\nMemoryMax=16G\nMemorySwapMax=2G\n',
 'omg.service.d/96-resource-policy.conf': '[Service]\nEnvironment=AGENTBOX_RESOURCE_STATE=%h/.local/state/agentbox-isolation/resource-policy.json\nExecStartPre=/usr/bin/python3 %h/.local/lib/agentbox-isolation/current/agentbox_resource_policy.py --apply\n',
 'agentbox-resource-policy.service': '[Unit]\nDescription=Shared Agentbox pressure policy and bounded elastic soft limits\n[Service]\nType=oneshot\nExecStart=/usr/bin/python3 %h/.local/lib/agentbox-isolation/current/agentbox_resource_policy.py --apply\nSlice=agent-interactive.slice\nMemoryMax=128M\nTimeoutStartSec=15\n',
 'agentbox-resource-policy.timer': '[Unit]\nDescription=Maintain shared Agentbox memory policy\n[Timer]\nOnActiveSec=2s\nOnUnitActiveSec=20s\nAccuracySec=1s\n[Install]\nWantedBy=timers.target\n',
}

def ready():
    with urllib.request.urlopen('http://127.0.0.1:8766/api/install?ready=1', timeout=4) as r:
        payload = json.load(r)
    assert payload['version'] == '0.6.150' and payload.get('bootId')
    return payload['bootId']

def restart():
    run('systemctl', '--user', 'restart', 'omg.service')
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        try: return ready()
        except Exception: time.sleep(1)
    raise RuntimeError('OMG readiness timed out; rollback required')

mode = sys.argv[1]
plan = json.loads((INPUT / 'plan.json').read_text())
if mode in ('stage', 'restage'):
    assert json.loads((LIVE/'package.json').read_text())['version'] == '0.6.150'
    old_private = (PRIVATE/'current').resolve(); old_isolation = (ISOLATION/'current').resolve()
    run('python3', old_private/'preserve.py', LIVE)
    for rel, rec in plan['runtime'].items():
        assert sha(LIVE/rel) == rec['before'], 'Live runtime drift: '+rel
        assert sha(INPUT/'runtime'/rel) == rec['after'], 'Delivery drift: '+rel
    for name, rec in plan['isolation'].items():
        assert sha(old_isolation/name) == rec['before'], 'Live isolation drift: '+name
        assert sha(INPUT/'isolation'/name) == rec['after'], 'Delivery drift: '+name
    assert mode=='restage' or not (BASE/'deployment.json').exists(), 'Already staged; inspect instead of overwriting backup'
    backup = BASE/'changed-before'; backup.mkdir(exist_ok=mode=='restage')
    for rel in plan['runtime']:
        p=LIVE/rel
        if p.exists() and not (backup/'runtime'/rel).exists(): (backup/'runtime'/rel).parent.mkdir(parents=True,exist_ok=True); shutil.copy2(p,backup/'runtime'/rel)
    for rel in CONFIG:
        p=UNITS/rel
        if p.exists() and not (backup/'units'/rel).exists(): (backup/'units'/rel).parent.mkdir(parents=True,exist_ok=True); shutil.copy2(p,backup/'units'/rel)
    (backup/'data').mkdir(exist_ok=mode=='restage')
    if mode=='stage': shutil.copy2(LIVE/'data/claude-accounts.json',backup/'data/claude-accounts.json')
    properties={}
    for name in ('computer.slice','lfg-agents.slice','omg-control.slice'):
        text=run('systemctl','--user','show',name,'-p','MemoryHigh','-p','MemoryMax','-p','MemorySwapMax')
        properties[name]=dict(line.split('=',1) for line in text.splitlines())
    data={'private':str(old_private),'isolation':str(old_isolation),'properties':properties,'bootId':ready()}
    if mode=='stage': atomic(BASE/'deployment.json',json.dumps(data).encode())
    for root,old in ((PRIVATE,old_private),(ISOLATION,old_isolation)):
        new=root/'releases'/RELEASE
        if mode=='stage':
            assert not new.exists(); shutil.copytree(old,new,ignore=shutil.ignore_patterns('__pycache__'))
    new=PRIVATE/'releases'/RELEASE
    manifest=json.loads((new/'manifest.json').read_text())
    for rel,rec in plan['runtime'].items():
        dst=new/'files'/rel; dst.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(INPUT/'runtime'/rel,dst)
        prior=manifest['files'].get(rel)
        manifest['files'][rel]={'upstream':prior['upstream'] if prior else rec['before'],'custom':rec['after']}
    atomic(new/'manifest.json',json.dumps(manifest,indent=2).encode())
    for name in plan['isolation']: shutil.copy2(INPUT/'isolation'/name,ISOLATION/'releases'/RELEASE/name)
    print('RESOURCE_RELEASE_STAGED; runtime and config rollback retained; user data will not be restored')
elif mode == 'activate':
    data=json.loads((BASE/'deployment.json').read_text())
    assert str((PRIVATE/'current').resolve())==data['private']
    assert str((ISOLATION/'current').resolve())==data['isolation']
    for rel,rec in plan['runtime'].items(): assert sha(LIVE/rel)==rec['before'], 'Concurrent source drift: '+rel
    for rel in plan['runtime']: atomic(LIVE/rel,(INPUT/'runtime'/rel).read_bytes())
    point(PRIVATE,PRIVATE/'releases'/RELEASE); point(ISOLATION,ISOLATION/'releases'/RELEASE)
    run('python3',PRIVATE/'current/preserve.py',LIVE)
    for script in ('sqlite_resilience_apply.py','ship_shared_apply.py','omg_isolation_source.py'):
        before={str(p.relative_to(LIVE)):sha(p) for p in (LIVE/'src').rglob('*.ts')}
        run('python3',ISOLATION/'current'/script,LIVE/'src')
        assert before=={str(p.relative_to(LIVE)):sha(p) for p in (LIVE/'src').rglob('*.ts')}, 'Unreviewed start overlay edit'
    for rel,text in CONFIG.items(): atomic(UNITS/rel,text.encode())
    run('systemctl','--user','daemon-reload')
    run('systemctl','--user','set-property','--runtime','computer.slice','MemoryHigh=12G','MemoryMax=16G','MemorySwapMax=2G')
    run('systemctl','--user','enable','--now','agentbox-resource-policy.timer')
    run('systemctl','--user','start','agentbox-resource-policy.service')
    boot=restart(); assert boot!=data['bootId'],'Old control process still running'
    print('RESOURCE_POLICY_ACTIVE version=0.6.150; new boot proven')
elif mode == 'rollback':
    data=json.loads((BASE/'deployment.json').read_text()); backup=BASE/'changed-before'
    run('systemctl','--user','disable','--now','agentbox-resource-policy.timer')
    run('systemctl','--user','stop','agentbox-resource-policy.service')
    for rel,rec in plan['runtime'].items():
        assert sha(LIVE/rel) in (rec['before'],rec['after']), 'Newer source exists; do not overwrite: '+rel
        p=backup/'runtime'/rel
        if p.exists(): atomic(LIVE/rel,p.read_bytes())
        else: (LIVE/rel).unlink(missing_ok=True)
    point(PRIVATE,pathlib.Path(data['private'])); point(ISOLATION,pathlib.Path(data['isolation']))
    for rel in CONFIG:
        p=backup/'units'/rel
        if p.exists(): atomic(UNITS/rel,p.read_bytes())
        else: (UNITS/rel).unlink(missing_ok=True)
    run('systemctl','--user','daemon-reload')
    run('systemctl','--user','set-property','--runtime','computer.slice',*[k+'='+v for k,v in data['properties']['computer.slice'].items()])
    restart(); print('RESOURCE_RUNTIME_ROLLBACK_OK; newer user data retained')
else:
    raise SystemExit('Use stage, activate or rollback')
