#!/usr/bin/env python3
"""Offline #751 diagnostic; does not prove an authenticated worker turn.

Requires Linux, claude, bun and git. --seed-only supports mutation measurement.
Uses isolated config and a fresh Git worktree; never answers the trust dialog.
"""
import argparse
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import subprocess
import tempfile
import time
import uuid

SEED = Path(__file__).resolve().parents[2] / 'runtime/adapters/claude-code/persistent/ensure-claude-trust.ts'
ANSI = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')


def measure(root, variant):
    config = root / 'config'
    config.mkdir(exist_ok=True)
    cwd = root / ('repo' if variant == 'cwd' else 'tree')
    (config / '.claude.json').write_text(json.dumps({
        'hasCompletedOnboarding': True, 'theme': 'dark', 'projects': {},
    }))
    if variant == 'seed':
        source = 'import {ensureClaudeTrust} from ' + json.dumps(str(SEED)) + ';'
        source += 'ensureClaudeTrust(' + json.dumps({'cwd': str(cwd), 'configDir': str(config)}) + ')'
        subprocess.run(['bun', '-e', source], check=True, capture_output=True)
    argv = ['claude', '--session-id', str(uuid.uuid4()),
            '--dangerously-load-development-channels', 'server:neutron-probe',
            '--tools', 'Read,Glob,Grep,Edit,Write,Bash',
            '--restricted', '--permission-mode', 'acceptEdits',
            '--add-dir', str(root / 'tree'), '--autocompact', 'auto']
    if variant == 'add-dir':
        index = argv.index('--add-dir')
        del argv[index:index + 2]
    if variant == 'restricted':
        argv.remove('--restricted')
    if variant == 'settings':
        argv += ['--settings', '{"permissions":{"defaultMode":"acceptEdits"}}']
    master, slave = pty.openpty()
    child = None
    output = ''
    try:
        child = subprocess.Popen(argv, cwd=cwd,
                                 env=dict(os.environ, CLAUDE_CONFIG_DIR=str(config), TERM='xterm-256color'),
                                 stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        slave = None
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if select.select([master], [], [], 0.1)[0]:
                try:
                    output += os.read(master, 65536).decode(errors='replace')
                except OSError:
                    break
            normalized = ANSI.sub(' ', output)
            trust = 'Accessing workspace:' in normalized
            ready = 'accept edits on' in normalized
            if (trust and 'trust this folder' in normalized) or ready:
                assert Path(os.readlink(f'/proc/{child.pid}/cwd')) == cwd, 'Unexpected process cwd'
                if variant == 'seed':
                    assert ready and not trust, 'Existing cwd seed did not clear trust'
                else:
                    assert trust and str(cwd) in normalized, 'Unexpected trust workspace'
                print(json.dumps({'variant': variant, 'cwd_matches': True,
                                  'trust_dialog': trust, 'repl_prompt': ready,
                                  'authenticated_turn_proven': False}), flush=True)
                return
            if child.poll() is not None:
                break
        raise AssertionError('No conclusive trust dialog or REPL prompt within 15 seconds')
    finally:
        if child is not None:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGKILL)
            child.wait()
        os.close(master)
        if slave is not None:
            os.close(slave)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seed-only', action='store_true')
    args = parser.parse_args()
    print(subprocess.check_output(['claude', '--version'], text=True).strip(), flush=True)
    with tempfile.TemporaryDirectory(prefix='claude-trust-proof-') as directory:
        root = Path(directory).resolve()
        subprocess.run(['git', 'init', '-q', str(root / 'repo')], check=True)
        subprocess.run(['git', '-C', str(root / 'repo'), '-c', 'user.name=Probe',
                        '-c', 'user.email=probe@example.invalid', 'commit', '--allow-empty', '-qm', 'probe'], check=True)
        subprocess.run(['git', '-C', str(root / 'repo'), 'worktree', 'add', '-q', str(root / 'tree')], check=True)
        variants = ['seed'] if args.seed_only else ['baseline', 'cwd', 'add-dir', 'restricted', 'settings', 'seed']
        for variant in variants:
            measure(root, variant)


if __name__ == '__main__':
    main()
