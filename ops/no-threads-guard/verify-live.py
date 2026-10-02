#!/usr/bin/env python3
"""Read-only checks of deployed guard, updater wiring and known upstream release."""
import hashlib
from pathlib import Path
import subprocess

remote = r'''
import importlib.machinery, importlib.util, json, subprocess
from pathlib import Path
from types import SimpleNamespace
from urllib.request import urlopen
from urllib.error import HTTPError
home=Path.home()
loader=importlib.machinery.SourceFileLoader('safe', str(home/'bin/omg-safe-update'))
spec=importlib.util.spec_from_loader(loader.name,loader)
m=importlib.util.module_from_spec(spec);loader.exec_module(m)
assert (home/'.config/omg/no-threads-required').is_file()
m.enforce_no_threads(SimpleNamespace(root=home/'omg'))
try:
    m.enforce_no_threads(SimpleNamespace(root=home/'.cache/agent-tmp/no-threads-06157/extracted'))
except m.SafeUpdateError as e:
    assert 'NO_THREADS_REFUSED' in str(e)
else: raise AssertionError('official upstream release incorrectly accepted')
props=subprocess.check_output(['systemctl','--user','show','omg.service','-p','ExecStartPre','-p','MainPID','-p','ActiveState'],text=True)
assert '/.local/lib/omg-no-threads/check.py' in props
assert props.index('omg-no-threads/check.py') > props.index('agentbox_resource_policy.py')
assert 'ActiveState=active' in props and 'MainPID=1790026' in props
assert json.loads((home/'omg/package.json').read_text())['version']=='0.6.150'
assert urlopen('http://127.0.0.1:8766/').status==200
for route in ('/api/threads','/api/threads/new'):
    try: urlopen('http://127.0.0.1:8766'+route)
    except HTTPError as e: assert e.code==404
    else: raise AssertionError('thread endpoint restored')
print('LIVE_POLICY_OK: current passes, official 0.6.157 refused, startup hook last, PID unchanged, root 200, thread API 404')
'''
subprocess.run(['ssh','agentbox2','python3 -'],input=remote,text=True,check=True)
for local, target in (
    (Path(__file__).with_name('check.py'), '.local/lib/omg-no-threads/check.py'),
    (Path(__file__).with_name('99-no-threads.conf'), '.config/systemd/user/omg.service.d/99-no-threads.conf'),
    (Path('/Users/samht/sites-beheer/scripts/agentbox/omg-safe-update'), 'bin/omg-safe-update'),
):
    actual=subprocess.check_output(['ssh','agentbox2','sha256sum',target],text=True).split()[0]
    assert actual==hashlib.sha256(local.read_bytes()).hexdigest(), target
print('LIVE_HASHES_OK')
