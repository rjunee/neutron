#!/usr/bin/env python3
"""Linux account writer admission. Exec, do not supervise, the credential writer.

Exit 73 means busy; 74 means admission unknown. No credential bytes are read.
The permanent lock inode and inherited open-file description outlive all parents.
"""
import fcntl
import json
import os
from pathlib import Path
import platform
import shutil
import stat
import sys
import time

LOCK_NAME = '.neutron-account-writer.lock'


class Busy(Exception):
    pass


def canonical_home(value):
    home = Path(value)
    if not home.is_absolute():
        raise ValueError('Account home must be absolute')
    home.mkdir(mode=0o700, parents=True, exist_ok=True)
    home = home.resolve()
    if home.stat().st_uid != os.getuid():
        raise ValueError('Account home must be owned and canonical')
    return home


def lock(home, inherited=None):
    fd = inherited if inherited is not None else os.open(home / LOCK_NAME,
        os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    observed = os.fstat(fd)
    named = os.stat(home / LOCK_NAME, follow_symlinks=False)
    if not stat.S_ISREG(observed.st_mode) or observed.st_nlink != 1 or observed.st_uid != os.getuid() \
            or observed.st_mode & 0o077 or (observed.st_dev, observed.st_ino) != (named.st_dev, named.st_ino):
        raise ValueError('Account lock identity unknown')
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        raise Busy('Another native process owns this account') from error
    os.set_inheritable(fd, True)
    return fd


def process_identity(path):
    data = (path / 'stat').read_text()
    fields = data[data.rfind(')') + 2:].split()
    return fields[0], fields[19]


def census(home, proc=Path('/proc')):
    """Unwrapped native consumers are competitors too; failed reads are unknown.

    Only executable Codex processes count, not a shell carrying CODEX_HOME.
    Unset CODEX_HOME uses the process's HOME.
    """
    entries = list(proc.iterdir())
    if not any(p.name == str(os.getpid()) for p in entries):
        raise ValueError('Incomplete process census')
    for path in entries:
        if not path.name.isdigit() or int(path.name) == os.getpid():
            continue
        try:
            if path.stat().st_uid != os.getuid():
                continue
            before = process_identity(path)
            if before[0] in ('Z', 'X'):
                continue
            argv = os.fsdecode((path / 'cmdline').read_bytes()).split('\0')
            executable = Path(os.readlink(path / 'exe')).name
            is_codex = executable == 'codex' or any(Path(v).name in ('codex', 'codex.js') for v in argv[:2])
            if not is_codex:
                continue
            environment = dict(v.split('=', 1) for v in os.fsdecode((path / 'environ').read_bytes()).split('\0') if '=' in v)
            after = process_identity(path)
            if before[1] != after[1]:
                raise ValueError('Process census changed')
            if after[0] in ('Z', 'X'):
                continue
            value = environment.get('CODEX_HOME')
            if not value:
                if not environment.get('HOME'):
                    raise ValueError('Native account home is unknown')
                value = str(Path(environment['HOME']) / '.codex')
            candidate = Path(value)
            if not candidate.is_absolute():
                candidate = Path(os.readlink(path / 'cwd')) / candidate
            if candidate.resolve() == home:
                raise Busy('An existing native consumer owns this account')
        except FileNotFoundError:
            # A vanished PID is the only unreadable process proven gone.
            if path.exists():
                try:
                    if process_identity(path)[0] in ('Z', 'X'):
                        continue
                except FileNotFoundError:
                    if not path.exists():
                        continue
                raise ValueError('Process census is incomplete')


def stable_census(home):
    # Exec/exit can momentarily make proc entries unreadable. Only a subsequent
    # complete scan can admit; an expired observation is never an empty census.
    for attempt in range(3):
        try:
            census(home)
            return
        except Busy:
            raise
        except (OSError, ValueError):
            if attempt == 2:
                raise
            time.sleep(0.005)


def native_command(binary, env):
    """Resolve the official npm wrapper's native package instead of losing FD 3
    at its Node spawn(stdio=inherit). Unknown JS wrappers fail closed.
    """
    resolved = shutil.which(binary, path=env.get('PATH'))
    if not resolved:
        raise ValueError('Codex executable unavailable')
    target = Path(resolved).resolve()
    with target.open('rb') as handle:
        header = handle.read(256)
    if header.startswith(b'#!') and (b'node' in header.split(b'\n')[0] or target.suffix == '.js'):
        root = target.parent.parent
        package = json.loads((root / 'package.json').read_text())
        if package.get('name') != '@openai/codex' or target != root / 'bin' / 'codex.js':
            raise ValueError('Unrecognized Codex launcher cannot preserve the writer lock')
        architecture = {'x86_64': ('x86_64', 'x64'), 'aarch64': ('aarch64', 'arm64')}[platform.machine()]
        triple = architecture[0] + '-unknown-linux-musl'
        name = 'codex-linux-' + architecture[1]
        candidates = [root / 'node_modules' / '@openai' / name, root.parent / name]
        roots = [candidate / 'vendor' for candidate in candidates] + [root / 'vendor']
        native = next((r / triple / 'bin' / 'codex' for r in roots if (r / triple / 'bin' / 'codex').is_file()), None)
        if native is None:
            raise ValueError('Native Codex package unavailable')
        env['CODEX_MANAGED_PACKAGE_ROOT'] = str(root)
        env['CODEX_MANAGED_BY_NPM'] = '1'
        return str(native.resolve())
    return str(target)


def main(argv):
    if sys.platform != 'linux':
        raise ValueError('Account admission requires Linux process evidence')
    if argv[0] == '--census':
        home = canonical_home(argv[1])
        stable_census(home)
        return
    if argv[0] == '--resolve':
        env = dict(os.environ)
        native = native_command(argv[1], env)
        print(json.dumps(native))
        return
    inherited = None
    home_value = os.environ.get('CODEX_HOME')
    while argv and argv[0] != '--':
        option, value, *argv = argv
        if option == '--home':
            home_value = value
        elif option == '--inherited-lock-fd':
            inherited = int(value)
        else:
            raise ValueError('Unknown launcher option')
    binary, *arguments = argv[1:]
    env = dict(os.environ)
    native = native_command(binary, env)
    home = canonical_home(home_value or str(Path(os.environ['HOME']) / '.codex'))
    fd = lock(home, inherited)
    stable_census(home)
    env['CODEX_HOME'] = str(home)
    # Keep the exact PID/start identity, cwd, stdio, signals and inherited FD.
    os.execve(native, [native, *arguments], env)


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except Busy:
        print('accountBusy: Another native process owns this account; use a distinct account or wait for its exit', file=sys.stderr)
        sys.exit(73)
    except Exception:
        print('accountAdmissionUnknown: Account writer admission could not be established', file=sys.stderr)
        sys.exit(74)
