import hashlib,json,shutil,subprocess,tempfile,unittest
from pathlib import Path
class RemovalGuard(unittest.TestCase):
 def test_tombstone_and_drift(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);bundle=root/'bundle';target=root/'target';bundle.mkdir();target.mkdir();(bundle/'files').mkdir()
   shutil.copy2(Path(__file__).with_name('preserve.py'),bundle/'preserve.py')
   (target/'package.json').write_text('{"version":"0.6.150"}')
   (target/'removed.ts').write_text('old feature')
   entry={'upstream':hashlib.sha256(b'old feature').hexdigest(),'custom':None}
   (bundle/'manifest.json').write_text(json.dumps({'version':'0.6.150','files':{'removed.ts':entry}}))
   def call(*args):return subprocess.run(['python3',str(bundle/'preserve.py'),str(target),*args],capture_output=True)
   self.assertNotEqual(call().returncode,0)
   self.assertEqual(call('--apply').returncode,0);self.assertFalse((target/'removed.ts').exists())
   self.assertEqual(call('--apply').returncode,0);self.assertEqual(call().returncode,0)
   (target/'removed.ts').write_text('unreviewed change')
   self.assertNotEqual(call('--apply').returncode,0);self.assertEqual((target/'removed.ts').read_text(),'unreviewed change')
if __name__=='__main__':unittest.main()
