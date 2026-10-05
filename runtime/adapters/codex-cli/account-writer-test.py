import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('writer', Path(__file__).with_name('account-writer.py'))
writer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(writer)


class CensusTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='codex-census-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / 'account'
        self.home.mkdir()
        self.proc = self.root / 'proc'
        self.proc.mkdir()
        (self.proc / str(os.getpid())).mkdir()
        self.pid = self.proc / str(os.getpid() + 100000)
        self.pid.mkdir()
        (self.pid / 'exe').symlink_to('/synthetic/codex')
        (self.pid / 'cmdline').write_bytes(b'codex\0exec\0')
        (self.pid / 'environ').write_bytes(('CODEX_HOME=' + str(self.home) + '\0').encode())
        self.state('S', '123')

    def state(self, state, birth, flags=0, comm='codex'):
        fields = [state] + ['0'] * 18 + [birth]
        fields[6] = str(flags)
        (self.pid / 'stat').write_text(self.pid.name + ' (' + comm + ') ' + ' '.join(fields))

    def change_after_stat_read(self, state, birth, flags):
        original = Path.read_text

        def read(path, *args, **kwargs):
            value = original(path, *args, **kwargs)
            if path == self.pid / 'stat':
                self.state(state, birth, flags)
            return value

        return patch.object(Path, 'read_text', read)

    def test_matching_home_busy_distinct_home_admitted(self):
        with self.assertRaises(writer.Busy):
            writer.census(self.home, self.proc)
        writer.census(self.root / 'other', self.proc)

    def test_default_home_is_a_consumer(self):
        (self.pid / 'environ').write_bytes(('HOME=' + str(self.root) + '\0').encode())
        with self.assertRaises(writer.Busy):
            writer.census(self.root / '.codex', self.proc)

    def test_empty_live_environment_is_unknown_and_requires_a_fresh_census(self):
        (self.pid / 'environ').write_bytes(b'')
        with self.assertRaisesRegex(ValueError, 'home is unknown'):
            writer.census(self.home, self.proc)

    def test_scheduler_state_change_does_not_invent_identity_change(self):
        with self.change_after_stat_read('R', '123', 0):
            with self.assertRaises(writer.Busy):
                writer.census(self.home, self.proc)
        with self.change_after_stat_read('R', '124', 0):
            with self.assertRaisesRegex(ValueError, 'changed'):
                writer.census(self.home, self.proc)

    def test_missing_environment_and_incomplete_census_are_unknown(self):
        (self.pid / 'environ').unlink()
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            writer.census(self.home, self.proc)
        (self.proc / str(os.getpid())).rmdir()
        with self.assertRaisesRegex(ValueError, 'Incomplete'):
            writer.census(self.home, self.proc)

    def test_zombie_is_dead_but_unreadable_live_process_is_not(self):
        (self.pid / 'exe').unlink()
        self.state('Z', '123')
        writer.census(self.home, self.proc)
        self.state('S', '123')
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            writer.census(self.home, self.proc)

    def test_kernel_task_without_executable_is_admitted_only_with_stable_evidence(self):
        (self.pid / 'exe').unlink()
        (self.pid / 'cmdline').write_bytes(b'')
        (self.pid / 'environ').write_bytes(b'')
        # Literal independent of the implementation constant; comm may contain
        # spaces and parentheses, and unrelated flags may also be set.
        self.state('I', '123', 0x00200000 | 0x40, 'worker (pool)')
        with self.change_after_stat_read('R', '123', 0x00200000 | 0x40):
            writer.census(self.home, self.proc)
        # Identical empty argv/missing exe, but a userspace task: unknown.
        self.state('S', '123', 0x40)
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            writer.census(self.home, self.proc)

    def test_kernel_pid_reuse_or_flag_change_is_unknown(self):
        (self.pid / 'exe').unlink()
        for birth, flags in [('124', 0x00200000), ('123', 0), ('123', 0x00200001)]:
            with self.subTest(birth=birth, flags=flags):
                self.state('I', '123', 0x00200000)
                with self.change_after_stat_read('S', birth, flags):
                    with self.assertRaisesRegex(ValueError, 'changed'):
                        writer.census(self.home, self.proc)

    def test_malformed_kernel_stat_cannot_authorize_admission(self):
        (self.pid / 'exe').unlink()
        self.state('I', '123', 0x00200000)
        valid = (self.pid / 'stat').read_text()
        for malformed in ['', valid.replace(') ', ' ', 1), valid.replace(self.pid.name, '1', 1),
                          valid.rsplit(' ', 1)[0], valid.replace('2097152', '-1'),
                          valid.replace('2097152', '4294967296'),
                          valid.replace('2097152', 'kernel'), valid.replace('123', '-1'),
                          valid.replace(') I ', ') ? ')]:
            with self.subTest(stat=malformed):
                (self.pid / 'stat').write_text(malformed)
                with self.assertRaisesRegex(ValueError, 'malformed'):
                    writer.census(self.home, self.proc)

    def test_permission_denied_stat_or_userspace_executable_is_unknown(self):
        with patch.object(Path, 'read_text', side_effect=PermissionError()):
            with self.assertRaises(PermissionError):
                writer.census(self.home, self.proc)
        with patch.object(os, 'readlink', side_effect=PermissionError()):
            with self.assertRaises(PermissionError):
                writer.census(self.home, self.proc)

    def test_kernel_second_stat_read_must_succeed(self):
        self.state('I', '123', 0x00200000)
        valid = (self.pid / 'stat').read_text()
        for error in [PermissionError(), FileNotFoundError()]:
            with self.subTest(error=type(error).__name__):
                with patch.object(Path, 'read_text', side_effect=[valid, error, valid]):
                    with self.assertRaises((PermissionError, ValueError)):
                        writer.census(self.home, self.proc)

    def test_retry_requires_complete_observation_and_never_discards_busy(self):
        with patch.object(writer, 'census', side_effect=[PermissionError(), None]) as check:
            writer.stable_census(self.home)
            self.assertEqual(check.call_count, 2)
        with patch.object(writer, 'census', side_effect=PermissionError()) as check:
            with self.assertRaises(PermissionError):
                writer.stable_census(self.home)
            self.assertEqual(check.call_count, 3)
        with patch.object(writer, 'census', side_effect=writer.Busy()) as check:
            with self.assertRaises(writer.Busy):
                writer.stable_census(self.home)
            self.assertEqual(check.call_count, 1)


if __name__ == '__main__':
    unittest.main()
