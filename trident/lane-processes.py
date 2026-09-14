#!/usr/bin/env python3
"""Linux lane ownership: random claims identify children; pidfds address signals.

No registry is required: the claim travels in the initial exec environment, including
socket-created children. PID/start/boot are only evidence of the owner's liveness.
Unclaimed processes are eligible only in a removed wf_* root of an explicitly named
repository. Unsupported kernels and unreadable evidence refuse cleanup.
"""
import argparse
import json
import os
from pathlib import Path
import re
import select
import signal
import subprocess
import sys
import time
import uuid

CLAIM = 'NEUTRON_LANE_CLAIM'


def birth(pid):
    # comm may contain spaces and parentheses; starttime is field 22.
    fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
    return fields[19], fields[0]


def boot():
    return Path('/proc/sys/kernel/random/boot_id').read_text().strip()


def parse_claim(raw):
    try:
        c = json.loads(raw)
        if (set(c) != {'id', 'pid', 'start', 'boot'} or
                not re.fullmatch(r'[0-9a-f]{32}', c['id']) or
                type(c['pid']) is not int or c['pid'] <= 1 or
                not isinstance(c['start'], str) or not c['start'].isdigit() or
                not isinstance(c['boot'], str) or not c['boot']):
            return None
        return c
    except (ValueError, TypeError, KeyError):
        return None


def owner_state(c):
    try:
        current_boot = boot()
    except OSError:
        return 'unknown'
    if c['boot'] != current_boot:
        return 'dead'
    try:
        start, state = birth(c['pid'])
        if start != c['start'] or state == 'Z':
            return 'dead'
        return 'live'
    except FileNotFoundError:
        return 'dead'
    except (OSError, ValueError, IndexError):
        return 'unknown'


def environment_claim(pid):
    entries = Path(f'/proc/{pid}/environ').read_bytes().split(b'\0')
    values = [e[len(CLAIM) + 1:] for e in entries if e.startswith((CLAIM + '=').encode())]
    if not values:
        return None
    c = parse_claim(values[0]) if len(values) == 1 else None
    if c is None:
        raise ValueError('malformed lane claim')
    return c


def deleted_root(pid, repos, protected):
    cwd = os.readlink(f'/proc/{pid}/cwd')
    # The suffix alone is ambiguous: a live directory may literally have that name.
    if os.stat(f'/proc/{pid}/cwd').st_nlink != 0:
        return False
    cwd = cwd.removesuffix(' (deleted)')
    for repo in repos:
        prefix = os.path.realpath(repo) + '/.claude/worktrees/'
        if not cwd.startswith(prefix):
            continue
        name = cwd[len(prefix):].split('/')[0]
        if not name.startswith('wf_'):
            continue
        root = prefix + name
        if root in {os.path.realpath(path) for path in protected}:
            return False
        try:
            os.stat(root)
        except FileNotFoundError:
            return True
        # Other errors propagate: unknown is never absent.
    return False


def sweep(repos=(), protected=(), finished=None, grace=1):
    report = {'reaped': [], 'survived': [], 'unknown': 0, 'live': 0}
    targets = []
    # pidfd must be supported; never degrade to kill(pid).
    for entry in os.listdir('/proc'):
        if not entry.isdigit() or int(entry) == os.getpid():
            continue
        pid = int(entry)
        fd = None
        try:
            if os.stat(f'/proc/{pid}').st_uid != os.getuid():
                continue
            fd = os.pidfd_open(pid)
            c = environment_claim(pid)
            if finished is not None:
                eligible = c is not None and c == finished
            elif c is not None:
                state = owner_state(c)
                if state == 'unknown':
                    report['unknown'] += 1
                if state == 'live':
                    report['live'] += 1
                eligible = state == 'dead'
            else:
                eligible = deleted_root(pid, repos, protected)
            if not eligible:
                continue
            # A recycled numeric PID can only make the original handle exited.
            # Check AFTER the proc reads, so data from a successor cannot authorize it.
            if select.select([fd], [], [], 0)[0]:
                continue
            signal.pidfd_send_signal(fd, signal.SIGTERM)
            targets.append((pid, fd))
            fd = None
        except ProcessLookupError:
            pass
        except (OSError, ValueError, IndexError):
            report['unknown'] += 1
        finally:
            if fd is not None:
                os.close(fd)
    if targets:
        # One grace period for the batch, bounded independently of process count.
        time.sleep(grace)
    deadline = time.monotonic() + 1
    for pid, fd in targets:
        try:
            if not select.select([fd], [], [], 0)[0]:
                signal.pidfd_send_signal(fd, signal.SIGKILL)
            gone = bool(select.select([fd], [], [], max(0, deadline - time.monotonic()))[0])
            report['reaped' if gone else 'survived'].append(pid)
        except ProcessLookupError:
            report['reaped'].append(pid)
        except OSError:
            report['survived'].append(pid)
        finally:
            os.close(fd)
    return report


def run(command):
    # Publish the complete claim through exec before any build code can run.
    c = {'id': uuid.uuid4().hex, 'pid': os.getpid(), 'start': birth(os.getpid())[0], 'boot': boot()}
    env = dict(os.environ, **{CLAIM: json.dumps(c, separators=(',', ':'))})
    child = subprocess.Popen(command, env=env)
    code = child.wait()
    report = sweep(finished=c)
    if report['reaped'] or report['survived']:
        print(json.dumps(report), file=sys.stderr)
    return code if code >= 0 else 128 - code


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['run', 'sweep'])
    parser.add_argument('--repo', action='append', default=[])
    parser.add_argument('--protect', action='append', default=[])
    args, command = parser.parse_known_args()
    if command[:1] == ['--']:
        command = command[1:]
    try:
        # Probe the actual kernel too, before allowing any build code to run.
        if not hasattr(signal, 'pidfd_send_signal'):
            raise RuntimeError('pidfd_send_signal unavailable')
        os.close(os.pidfd_open(os.getpid()))
    except (AttributeError, OSError, RuntimeError):
        print('CODEX_BUILD_PROCESS_OWNERSHIP_UNAVAILABLE: Python 3.9+ with Linux pidfds is required. DEFERRED.', file=sys.stderr)
        return 3
    if args.mode == 'run':
        if not command:
            parser.error('run requires a command after --')
        return run(command)
    if command:
        parser.error('unexpected sweep arguments')
    print(json.dumps(sweep(args.repo, args.protect)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
