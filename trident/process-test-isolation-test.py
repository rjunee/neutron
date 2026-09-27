"""Boundary controls: kernel observations and launches are mocked; no signals."""

from contextlib import ExitStack, contextmanager
import importlib.util
from pathlib import Path
import struct
import unittest
from unittest.mock import MagicMock, Mock, patch


spec = importlib.util.spec_from_file_location('isolation', Path(__file__).with_name('process-test-isolation.py'))
isolation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(isolation)
INSIDE = ['--inside', '8', '9', '10', '--', 'fixture']


class Boundary(unittest.TestCase):
    @contextmanager
    def evidence(self, *, previous=(10, 20), pid=2, proc='2', init_pid=11, supervisor=None):
        argv = ['python3', '-B', isolation.SCRIPT, *INSIDE]
        identities = {'/proc/self/ns/pid': (1, 11), '/proc/self/ns/mnt': (1, 21),
                      '/proc/1/fd/9': (1, previous[0]), '/proc/1/fd/10': (1, previous[1]),
                      '/proc/1/ns/pid': (1, init_pid)}
        with ExitStack() as stack:
            stack.enter_context(patch.object(isolation.Path, 'read_bytes', return_value=('\0'.join(supervisor or argv) + '\0').encode()))
            stack.enter_context(patch.object(isolation, 'namespace_identity', side_effect=lambda path, _name: identities[path]))
            stack.enter_context(patch.object(isolation.os, 'readlink', return_value=proc))
            stack.enter_context(patch.object(isolation.os, 'getpid', return_value=pid))
            yield

    def test_replaced_namespaces_and_matching_proc_allow_the_honest_boundary(self):
        with self.evidence():
            isolation.require_boundary()

    def test_each_missing_kernel_proof_refuses(self):
        cases = [{'previous': (11, 20)}, {'previous': (10, 21)}, {'proc': '42'},
                 {'init_pid': 99}, {'supervisor': ['unrelated-init']}]
        for case in cases:
            with self.subTest(case=case), self.evidence(**case):
                with self.assertRaisesRegex(RuntimeError, 'isolation refused'):
                    isolation.require_boundary()

    def test_unreadable_evidence_refuses(self):
        with patch.object(isolation.Path, 'read_bytes', side_effect=PermissionError()):
            with self.assertRaisesRegex(RuntimeError, 'isolation refused'):
                isolation.require_boundary()

    def test_fabricated_baseline_argv_at_existing_pid_one_cannot_launch(self):
        # Exact review counterexample: invented IDs differ from the unchanged
        # namespace. Text is no longer accepted as baseline proof.
        forged = ['python3', '-B', isolation.SCRIPT, '--inside', 'pid:[10]', 'mnt:[20]', '--', 'fixture']
        with self.evidence(pid=1, proc='1', previous=(11, 21), supervisor=forged):
            with patch.object(isolation, 'run_as_init') as run:
                with self.assertRaisesRegex(RuntimeError, 'isolation refused'):
                    isolation.require_boundary()
                with self.assertRaisesRegex(RuntimeError, 'isolation refused'):
                    isolation.main(forged[3:])
            run.assert_not_called()

    def test_numeric_descriptors_still_refuse_unchanged_namespaces(self):
        with self.evidence(pid=1, proc='1', previous=(11, 21)):
            with patch.object(isolation, 'run_as_init') as run:
                with self.assertRaisesRegex(RuntimeError, 'isolation refused'):
                    isolation.main(INSIDE)
            run.assert_not_called()

    def test_namespace_handles_must_be_kernel_typed(self):
        with ExitStack() as stack:
            stack.enter_context(patch.object(isolation.os, 'open', return_value=9))
            close = stack.enter_context(patch.object(isolation.os, 'close'))
            stack.enter_context(patch.object(isolation.os, 'fstat', return_value=Mock(st_dev=1, st_ino=10)))
            ioctl = stack.enter_context(patch.object(isolation.fcntl, 'ioctl', return_value=isolation.NAMESPACE_TYPES['pid']))
            self.assertEqual(isolation.namespace_identity('/proc/1/fd/9', 'pid'), (1, 10))
            ioctl.assert_called_with(9, isolation.NS_GET_NSTYPE)
            ioctl.return_value = isolation.NAMESPACE_TYPES['mnt']
            with self.assertRaisesRegex(RuntimeError, 'isolation refused'):
                isolation.namespace_identity('/proc/1/fd/9', 'pid')
            ioctl.side_effect = OSError('not a namespace')
            with self.assertRaises(OSError):
                isolation.namespace_identity('/proc/1/fd/9', 'pid')
            self.assertEqual(close.call_count, 3)

    def test_parent_identity_and_approval_precede_command_launch(self):
        for peer_pid, reply in [(1, isolation.APPROVED), (0, b''), (0, b'forged'), (0, isolation.APPROVED)]:
            channel = Mock()
            channel.getsockopt.return_value = struct.pack('3i', peer_pid, 1000, 1000)
            channel.recv.return_value = reply
            with self.subTest(peer_pid=peer_pid, reply=reply), self.evidence(pid=1, proc='1'), ExitStack() as stack:
                stack.enter_context(patch.object(isolation.os, 'getuid', return_value=1000))
                connect = stack.enter_context(patch.object(isolation.socket, 'socket'))
                connect.return_value.__enter__.return_value = channel
                run = stack.enter_context(patch.object(isolation, 'run_as_init', return_value=7))
                if peer_pid == 0 and reply == isolation.APPROVED:
                    self.assertEqual(isolation.main(INSIDE), 7)
                    run.assert_called_once_with(['fixture'])
                else:
                    with self.assertRaisesRegex(RuntimeError, 'isolation refused'):
                        isolation.main(INSIDE)
                    run.assert_not_called()
                if peer_pid == 1:
                    channel.sendall.assert_not_called()

    def test_non_init_inside_invocation_cannot_launch(self):
        with patch.object(isolation.os, 'getpid', return_value=7), patch.object(isolation, 'run_as_init') as run:
            with self.assertRaisesRegex(RuntimeError, 'isolation refused'):
                isolation.main(INSIDE)
        run.assert_not_called()

    def test_init_wait_reaps_orphans_and_preserves_only_foreground_status(self):
        for status, expected in [(0, 0), (7 << 8, 7), (15, 143)]:
            child = Mock(pid=42)
            with self.subTest(status=status), patch.object(isolation.os, 'getpid', return_value=1), \
                    patch.object(isolation.signal, 'signal', return_value=Mock()) as disposition, \
                    patch.object(isolation.subprocess, 'Popen', return_value=child) as launch, \
                    patch.object(isolation.os, 'waitpid', side_effect=[(43, 9 << 8), (42, status)]) as wait:
                def spawn(*_args, **_kwargs):
                    disposition.assert_called_once_with(isolation.signal.SIGCHLD, isolation.signal.SIG_DFL)
                    return child
                launch.side_effect = spawn
                self.assertEqual(isolation.run_as_init(['fixture']), expected)
                launch.assert_called_once_with(['fixture'], close_fds=True)
                self.assertEqual(wait.call_args_list, [(( -1, 0),), ((-1, 0),)])
                self.assertEqual(child.returncode, isolation.os.waitstatus_to_exitcode(status))
                child.wait.assert_not_called()
                child.poll.assert_not_called()

    def test_init_never_fabricates_foreground_status_when_wait_is_unknown(self):
        with patch.object(isolation.os, 'getpid', return_value=1), \
                patch.object(isolation.signal, 'signal', return_value=isolation.signal.SIG_IGN) as disposition, \
                patch.object(isolation.subprocess, 'Popen', return_value=Mock(pid=42)), \
                patch.object(isolation.os, 'waitpid', side_effect=ChildProcessError()):
            with self.assertRaises(ChildProcessError):
                isolation.run_as_init(['fixture'])
            disposition.assert_called_once_with(isolation.signal.SIGCHLD, isolation.signal.SIG_DFL)

    def test_non_init_and_check_do_not_reset_dispositions_or_wait_children(self):
        with patch.object(isolation.os, 'getpid', return_value=7), \
                patch.object(isolation, 'require_boundary'), \
                patch.object(isolation.signal, 'signal') as disposition, \
                patch.object(isolation.subprocess, 'Popen') as launch, \
                patch.object(isolation.os, 'waitpid') as wait:
            with self.assertRaisesRegex(RuntimeError, 'isolation refused'):
                isolation.run_as_init(['fixture'])
            self.assertEqual(isolation.main(['--check']), 0)
            disposition.assert_not_called()
            launch.assert_not_called()
            wait.assert_not_called()

    def test_outer_requires_sender_credentials_parent_and_both_new_namespaces(self):
        credentials = [(isolation.socket.SOL_SOCKET, isolation.socket.SCM_CREDENTIALS, struct.pack('3i', 42, 1000, 1000))]
        for fault in (None, 'credentials', 'parent', 'pid', 'mnt'):
            channel = Mock()
            channel.recvmsg.return_value = (isolation.HELLO, [] if fault == 'credentials' else credentials, 0, None)
            identities = {'/proc/42/ns/pid': (1, 10 if fault == 'pid' else 11),
                          '/proc/42/ns/mnt': (1, 20 if fault == 'mnt' else 21)}
            with self.subTest(fault=fault), ExitStack() as stack:
                stack.enter_context(patch.object(isolation.os, 'getuid', return_value=1000))
                stack.enter_context(patch.object(isolation.Path, 'read_text', return_value='PPid:\t' + ('99' if fault == 'parent' else '41')))
                stack.enter_context(patch.object(isolation, 'namespace_identity', side_effect=lambda path, _name: identities[path]))
                if fault is None:
                    isolation.authorize_init(channel, Mock(pid=41), [(1, 10), (1, 20)])
                    channel.sendall.assert_called_once_with(isolation.APPROVED)
                else:
                    with self.assertRaisesRegex(RuntimeError, 'isolation refused'):
                        isolation.authorize_init(channel, Mock(pid=41), [(1, 10), (1, 20)])
                    channel.sendall.assert_not_called()

    def test_launcher_passes_only_bootstrap_handles_and_never_falls_back(self):
        outer, inner = MagicMock(), MagicMock()
        inner.fileno.return_value = 8
        child = Mock(pid=41)
        child.poll.return_value = 69
        child.wait.return_value = 69
        with ExitStack() as stack:
            bind = stack.enter_context(patch.object(isolation, 'bind_to_parent'))
            stack.enter_context(patch.object(isolation.os, 'getpid', return_value=40))
            stack.enter_context(patch.object(isolation.os, 'getppid', return_value=39))
            stack.enter_context(patch.object(isolation.os, 'getuid', return_value=1000))
            stack.enter_context(patch.object(isolation.os, 'getgid', return_value=1001))
            stack.enter_context(patch.object(isolation.os.path, 'isdir', return_value=False))
            stack.enter_context(patch.object(isolation.os, 'open', side_effect=[9, 10]))
            stack.enter_context(patch.object(isolation.os, 'close'))
            stack.enter_context(patch.object(isolation, 'namespace_identity', side_effect=[(1, 10), (1, 20)]))
            stack.enter_context(patch.object(isolation.socket, 'socketpair', return_value=(outer, inner)))
            launch = stack.enter_context(patch.object(isolation.subprocess, 'Popen', return_value=child))
            approve = stack.enter_context(patch.object(isolation, 'authorize_init', side_effect=RuntimeError(isolation.REFUSAL)))
            with self.assertRaisesRegex(RuntimeError, 'isolation refused'):
                isolation.enter(['fixture', 'argument with spaces'])
            expected_argv = ['bwrap', '--unshare-user', '--uid', '1000', '--gid', '1001',
                '--unshare-pid', '--as-pid-1', '--die-with-parent', '--bind', '/', '/', '--dev', '/dev', '--proc', '/proc', isolation.sys.executable,
                '-B', isolation.SCRIPT, '--inside', '8', '9', '10', '--', 'fixture', 'argument with spaces']
            self.assertEqual(launch.call_args.args, (expected_argv,))
            self.assertTrue(launch.call_args.kwargs['close_fds'])
            self.assertEqual(launch.call_args.kwargs['pass_fds'], (8, 9, 10))
            bind.assert_called_once_with(39)
            # Exercise the actual fork hook with a mock, proving the edge is
            # armed BEFORE exec independently of later Python finally blocks.
            launch.call_args.kwargs['preexec_fn']()
            self.assertEqual(bind.call_args.args, (40,))
            approve.assert_called_once()
            self.assertEqual(launch.call_count, 1)

    def test_kernel_parent_binding_covers_early_death_and_arming_race(self):
        for parents, expected_calls, succeeds in [([40, 40], 1, True), ([1], 0, False),
                                                 ([99], 0, False), ([40, 1], 1, False),
                                                 ([40, 99], 1, False)]:
            with self.subTest(parents=parents), patch.object(isolation.os, 'getppid', side_effect=parents), \
                    patch.object(isolation, '_prctl', return_value=0) as prctl:
                if succeeds:
                    isolation.bind_to_parent(40)
                else:
                    with self.assertRaisesRegex(RuntimeError, 'parent changed'):
                        isolation.bind_to_parent(40)
                self.assertEqual(prctl.call_count, expected_calls)
                if expected_calls:
                    prctl.assert_called_once_with(isolation.PR_SET_PDEATHSIG, isolation.signal.SIGKILL, 0, 0, 0)

    def test_kernel_parent_binding_failure_refuses(self):
        with patch.object(isolation.os, 'getppid', return_value=40), patch.object(isolation, '_prctl', return_value=-1):
            with self.assertRaisesRegex(RuntimeError, 'could not bind parent lifetime'):
                isolation.bind_to_parent(40)

    def test_bun_parent_identity_is_passed_to_entry_and_early_death_prevents_spawn(self):
        with patch.object(isolation, 'enter', return_value=7) as enter:
            self.assertEqual(isolation.main(['--parent-pid', '40', '--', 'fixture', '-t', 'name']), 7)
            enter.assert_called_once_with(['fixture', '-t', 'name'], 40)
        with patch.object(isolation.os, 'getppid', return_value=1), \
                patch.object(isolation, '_prctl') as prctl, patch.object(isolation.subprocess, 'Popen') as launch:
            with self.assertRaisesRegex(RuntimeError, 'parent changed before'):
                isolation.main(['--parent-pid', '40', '--', 'fixture'])
        prctl.assert_not_called()
        launch.assert_not_called()


if __name__ == '__main__':
    unittest.main()
