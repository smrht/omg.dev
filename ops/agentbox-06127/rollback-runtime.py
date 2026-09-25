#!/usr/bin/env python3
"""Run from the retained backup directory to restore SOFTWARE ONLY, never data/."""
import importlib.machinery,importlib.util,pathlib,subprocess
backup=pathlib.Path(__file__).resolve().parent
assert (backup/'manifest.json').is_file(), 'Copy beside the verified backup manifest first'
loader=importlib.machinery.SourceFileLoader('safe_update',str(backup/'omg-safe-update.before'))
spec=importlib.util.spec_from_loader(loader.name,loader);module=importlib.util.module_from_spec(spec);loader.exec_module(module)
cfg=module.Config();cfg.backup_root=backup.parent
manifest=module.read_manifest(backup)
assert module.sha256_file(backup/manifest['releaseArchive'])==manifest['releaseSha256']
old=pathlib.Path((backup/'private-before.txt').read_text().strip());private=pathlib.Path.home()/'.local/lib/omg-private'
with module.update_lock(cfg):
 next_link=private/'current.rollback';next_link.symlink_to(old);next_link.replace(private/'current')
 module.restore_backup(cfg,backup,restart=True)
 module.wait_for_api(cfg)
 subprocess.run(['python3',str(old/'preserve.py'),str(cfg.root)],check=True)
 print('RUNTIME_ROLLBACK_OK; current data, settings and session records retained')
