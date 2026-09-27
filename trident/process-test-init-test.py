"""Real init wait proofs; every fixture runs behind the verified PID boundary."""

import importlib.util
import os
from pathlib import Path
import select
import subprocess
import sys
import time
import unittest

spec = importlib.util.spec_from_file_location('isolation', Path(__file__).with_name('process-test-isolation.py'))
isolation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(isolation)
try:
    isolation.require_boundary()
except RuntimeError:
    if __name__ != '__main__':
        raise
    sys.exit(isolation.enter([sys.executable, '-B', str(Path(__file__).resolve()), *sys.argv[1:]]))


class InitWait(unittest.TestCase):
    def test_exited_orphan_is_reaped_while_foreground_runs_and_live_child_is_preserved(self):
        release_read, release_write = os.pipe()
        report_read, report_write = os.pipe()
        code = '''import os,sys
release, report = map(int, sys.argv[1:])
child = os.fork()
if child == 0:
    os.close(report)
    os.read(release, 1)
    os._exit(23)
os.write(report, str(child).encode())
os._exit(0)
'''
        parent = subprocess.Popen([sys.executable, '-c', code, str(release_read), str(report_write)],
                                  pass_fds=(release_read, report_write))
        os.close(release_read)
        os.close(report_write)
        fd = None
        try:
            child = int(os.read(report_read, 64))
            self.assertEqual(parent.wait(timeout=3), 0)
            fd = os.pidfd_open(child)
            status = Path(f'/proc/{child}/status')
            self.assertIn('PPid:\t1\n', status.read_text())
            self.assertFalse(select.select([fd], [], [], 0)[0], 'live orphan was not preserved')
            os.write(release_write, b'x')
            self.assertTrue(select.select([fd], [], [], 3)[0], 'released child did not exit')
            deadline = time.monotonic() + 3
            while status.exists() and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertFalse(status.exists(), 'exited orphan remains unreaped under namespace init')
        finally:
            os.close(report_read)
            os.close(release_write)
            if fd is not None:
                os.close(fd)
            parent.wait(timeout=3)

    def test_exact_foreground_exit_and_signal_status_are_preserved(self):
        for code, expected in [('raise SystemExit(0)', 0), ('raise SystemExit(7)', 7),
                               ('import signal; signal.raise_signal(signal.SIGTERM)', 143)]:
            with self.subTest(expected=expected):
                result = subprocess.run([sys.executable, '-B', isolation.SCRIPT, '--',
                                         sys.executable, '-c', code], timeout=5)
                self.assertEqual(result.returncode, expected)

    def test_foreground_completion_does_not_wait_for_live_orphans(self):
        code = 'import os,time; child=os.fork(); time.sleep(30) if child == 0 else os._exit(7)'
        result = subprocess.run([sys.executable, '-B', isolation.SCRIPT, '--',
                                 sys.executable, '-c', code], timeout=5)
        self.assertEqual(result.returncode, 7)


if __name__ == '__main__':
    unittest.main()
