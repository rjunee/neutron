#!/usr/bin/env python3
"""Linux account writer admission. Exec, do not supervise, the credential writer.

Exit 73 means busy; 74 means admission unknown. No credential bytes are read.
An inherited flock reserves admission until the actual writer takes a POSIX
process lock. That lock survives exec, but forked tools cannot inherit its ownership.
"""
import errno
import fcntl
import json
import os
from pathlib import Path
import platform
import shutil
import stat
import sys
import time

from codex_account_client import observe_account_consumers
from codex_account_observation import account_identity

LOCK_NAME = '.neutron-account-writer.lock'
NATIVE_LOCK_NAME = '.neutron-account-native.lock'


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


def lock_file(home, name, inherited=None):
    fd = inherited if inherited is not None else os.open(home / name,
        os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    observed = os.fstat(fd)
    named = os.stat(home / name, follow_symlinks=False)
    if not stat.S_ISREG(observed.st_mode) or observed.st_nlink != 1 or observed.st_uid != os.getuid() \
            or observed.st_mode & 0o077 or (observed.st_dev, observed.st_ino) != (named.st_dev, named.st_ino):
        raise ValueError('Account lock identity unknown')
    return fd


def lock(home, inherited=None):
    fd = lock_file(home, LOCK_NAME, inherited)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        raise Busy('Another native process owns this account') from error
    os.set_inheritable(fd, True)
    return fd


def native_lock(home):
    # Dedicated inode: POSIX locks are lost when their owning process closes ANY
    # descriptor for that inode. Never reopen it inside the native process.
    fd = lock_file(home, NATIVE_LOCK_NAME)
    try:
        fcntl.lockf(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as error:
        os.close(fd)
        if error.errno in (errno.EACCES, errno.EAGAIN):
            raise Busy('Another native process owns this account') from error
        raise
    return fd


def census(home):
    identity = account_identity(home, os.getuid())
    result = observe_account_consumers(os.getuid())
    if account_identity(home, os.getuid()) != identity:
        raise ValueError('Account directory changed during observation')
    if any(consumer['accountId'] == identity for consumer in result['nativeConsumers']):
        raise Busy('An existing native consumer owns this account')


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
        identity = account_identity(home, os.getuid())
        # Caller holds the reservation throughout this short-lived probe. A
        # native writer owns the other lock even though its flock is released.
        fd = native_lock(home)
        try:
            stable_census(home)
            if identity != account_identity(home, os.getuid()):
                raise ValueError('Account directory changed during admission')
            lock_file(home, NATIVE_LOCK_NAME, fd)
        finally:
            os.close(fd)
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
    identity = account_identity(home, os.getuid())
    fd = lock(home, inherited)
    lifetime = native_lock(home)
    stable_census(home)
    if identity != account_identity(home, os.getuid()):
        raise ValueError('Account directory changed during admission')
    lock_file(home, LOCK_NAME, fd)
    lock_file(home, NATIVE_LOCK_NAME, lifetime)
    os.set_inheritable(lifetime, True)
    # Only this launch process releases the reservation, and only after it owns
    # lifetime exclusion. Parent descriptors merely close. A native's tools may
    # inherit the FD, but POSIX record-lock ownership does not cross fork.
    fcntl.flock(fd, fcntl.LOCK_UN)
    os.close(fd)
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
