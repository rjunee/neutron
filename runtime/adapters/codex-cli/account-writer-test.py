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

    def state(self, state, birth):
        (self.pid / 'stat').write_text('1 (codex) ' + ' '.join([state] + ['0'] * 18 + [birth]))

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
        with patch.object(writer, 'process_identity', side_effect=[('S', '123'), ('R', '123')]):
            with self.assertRaises(writer.Busy):
                writer.census(self.home, self.proc)
        with patch.object(writer, 'process_identity', side_effect=[('S', '123'), ('R', '124')]):
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
