#!/usr/bin/env python3
"""Linux lane ownership: random claims identify children; pidfds address signals.

No registry is required: the claim travels in the initial exec environment, including
socket-created children. PID namespace/start/boot bind owner liveness evidence.
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


def pid_namespace():
    # Numeric PIDs are meaningful only in this proc view. A host proc mount
    # inherited inside a PID namespace cannot supply evidence for getpid().
    visible_pids = next((line.split()[1:] for line in Path('/proc/self/status').read_text().splitlines()
                         if line.startswith('NSpid:')), [])
    if visible_pids != [str(os.getpid())]:
        raise OSError('proc does not address the current PID namespace')
    return os.readlink('/proc/self/ns/pid')


def parse_claim(raw):
    try:
        c = json.loads(raw)
        if (set(c) not in ({'id', 'pid', 'start', 'boot'}, {'id', 'pid', 'start', 'boot', 'pidns'}) or
                not re.fullmatch(r'[0-9a-f]{32}', c['id']) or
                type(c['pid']) is not int or c['pid'] <= 1 or
                not isinstance(c['start'], str) or not c['start'].isdigit() or
                not isinstance(c['boot'], str) or not c['boot'] or
                ('pidns' in c and (not isinstance(c['pidns'], str) or not re.fullmatch(r'pid:\[[0-9]+\]', c['pidns'])))):
            return None
        return c
    except (ValueError, TypeError, KeyError):
        return None


def owner_state(c):
    try:
        # A missing or recycled number in another namespace says nothing about
        # this owner. Preserve inherited claims; the originating owner can
        # still perform exact-claim teardown from its own process view.
        if c['pidns'] != pid_namespace():
            return 'unknown'
    except (OSError, KeyError):
        return 'unknown'
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
            # A prior cleanup pass leaves exited (possibly unreaped) processes
            # in /proc. Their unreadable environment is not live uncertainty.
            if select.select([fd], [], [], 0)[0]:
                continue
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
        except (FileNotFoundError, ProcessLookupError):
            if fd is not None and not select.select([fd], [], [], 0)[0]:
                report['unknown'] += 1
        except (OSError, ValueError, IndexError):
            # An exit racing a metadata read is resolved only by its pidfd.
            if fd is None or not select.select([fd], [], [], 0)[0]:
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


def census():
    """Snapshot same-user build lanes, including surviving children of dead owners.

    Count claims once, but report every confirmed process. No persisted row is
    used to decide liveness. Unreadable evidence makes the whole count unknown.
    """
    lanes = {}
    errors = []
    observed = time.time()
    try:
        entries = os.listdir('/proc')
        boot_seconds = next(int(line.split()[1]) for line in
                            Path('/proc/stat').read_text().splitlines() if line.startswith('btime '))
        ticks = os.sysconf('SC_CLK_TCK')
    except (OSError, ValueError, StopIteration):
        return {'status': 'unknown', 'reason': 'process table unavailable', 'lanes': []}
    for entry in entries:
        if not entry.isdigit() or int(entry) == os.getpid():
            continue
        pid = int(entry)
        fd = None
        try:
            if os.stat(f'/proc/{pid}').st_uid != os.getuid():
                continue
            fd = os.pidfd_open(pid)
            start, state = birth(pid)
            if state == 'Z':
                continue
            c = environment_claim(pid)
            argv = Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
            # Exact script argument, never a shell command string mentioning it.
            wrapper = len(argv) > 1 and os.path.basename(os.fsdecode(argv[0])) in ('bash', 'sh') and os.path.basename(os.fsdecode(argv[1])) == 'codex-build.sh'
            if c is None and not wrapper:
                continue
            env = dict(part.split(b'=', 1) for part in Path(f'/proc/{pid}/environ').read_bytes().split(b'\0') if b'=' in part)
            run_id = os.fsdecode(env.get(b'NEUTRON_CODEX_BUILD_CHECKPOINT_RUN_ID', b'')) or None
            cwd = os.readlink(f'/proc/{pid}/cwd')
            # The handle binds these reads to the original process, not a reused PID.
            if select.select([fd], [], [], 0)[0]:
                continue
            key = c['id'] if c else f'pid:{pid}:{start}'
            lane = lanes.setdefault(key, {'id': key, 'processes': [], 'run_id': run_id,
                                         'owner': owner_state(c) if c else 'unknown'})
            if lane['run_id'] is None:
                lane['run_id'] = run_id
            lane['processes'].append({'pid': pid, 'started_at': boot_seconds + int(start) / ticks, 'cwd': cwd})
        except (FileNotFoundError, ProcessLookupError):
            pass  # Disappeared during the snapshot: no longer live.
        except (OSError, ValueError, IndexError):
            errors.append(f'process {pid} unreadable')
        finally:
            if fd is not None:
                os.close(fd)
    return {'status': 'unknown' if errors else 'known', 'reason': '; '.join(errors) or None,
            'observed_at': observed, 'lanes': list(lanes.values())}


def run(command, report_path=None, report_token=None):
    # Publish the complete claim through exec before any build code can run.
    c = {'id': uuid.uuid4().hex, 'pid': os.getpid(), 'start': birth(os.getpid())[0],
         'boot': boot(), 'pidns': pid_namespace()}
    env = dict(os.environ, **{CLAIM: json.dumps(c, separators=(',', ':'))})
    cancelled = None

    def cancel(signum, _frame):
        nonlocal cancelled
        if cancelled is None:
            cancelled = signum

    # Keep this owner alive until its exact claim has been reaped. Killing only
    # the wrapper would leave detached test/build children running until a sweep.
    previous = {s: signal.getsignal(s) for s in (signal.SIGTERM, signal.SIGINT)}
    for s, handler in previous.items():
        # Asynchronous shell launches inherit ignored INT. Do not turn it into
        # a new cancellation route that the shell wrapper never supported.
        if handler != signal.SIG_IGN:
            signal.signal(s, cancel)
    try:
        if cancelled:
            return 128 + cancelled
        child = subprocess.Popen(command, env=env)
        while child.poll() is None and not cancelled:
            try:
                child.wait(timeout=.05)
            except subprocess.TimeoutExpired:
                pass
        confirmed = False
        # TERM handlers can create new claim-bearing descendants after the
        # snapshot. Require a subsequent empty, known census; bound adversarial
        # fork-on-TERM chains rather than claiming their cleanup succeeded.
        for _ in range(4):
            report = sweep(finished=c)
            if report_path is None and (report['reaped'] or report['survived']):
                print(json.dumps(report), file=sys.stderr)
            # Unknown unrelated metadata must not prevent later passes from
            # stopping newly-created, positively owned descendants. It still
            # prevents confirmation unless a later census is fully known.
            if not report['reaped'] and not report['survived'] and not report.get('unknown', 0):
                confirmed = True
                break
        foreground = child.poll()
        foreground_exit = None if foreground is None else foreground if foreground >= 0 else 128 - foreground
        code = 128 + cancelled if cancelled else foreground_exit if foreground_exit is not None else 3
        if report_path is not None:
            # The host requests an identity-bound report separately from command
            # stderr. Legacy shell callers retain their exact refusal sentences.
            with open(report_path, 'x') as destination:
                json.dump({'event': 'lane-process-cleanup', 'token': report_token,
                           'owner_pid': os.getpid(), 'signal': cancelled,
                           'exit_code': code, 'foreground_exit': foreground_exit,
                           'status': 'confirmed' if confirmed else 'unknown',
                           **report}, destination)
        if (cancelled and not confirmed) or foreground is None:
            print('LANE_PROCESS_CLEANUP_UNCONFIRMED', file=sys.stderr)
        # Cleanup uncertainty is not a pre-build refusal. Preserve the actual
        # signal outcome; the host independently refuses unconfirmed closure.
        return code
    finally:
        for s, handler in previous.items():
            signal.signal(s, handler)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['run', 'sweep', 'census'])
    parser.add_argument('--repo', action='append', default=[])
    parser.add_argument('--protect', action='append', default=[])
    parser.add_argument('--report-path')
    parser.add_argument('--report-token')
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
        if bool(args.report_path) != bool(args.report_token):
            parser.error('report path and token must be supplied together')
        return run(command, args.report_path, args.report_token)
    if command:
        parser.error('unexpected sweep arguments')
    print(json.dumps(census() if args.mode == 'census' else sweep(args.repo, args.protect)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
