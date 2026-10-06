"""Real private bind-mount aliases must exclude an overlapping unwrapped native."""
from contextlib import contextmanager
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch

import codex_account_observation as observation

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('writer', HERE / 'account-writer.py')
writer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(writer)


@contextmanager
def native(binary, home):
    child = subprocess.Popen([binary], env={**os.environ, 'CODEX_HOME': str(home)},
                             stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        ready = json.loads(child.stdout.readline())
        assert ready['pid'] == child.pid and ready['locks'] == 0, 'fixture must be an unwrapped native'
        yield child
    finally:
        if child.poll() is None:
            child.terminate()  # Only the synthetic child created by this fixture.
        child.wait(timeout=5)


def require_busy(home):
    try:
        writer.stable_census(home)
    except writer.Busy:
        return
    raise AssertionError('live unwrapped native must make every bind alias busy')


def old_path_digest(evidence):
    canonical, device, inode = evidence
    return hashlib.sha256(b'neutron-codex-account-v1\0' + os.fsencode(canonical)
                          + b'\0' + str(device).encode('ascii') + b':' + str(inode).encode('ascii')).hexdigest()


def inside(account, alias, distinct, binary):
    # Positive kernel evidence: paths differ, directory device/inode agree.
    assert account.resolve() != alias.resolve()
    assert (account.stat().st_dev, account.stat().st_ino) == (alias.stat().st_dev, alias.stat().st_ino)
    assert (account.stat().st_dev, account.stat().st_ino) != (distinct.stat().st_dev, distinct.stat().st_ino)
    with native(binary, account):
        require_busy(account)
        require_busy(alias)
        writer.main(['--census', str(distinct)])
        for args in (['--census', str(alias)], ['--home', str(alias), '--', binary]):
            result = subprocess.run([sys.executable, '-B', str(HERE / 'account-writer.py'), *args],
                                    capture_output=True, text=True, timeout=10)
            assert result.returncode == 73 and 'accountBusy' in result.stderr, 'alias consumer must refuse busy'
        # Exercise the actual TypeScript credential-mutation consumer too.
        program = ("const {withCodexAccountWriteLease}=await import(process.argv[1]);"
                   "let changed=false,code;try{withCodexAccountWriteLease(process.argv[2],()=>{changed=true})}"
                   "catch(error){code=error.code}process.stdout.write(JSON.stringify({changed,code}));")
        result = subprocess.run(['bun', '--eval', program, str(HERE / 'account-writer-lock.ts'), str(alias)],
                                capture_output=True, text=True, timeout=10)
        assert result.returncode == 0 and json.loads(result.stdout) == {'changed': False, 'code': 'accountBusy'}, 'alias mutation must not run'
        # Restoring the old formula makes this exact live consuming assertion
        # fail. Always refusing also fails the distinct-account positive above.
        with patch.object(observation, '_account_digest', old_path_digest):
            rejected = False
            try:
                require_busy(alias)
            except AssertionError:
                rejected = True
            assert rejected, 'restored path-bearing identity mutant must fail'
        require_busy(alias)
    writer.main(['--census', str(alias)])
    print('real bind alias: native and mutation busy; distinct and released accounts admit; path-hash mutant rejected')


if sys.argv[1:2] == ['--inside']:
    inside(*map(Path, sys.argv[2:5]), sys.argv[5])
else:
    with tempfile.TemporaryDirectory(prefix='codex-bind-alias-') as directory:
        root = Path(directory)
        account, alias, distinct = [root / name for name in ('account', 'alias', 'distinct')]
        for path in (account, alias, distinct):
            path.mkdir()
        # Bubblewrap constructs the bind only in a fresh user/mount/PID
        # namespace. Unsupported isolation is a failure, never a host mount.
        command = ['bwrap', '--unshare-user', '--uid', str(os.getuid()), '--gid', str(os.getgid()),
                   '--unshare-pid', '--as-pid-1', '--die-with-parent', '--bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
                   '--bind', str(account), str(alias), sys.executable, '-B', __file__, '--inside',
                   str(account), str(alias), str(distinct), sys.argv[1]]
        result = subprocess.run(command, capture_output=True, text=True, timeout=25)
        assert result.returncode == 0, 'private bind-alias control failed: ' + result.stderr
        assert 'path-hash mutant rejected' in result.stdout
        print(result.stdout, end='')
