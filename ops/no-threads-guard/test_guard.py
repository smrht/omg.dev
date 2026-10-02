#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('guard', Path(__file__).with_name('check.py'))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

class GuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        for name in guard.REQUIRED:
            self.write(name, '{}')
        self.write('web/dist/index.html', '<script src="/assets/index-abc.js"></script>')
        self.write('web/dist/assets/index-abc.js', 'import("./lazy-abc.js"); const syntax="entity.method.js";')
        self.write('web/dist/assets/lazy-abc.js', 'const providerThreadId="retained";')
    def tearDown(self):
        self.temp.cleanup()
    def write(self, name, text):
        p = self.root / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
    def test_clean_and_old_inactive_bundle(self):
        self.write('web/dist/assets/old.js', 'fetch("/api/threads")')
        self.assertEqual(guard.check(self.root)[0], [])
    def test_each_feature_token_in_server(self):
        for token in guard.TOKENS:
            self.write('src/new-feature.ts', f'const route="{token}";')
            self.assertTrue(guard.check(self.root)[0], token)
    def test_active_lazy_bundle(self):
        for token in guard.WEB_TOKENS:
            self.write('web/dist/assets/lazy-abc.js', f'const label="{token}";')
            self.assertTrue(guard.check(self.root)[0], token)
    def test_missing_asset(self):
        (self.root / 'web/dist/assets/lazy-abc.js').unlink()
        self.assertTrue(guard.check(self.root)[0])
    def test_missing_entrypoint(self):
        (self.root / 'src/commands/mcp.ts').unlink()
        self.assertTrue(guard.check(self.root)[0])
    def test_removed_module(self):
        self.write('src/threads.ts', '')
        self.assertTrue(guard.check(self.root)[0])
    def test_external_script(self):
        self.write('web/dist/index.html', '<script src="https://example.com/app.js"></script>')
        self.assertTrue(guard.check(self.root)[0])
    def test_comment_not_runtime(self):
        self.write('src/comment.ts', '// /api/threads is removed\nconst providerThreadId="x";')
        self.assertEqual(guard.check(self.root)[0], [])

if __name__ == '__main__':
    result = unittest.TextTestRunner().run(unittest.defaultTestLoader.loadTestsFromTestCase(GuardTests))
    if not result.wasSuccessful():
        raise SystemExit(1)
    print('GUARD_TESTS_OK')
