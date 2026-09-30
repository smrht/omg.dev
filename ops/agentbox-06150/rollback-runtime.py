"""Run beside verified backup manifest; restore SOFTWARE ONLY, retain newer userdata."""
import importlib.machinery,importlib.util,pathlib,subprocess,shutil
backup=pathlib.Path(__file__).resolve().parent;assert (backup/'manifest.json').is_file()
loader=importlib.machinery.SourceFileLoader('safe_update',str(backup/'omg-safe-update.before'))
spec=importlib.util.spec_from_loader(loader.name,loader);m=importlib.util.module_from_spec(spec);loader.exec_module(m)
cfg=m.Config();cfg.backup_root=backup.parent
manifest=m.read_manifest(backup);assert m.sha256_file(backup/manifest['releaseArchive'])==manifest['releaseSha256']
old=pathlib.Path((backup/'private-before.txt').read_text().strip());private=pathlib.Path.home()/'.local/lib/omg-private'
assert old.is_dir() and old.parent==private/'releases'
with m.update_lock(cfg):
 subprocess.run(['python3',str(backup/'agents.py'),'rollback',str(backup)],check=True)
 link=private/'current.rollback-06150';link.symlink_to(old);link.replace(private/'current')
 shutil.copy2(backup/'omg-pilot-check.before',pathlib.Path.home()/'bin/omg-pilot-check')
 cfg.restart_cmd=['systemctl','--user','restart','omg.service']
 m.restore_backup(cfg,backup,restart=True);m.wait_for_api(cfg)
 subprocess.run(['python3',str(old/'preserve.py'),str(cfg.root)],check=True)
 print('RUNTIME_ROLLBACK_OK; current data, settings, sessions and browser retained')
