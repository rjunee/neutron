"""Kernel controls: isolate outsiders, never excuse unreadable insiders."""
from contextlib import contextmanager
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('writer', HERE / 'account-writer.py')
writer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(writer)


@contextmanager
def potential_native(home, readable):
    # Only synthetic Python, never the installed CLI or credential material.
    source = ('import ctypes,sys,time\n'
              'assert ctypes.CDLL(None).prctl(4,int(sys.argv[1])) == 0\n'
              'print("ready",flush=True)\ntime.sleep(30)\n')
    child = subprocess.Popen(['codex', '-c', source, '1' if readable else '0'],
                             executable=sys.executable, stdout=subprocess.PIPE,
                             env={**os.environ, 'CODEX_HOME': str(home)})
    try:
        assert child.stdout.readline() == b'ready\n'
        yield child
    finally:
        # Popen owns and reaps only this fixture child, never a census target.
        if child.poll() is None:
            child.terminate()
        child.wait(timeout=5)


def unreadable_refuses(home):
    try:
        writer.stable_census(home)
    except PermissionError as error:
        assert error.errno == 13
        return
    raise AssertionError('unreadable live potential native must refuse')


def inside(home):
    # The external unreadable fixture is absent from this private proc mount.
    writer.stable_census(home)
    with potential_native(home, True):
        try:
            writer.stable_census(home)
        except writer.Busy:
            pass
        else:
            raise AssertionError('known live native must be found by the same census')
        writer.stable_census(home / 'distinct-account')
    writer.stable_census(home)
    with potential_native(home, False):
        unreadable_refuses(home)
    writer.stable_census(home)
    print('private proc excludes outsider; known native busy; unknown insider refused; cleared census admitted')


if sys.argv[1:] == ['--inside']:
    with tempfile.TemporaryDirectory(prefix='codex-census-inside-') as directory:
        inside(Path(directory))
else:
    with tempfile.TemporaryDirectory(prefix='codex-census-outside-') as directory:
        home = Path(directory)
        writer.stable_census(home)
        with potential_native(home, False):
            unreadable_refuses(home)
            launcher = HERE.parents[2] / 'trident' / 'process-test-isolation.py'
            result = subprocess.run([sys.executable, '-B', str(launcher), '--',
                                     sys.executable, '-B', __file__, '--inside'],
                                    capture_output=True, text=True, timeout=20)
            assert result.returncode == 0, 'private census control failed: ' + result.stderr
            assert 'unknown insider refused' in result.stdout
        writer.stable_census(home)
    print('outside refusal and isolated native positive/negative controls passed')
