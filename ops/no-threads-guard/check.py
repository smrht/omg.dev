#!/usr/bin/env python3
"""Fail closed when the removed people-first Threads feature is reintroduced.

Installed outside ~/omg. Run after private overlays and before service startup.
Provider conversation IDs and archived message formats are deliberately allowed.
"""
import argparse
from pathlib import Path
import re
import sys

FORBIDDEN = (
    'src/threads.ts', 'src/thread-completion.ts', 'src/thread-model.ts',
    'web/src/components/threads.tsx', 'web/src/components/pull-to-thread.tsx',
    'web/src/lib/threads.ts',
)
TOKENS = (
    '/api/threads', 'omg_list_threads', 'omg_read_thread',
    'omg_send_thread_message', 'ThreadRailSection', 'createThreadConversation',
    'PullToThread',
)
WEB_TOKENS = TOKENS + ('New thread', 'Nieuwe thread')
REQUIRED = ('package.json', 'src/commands/serve.ts', 'src/commands/mcp.ts',
            'web/dist/index.html')
# Vite imports, lazy imports and dependency maps all contain quoted .js paths.
JS_REF = re.compile(r'''["']([^"'\s<>]+\.js(?:\?[^"'\s<>]*)?)["']''')


def check(root):
    root = Path(root).resolve()
    errors = []
    for name in REQUIRED:
        if not (root / name).is_file():
            errors.append('missing required entrypoint: ' + name)
    for name in FORBIDDEN:
        if (root / name).exists():
            errors.append('removed module restored: ' + name)
    for base in ('src', 'web/src'):
        for path in (root / base).rglob('*'):
            if path.suffix not in ('.ts', '.tsx', '.js', '.jsx') or '.test.' in path.name:
                continue
            content = '\n'.join(line for line in path.read_text().splitlines() if not line.lstrip().startswith('//'))
            for token in TOKENS:
                if token in content:
                    errors.append(f'{path.relative_to(root)}: {token}')
    dist = root / 'web/dist'
    pending = [dist / 'index.html']
    visited = set()
    while pending:
        path = pending.pop().resolve()
        if path in visited:
            continue
        if not path.is_relative_to(dist.resolve()) or not path.is_file():
            errors.append('missing or external active web asset: ' + str(path))
            continue
        visited.add(path)
        content = path.read_text()
        for token in WEB_TOKENS:
            if token in content:
                errors.append(f'{path.relative_to(root)}: {token}')
        for match in JS_REF.finditer(content):
            ref = match.group(1).split('?')[0]
            # Syntax highlighters contain token names ending in .js. They are not assets.
            context = content[max(0, match.start() - 40):match.start()]
            explicit = re.search(r'(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\bsrc=)$', context)
            if not explicit and not ref.startswith(('./', 'assets/', '/assets/')):
                continue
            if '://' in ref or ref.startswith('//'):
                errors.append('unreviewed external JavaScript: ' + ref)
                continue
            if ref.startswith('/'):
                target = dist / ref.lstrip('/')
            elif ref.startswith('assets/'):
                target = dist / ref
            else:
                target = path.parent / ref
            pending.append(target)
    if not any(p.suffix == '.js' for p in visited):
        errors.append('no active JavaScript bundle found')
    return errors, len(visited)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    args = parser.parse_args()
    try:
        errors, assets = check(args.root)
    except (OSError, ValueError) as error:
        print('NO_THREADS_REFUSED: cannot verify installation: ' + str(error), file=sys.stderr)
        return 1
    if errors:
        print('NO_THREADS_REFUSED: port the removal before updating; keep the current release.', file=sys.stderr)
        print('\n'.join(errors[:20]), file=sys.stderr)
        return 1
    print(f'NO_THREADS_OK active_web_files={assets}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
