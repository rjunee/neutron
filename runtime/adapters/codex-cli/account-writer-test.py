"""Credential-free classifier and admission controls."""
import importlib.util
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch
import codex_account_observation as observation

spec = importlib.util.spec_from_file_location('writer', Path(__file__).with_name('account-writer.py'))
writer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(writer)


class CensusTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='codex-census-')
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.home = self.root / 'account'
        self.home.mkdir()
        (self.root / '.codex').mkdir()
        self.proc = self.root / 'proc'
        self.proc.mkdir()
        self.binary = self.root / 'codex'
        self.binary.touch()
        self.own = self.process(os.getpid(), False)
        self.pid = self.process(os.getpid() + 100000, True)

    def process(self, pid, native):
        path = self.proc / str(pid)
        path.mkdir()
        (path / 'exe').symlink_to(self.binary if native else '/usr/bin/true')
        (path / 'cmdline').write_bytes(b'codex\0exec\0' if native else b'true\0')
        (path / 'environ').write_bytes(('CODEX_HOME=' + str(self.home) + '\0').encode())
        (path / 'status').write_text('Uid: ' + ' '.join([str(os.getuid())] * 4))
        (path / 'root').symlink_to('/')
        (path / 'cwd').symlink_to(self.root)
        (path / 'ns').mkdir()
        for name in ('mnt', 'user', 'pid'):
            (path / 'ns' / name).symlink_to(name + ':[123]')
        self.state(path, 'S', '123')
        return path

    def state(self, path, state, birth, flags=0, comm='codex'):
        fields = [state] + ['0'] * 18 + [birth]
        fields[6] = str(flags)
        (path / 'stat').write_text(path.name + ' (' + comm + ') ' + ' '.join(fields))

    def scan(self):
        return observation.observe_uid(os.getuid(), self.proc)

    def admitted(self, home):
        with patch.object(writer, 'observe_account_consumers', side_effect=lambda _uid: self.scan()):
            writer.census(home)

    def busy(self, home=None):
        with self.assertRaises(writer.Busy):
            self.admitted(home or self.home)

    def test_same_distinct_alias_and_relative_accounts(self):
        self.busy()
        other = self.root / 'other'
        other.mkdir()
        self.admitted(other)
        alias = self.root / 'alias'
        alias.symlink_to(self.home)
        for value in (str(alias), 'account'):
            (self.pid / 'environ').write_bytes(('CODEX_HOME=' + value + '\0').encode())
            self.busy()
        self.assertEqual(observation.account_identity(alias, os.getuid()), observation.account_identity(self.home, os.getuid()))

    def test_default_home_and_verified_real_uid_nss_fallback(self):
        (self.pid / 'environ').write_bytes(('HOME=' + str(self.root) + '\0').encode())
        self.busy(self.root / '.codex')
        for env in (b'', b'HOME=\0CODEX_HOME=\0'):
            (self.pid / 'environ').write_bytes(env)
            with patch.object(observation.pwd, 'getpwuid', return_value=SimpleNamespace(pw_uid=os.getuid(), pw_dir=str(self.root))) as lookup:
                self.busy(self.root / '.codex')
                self.assertTrue(all(call.args == (os.getuid(),) for call in lookup.call_args_list))

    def test_invalid_missing_changed_nss_refuses(self):
        (self.pid / 'environ').write_bytes(b'')
        for value in (SimpleNamespace(pw_uid=os.getuid() + 1, pw_dir=str(self.root)),
                      SimpleNamespace(pw_uid=os.getuid(), pw_dir='relative')):
            with patch.object(observation.pwd, 'getpwuid', return_value=value):
                with self.assertRaises(observation.ObservationUnknown):
                    self.scan()
        with patch.object(observation.pwd, 'getpwuid', side_effect=KeyError()):
            with self.assertRaises(observation.ObservationUnknown):
                self.scan()
        values = [SimpleNamespace(pw_uid=os.getuid(), pw_dir=str(value)) for value in (self.root, self.home)]
        with patch.object(observation.pwd, 'getpwuid', side_effect=values):
            with self.assertRaisesRegex(observation.ObservationUnknown, 'changed'):
                self.scan()

    def test_mount_namespace_account_equivalence_and_nss(self):
        (self.pid / 'ns' / 'mnt').unlink()
        (self.pid / 'ns' / 'mnt').symlink_to('mnt:[456]')
        self.busy()
        (self.pid / 'environ').write_bytes(b'')
        with patch.object(observation.pwd, 'getpwuid', return_value=SimpleNamespace(pw_uid=os.getuid(), pw_dir=str(self.root))):
            # The same root/account inode does not prove another mount
            # namespace sees the same NSS configuration or provider database.
            with self.assertRaises(observation.ObservationUnknown):
                self.scan()
        (self.pid / 'root').unlink()
        (self.pid / 'root').symlink_to(self.home)
        with self.assertRaises(observation.ObservationUnknown):
            self.scan()

    def test_foreign_user_or_pid_namespace_refuses(self):
        for name in ('user', 'pid'):
            link = self.pid / 'ns' / name
            link.unlink()
            link.symlink_to(name + ':[456]')
            with self.assertRaises(observation.ObservationUnknown):
                self.scan()
            link.unlink()
            link.symlink_to(name + ':[123]')

    def test_credentials_not_inode_ownership_select_population(self):
        original = Path.stat
        def read(path, *args, **kwargs):
            return SimpleNamespace(st_uid=os.getuid() + 1) if path == self.pid else original(path, *args, **kwargs)
        with patch.object(Path, 'stat', read):
            self.busy()
        (self.pid / 'status').write_text('Uid: ' + ' '.join([str(os.getuid() + 1)] * 4))
        self.admitted(self.home)
        (self.pid / 'status').write_text('Uid: ' + ' '.join([str(os.getuid()), str(os.getuid() + 1)] * 2))
        with self.assertRaises(observation.ObservationUnknown):
            self.scan()

    def test_missing_required_read_and_non_codex_executable_refuse(self):
        for name in ('environ', 'status', 'exe', 'stat'):
            target, saved = self.pid / name, self.pid / (name + '-saved')
            target.rename(saved)
            try:
                with self.assertRaises(observation.ObservationUnknown):
                    self.scan()
            finally:
                saved.rename(target)
        (self.pid / 'exe').unlink()
        (self.pid / 'exe').symlink_to('/usr/bin/true')
        (self.pid / 'cmdline').write_bytes(b'true\0')
        (self.pid / 'environ').unlink()
        self.admitted(self.home)
        (self.pid / 'exe').unlink()
        self.state(self.pid, 'S', '123', comm='(sd-pam)')
        with self.assertRaises(observation.ObservationUnknown):
            self.scan()

    def test_stable_kernel_and_zombie_exclusion(self):
        (self.pid / 'exe').unlink()
        for state, flags in (('Z', 0), ('I', 0x00200000 | 0x40)):
            self.state(self.pid, state, '123', flags, 'worker (pool)')
            self.admitted(self.home)
        self.state(self.pid, 'S', '123', 0x40)
        with self.assertRaises(observation.ObservationUnknown):
            self.scan()

    def test_non_codex_exclusion_requires_stable_executable(self):
        (self.pid / 'exe').unlink()
        (self.pid / 'exe').symlink_to('/usr/bin/true')
        (self.pid / 'cmdline').write_bytes(b'true\0')
        original = observation._exe
        calls = 0
        def changed(path):
            nonlocal calls
            value = original(path)
            if path == self.pid:
                calls += 1
                if calls >= 2:
                    return str(self.binary), value[1], value[2]
            return value
        with patch.object(observation, '_exe', changed):
            with self.assertRaisesRegex(observation.ObservationUnknown, 'changed'):
                self.scan()

    def test_changed_identity_and_classification_refuse(self):
        original = observation.process_identity
        for target in ('birth', 'flags', 'uids', 'argv', 'exe', 'environment', 'cwd'):
            with self.subTest(target=target):
                self.setUp()
                calls = 0
                if target == 'cwd':
                    (self.pid / 'environ').write_bytes(b'CODEX_HOME=account\0')
                def read(path):
                    nonlocal calls
                    value = original(path)
                    if path == self.pid:
                        calls += 1
                        if calls == 2:
                            if target in ('birth', 'flags'):
                                self.state(path, 'S', '124' if target == 'birth' else '123', 1 if target == 'flags' else 0)
                            elif target == 'uids':
                                (path / 'status').write_text('Uid: 1 2 3 4')
                            elif target == 'argv':
                                (path / 'cmdline').write_bytes(b'true\0')
                            elif target in ('exe', 'cwd'):
                                (path / target).unlink()
                                (path / target).symlink_to('/usr/bin/true' if target == 'exe' else self.home)
                            else:
                                (path / 'environ').write_bytes(b'HOME=/missing\0')
                    return value
                with patch.object(observation, 'process_identity', read):
                    with self.assertRaises(observation.ObservationUnknown):
                        self.scan()

    def test_malformed_kernel_identity_refuses(self):
        self.state(self.pid, 'I', '123', 0x00200000)
        valid = (self.pid / 'stat').read_text()
        for value in ('', valid.replace('2097152', '-1'), valid.replace('2097152', '4294967296'),
                      valid.replace(') I ', ') ? '), valid.rsplit(' ', 1)[0]):
            (self.pid / 'stat').write_text(value)
            with self.assertRaises(observation.ObservationUnknown):
                self.scan()

    def test_enumeration_and_budgets_refuse(self):
        with self.assertRaises(observation.ObservationUnknown):
            observation.observe_uid(os.getuid(), self.proc, max_processes=1)
        with patch.object(observation.time, 'monotonic_ns', side_effect=[0, 3000000000]):
            with self.assertRaisesRegex(observation.ObservationUnknown, 'budget'):
                self.scan()
        original = Path.iterdir
        calls = 0
        def entries(path):
            nonlocal calls
            calls += 1
            return original(path) if calls == 1 else iter([self.own])
        with patch.object(Path, 'iterdir', entries):
            with self.assertRaisesRegex(observation.ObservationUnknown, 'changed'):
                self.scan()

    def test_account_replacement_changes_identity(self):
        before = observation.account_identity(self.home, os.getuid())
        self.home.rename(self.root / 'old-account')
        self.home.mkdir()
        self.assertNotEqual(observation.account_identity(self.home, os.getuid()), before)

    def test_physical_account_identity_collapses_bind_alias_paths(self):
        alias = self.root / 'bind-alias'
        # Two canonical paths to one verified directory object are equivalent;
        # a different inode remains independent. Real mounts are covered by the
        # consuming bind-alias fixture, without this observation seam.
        original = observation.account_evidence
        physical = original(self.home, os.getuid())
        def evidence(path, uid):
            if Path(path) == alias:
                return str(alias), physical[1], physical[2]
            return original(path, uid)
        with patch.object(observation, 'account_evidence', evidence):
            self.assertEqual(observation.account_identity(alias, os.getuid()), observation.account_identity(self.home, os.getuid()))
            self.busy(alias)
        self.assertNotEqual(observation.account_identity(self.root / '.codex', os.getuid()), observation.account_identity(self.home, os.getuid()))

    def test_retry_only_admits_complete_observation_and_preserves_busy(self):
        with patch.object(writer, 'census', side_effect=[observation.ObservationUnknown(), None]) as check:
            writer.stable_census(self.home)
            self.assertEqual(check.call_count, 2)
        with patch.object(writer, 'census', side_effect=observation.ObservationUnknown()) as check:
            with self.assertRaises(observation.ObservationUnknown):
                writer.stable_census(self.home)
            self.assertEqual(check.call_count, 3)
        with patch.object(writer, 'census', side_effect=writer.Busy()) as check:
            with self.assertRaises(writer.Busy):
                writer.stable_census(self.home)
            self.assertEqual(check.call_count, 1)


if __name__ == '__main__':
    unittest.main()
