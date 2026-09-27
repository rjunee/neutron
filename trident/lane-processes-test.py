import importlib.util
import io
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

boundary_spec = importlib.util.spec_from_file_location('isolation', Path(__file__).with_name('process-test-isolation.py'))
boundary = importlib.util.module_from_spec(boundary_spec)
boundary_spec.loader.exec_module(boundary)
# Establish the kernel boundary BEFORE loading the owner, including a mutated
# owner. A parent mock cannot constrain a fresh interpreter started by run().
try:
    boundary.require_boundary()
except RuntimeError:
    if __name__ != '__main__':
        raise
    sys.exit(boundary.enter([sys.executable, '-B', str(Path(__file__).resolve()), *sys.argv[1:]]))

spec = importlib.util.spec_from_file_location('lanes', Path(__file__).with_name('lane-processes.py'))
lanes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lanes)


def terminate_and_close_pidfd(fd, timeout=3):
    """Terminate the addressed process and confirm exit before closing its handle."""
    try:
        signal.pidfd_send_signal(fd, signal.SIGKILL)
    except ProcessLookupError:
        pass
    exited = bool(select.select([fd], [], [], timeout)[0])
    os.close(fd)
    if not exited:
        raise TimeoutError('pidfd target did not exit during fixture teardown')


class LaneProcesses(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='lane-process-proof-')
        self.root = Path(self.tmp.name)
        self.children = []
        self.handles = []
        self.subject_pids = []
        # Select deterministic census subjects inside the verified namespace.
        # This mock is NOT containment: fresh owner interpreters do not inherit it.
        # The kernel boundary above contains every exec and later descendant.
        self.proc_listing = patch.object(lanes.os, 'listdir', side_effect=lambda path: [str(p.pid) for p in self.children] + [str(pid) for pid in self.subject_pids])
        self.proc_listing.start()

    def tearDown(self):
        # A confirmed close can RAISE, and teardown must still finish. Letting the
        # TimeoutError propagate from inside the loop skipped every remaining handle,
        # every child kill and the tmpdir cleanup -- so the one failure mode this
        # helper exists to report would leak the children it exists to reap. Collect
        # and re-raise after cleanup: still loud, no longer leaky.
        failures = []
        for fd in self.handles:
            try:
                terminate_and_close_pidfd(fd)
            except Exception as e:
                failures.append(e)
        for child in self.children:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=3)
        self.proc_listing.stop()
        self.tmp.cleanup()
        if failures:
            raise failures[0]

    def launch(self, argv, **kwargs):
        p = subprocess.Popen(argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **kwargs)
        self.children.append(p)
        return p

    def wait_file(self, name):
        file = self.root / name
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            if file.exists() and file.read_text():
                return file.read_text()
            time.sleep(.01)
        self.fail('child did not publish readiness')

    def owner(self):
        code = "import os,time; from pathlib import Path; Path('owner-child').write_text(str(os.getpid())); Path('claim').write_text(os.environ['NEUTRON_LANE_CLAIM']); time.sleep(60)"
        p = self.launch([sys.executable, str(Path(lanes.__file__).resolve()), 'run', '--', sys.executable, '-c', code], cwd=self.root)
        c = json.loads(self.wait_file('claim'))
        self.handles.append(os.pidfd_open(int(self.wait_file('owner-child'))))
        return p, c

    def child(self, claim=None, cwd=None, cooperative=False):
        # The broker (this test process) creates the child, exactly as the socket
        # server does. It is NOT a descendant of the lane owner and has no registry.
        env = dict(os.environ)
        env.pop(lanes.CLAIM, None)
        if claim:
            env[lanes.CLAIM] = json.dumps(claim)
        ready = self.root / ('ready-' + str(len(self.children)))
        code = "import os,signal,time; from pathlib import Path; signal.signal(signal.SIGTERM,signal.SIG_IGN); Path(os.environ['READY']).write_text(str(os.getpid())); time.sleep(60)"
        if cooperative:
            code = code.replace('signal.SIG_IGN', "lambda *_: (Path(os.environ['READY'] + '.term').write_text('TERM'), sys.exit(0))").replace('import os,signal,time;', 'import os,signal,time,sys;')
        p = self.launch([sys.executable, '-c', code], env=dict(env, READY=str(ready)), cwd=cwd)
        self.wait_file(ready.name)
        fd = os.pidfd_open(p.pid)
        self.handles.append(fd)
        return p, fd

    def assert_survives(self, child, fd, phase, reports):
        exited = bool(select.select([fd], [], [], 0)[0])
        # A readable pidfd establishes exit, so wait can collect the actual status
        # before teardown sends any signal of its own. Negative means a signal.
        status = child.wait() if exited else child.poll()
        self.assertFalse(exited, f'{phase}: pid={child.pid}, wait_status={status}, sweeps={reports}')

    def test_survival_diagnostic_records_phase_and_wait_status(self):
        for phase, code in [('first sweep: existing root', 0), ('second sweep: unrelated repo', -signal.SIGKILL)]:
            with self.subTest(phase=phase):
                if code == 0:
                    child = self.launch([sys.executable, '-c', 'pass'])
                    fd = os.pidfd_open(child.pid)
                    self.handles.append(fd)
                else:
                    child, fd = self.child()
                    signal.pidfd_send_signal(fd, signal.SIGKILL)
                child.wait()
                with self.assertRaises(AssertionError) as failure:
                    self.assert_survives(child, fd, phase, {'first': {'reaped': [child.pid]}})
                message = str(failure.exception)
                self.assertIn(phase, message)
                self.assertIn(f'wait_status={code}', message)
                self.assertIn(f"'reaped': [{child.pid}]", message)

    def test_global_sweep_reaps_dead_claim_but_preserves_unclaimed_removed_root(self):
        root = self.root / '.claude/worktrees/wf_unclaimed'
        root.mkdir(parents=True)
        unclaimed, fd = self.child(cwd=root)
        root.rmdir()
        self.assertIsNone(lanes.environment_claim(unclaimed.pid))
        # Prove the fallback would apply if this repository were configured.
        self.assertTrue(lanes.deleted_root(unclaimed.pid, [str(self.root)], []))
        claim = {'id': 'c' * 32, 'pid': os.getpid(), 'start': lanes.birth(os.getpid())[0], 'boot': 'previous-boot'}
        claimed, claimedfd = self.child(claim)
        report = lanes.sweep(grace=.02)
        self.assertIn(claimed.pid, report['reaped'])
        self.assertTrue(select.select([claimedfd], [], [], 0)[0])
        self.assertNotIn(unclaimed.pid, report['reaped'])
        self.assert_survives(unclaimed, fd, 'global sweep without repositories', report)

    def test_dead_lane_socket_child_reaped_live_lane_survives(self):
        owner, c = self.owner()
        dead, deadfd = self.child(c)
        other = dict(c, id='a' * 32, pid=os.getpid(), start=lanes.birth(os.getpid())[0])
        live, livefd = self.child(other)
        owner.kill()
        owner.wait()
        report = lanes.sweep(grace=.02)
        self.assertIn(dead.pid, report['reaped'])
        self.assertTrue(select.select([deadfd], [], [], 0)[0])
        self.assertFalse(select.select([livefd], [], [], 0)[0])
        self.assertNotIn(live.pid, report['reaped'])

    def test_term_is_delivered_before_escalation(self):
        owner, c = self.owner()
        p, fd = self.child(c, cooperative=True)
        owner.kill()
        owner.wait()
        lanes.sweep(grace=.2)
        self.assertTrue(list(self.root.glob('*.term')))
        self.assertTrue(select.select([fd], [], [], 0)[0])

    def test_live_owner_and_unknown_are_preserved(self):
        owner, c = self.owner()
        p, fd = self.child(c)
        self.assertEqual(lanes.owner_state(c), 'live')
        lanes.sweep(grace=.02)
        self.assertFalse(select.select([fd], [], [], 0)[0])
        with patch.object(lanes, 'birth', side_effect=PermissionError()):
            self.assertEqual(lanes.owner_state(c), 'unknown')
            report = lanes.sweep(grace=.02)
        self.assertGreater(report['unknown'], 0)
        self.assertFalse(select.select([fd], [], [], 0)[0])

    def test_finished_claim_cannot_revoke_other_session(self):
        owner, c = self.owner()
        p, fd = self.child(c)
        other = dict(c, id='b' * 32)
        stranger, strangerfd = self.child(other)
        lanes.sweep(finished=c, grace=.02)
        self.assertTrue(select.select([fd], [], [], 0)[0])
        self.assertFalse(select.select([strangerfd], [], [], 0)[0])

    def test_deleted_worktree_root_only(self):
        repo = self.root / 'repo'
        root = repo / '.claude/worktrees/wf_dead'
        root.mkdir(parents=True)
        live_root = repo / '.claude/worktrees/wf_live'
        live_root.mkdir()
        live, livefd = self.child(cwd=live_root)
        dead, deadfd = self.child(cwd=root)
        root.rmdir()
        # An absent root protected by a live store row is still untouchable.
        lanes.sweep([str(repo)], [str(root)], grace=.02)
        self.assertFalse(select.select([deadfd], [], [], 0)[0])
        lanes.sweep([str(repo)], grace=.02)
        self.assertTrue(select.select([deadfd], [], [], 0)[0])
        self.assertFalse(select.select([livefd], [], [], 0)[0])

    def test_deleted_subdirectory_and_unrelated_repo_survive(self):
        root = self.root / '.claude/worktrees/wf_live'
        sub = root / 'sub'
        sub.mkdir(parents=True)
        p, fd = self.child(cwd=sub)
        sub.rmdir()
        self.assertIsNone(lanes.environment_claim(p.pid))
        reports = {'first': lanes.sweep([str(self.root)], grace=.02)}
        self.assert_survives(p, fd, 'first sweep: existing root', reports)
        root.rmdir()
        # THE NEAR MISS HAS TO ACTUALLY MISS (#739). This was written as
        # `str(self.root)[:-1] + 'x'` -- the root with its last character REPLACED by
        # 'x'. mkdtemp draws its suffix from 37 characters and 'x' is one of them, so
        # one run in 37 produced the root ITSELF: the sweep was handed the real
        # repository, whose wf_ root this test has just removed, and correctly reaped
        # the child. Two CI runs died that way and the assertion could only say the
        # process had exited. Appending cannot collide -- a strict extension of a path
        # is never that path -- and the inequality is asserted rather than reasoned
        # about, so a future rewrite of this line cannot quietly reintroduce it.
        unrelated = str(self.root) + 'x'
        self.assertNotEqual(unrelated, str(self.root))
        # …and say WHY the child survives this sweep, rather than only that it did.
        # The removed root makes it eligible for its OWN repository -- proved on the
        # line below -- so the survival is the prefix mismatch doing its job and
        # nothing else. A survival with no stated cause is what let the collision
        # read as a flake for two CI runs.
        self.assertFalse(lanes.deleted_root(p.pid, [unrelated], []))
        self.assertTrue(lanes.deleted_root(p.pid, [str(self.root)], []))
        reports['second'] = lanes.sweep([unrelated], grace=.02)
        self.assert_survives(p, fd, 'second sweep: unrelated repo', reports)

    def test_recreated_root_and_unknown_root_survive(self):
        root = self.root / '.claude/worktrees/wf_recreated'
        root.mkdir(parents=True)
        p, fd = self.child(cwd=root)
        root.rmdir()
        root.mkdir()
        self.assertFalse(lanes.deleted_root(p.pid, [str(self.root)], []))
        original_stat = lanes.os.stat
        def unreadable_root(path, *args, **kwargs):
            if str(path) == str(root):
                raise PermissionError()
            return original_stat(path, *args, **kwargs)
        with patch.object(lanes.os, 'stat', side_effect=unreadable_root):
            with self.assertRaises(PermissionError):
                lanes.deleted_root(p.pid, [str(self.root)], [])
            report = lanes.sweep([str(self.root)], grace=.02)
            self.assertGreater(report['unknown'], 0)
        lanes.sweep([str(self.root)], grace=.02)
        self.assertFalse(select.select([fd], [], [], 0)[0])

    def test_pid_reuse_does_not_signal_successor(self):
        owner, c = self.owner()
        p, fd = self.child(c)
        # Model exit/reuse between pidfd_open and environ: the original handle is
        # readable, but /proc has a successor's eligible data. No signal may fire.
        with patch.object(lanes, 'owner_state', return_value='dead'), patch.object(lanes.select, 'select', side_effect=lambda f, *a: (f, [], [])), patch.object(lanes.signal, 'pidfd_send_signal') as send:
            lanes.sweep(grace=0)
        send.assert_not_called()
        self.assertFalse(select.select([fd], [], [], 0)[0])

    def test_pidfd_teardown_confirms_exit_before_close(self):
        fd = 73
        calls = []
        with patch.object(signal, 'pidfd_send_signal', side_effect=lambda *args: calls.append(('signal', args))), \
                patch.object(select, 'select', side_effect=lambda *args: (calls.append(('select', args)) or ([fd], [], []))), \
                patch.object(os, 'close', side_effect=lambda arg: calls.append(('close', (arg,)))):
            terminate_and_close_pidfd(fd)
        self.assertEqual([kind for kind, _ in calls], ['signal', 'select', 'close'])
        self.assertEqual(calls[1][1], ([fd], [], [], 3))

    def test_birth_and_boot_reuse_are_dead_not_identity(self):
        _, c = self.owner()
        self.assertEqual(lanes.owner_state(dict(c, start='0')), 'dead')
        self.assertEqual(lanes.owner_state(dict(c, boot='old-boot')), 'dead')
        with patch.object(lanes, 'boot', side_effect=FileNotFoundError()):
            self.assertEqual(lanes.owner_state(c), 'unknown')
        with patch.object(lanes, 'birth', side_effect=FileNotFoundError()):
            self.assertEqual(lanes.owner_state(c), 'dead')
        with patch.object(lanes, 'birth', return_value=(c['start'], 'Z')):
            self.assertEqual(lanes.owner_state(c), 'dead')

    def test_malformed_claim_and_foreign_uid_refuse(self):
        root = self.root / '.claude/worktrees/wf_unknown'
        root.mkdir(parents=True)
        p, fd = self.child({'id': 'broken'}, cwd=root)
        root.rmdir()
        report = lanes.sweep([str(self.root)], grace=.02)
        self.assertGreater(report['unknown'], 0)
        self.assertFalse(select.select([fd], [], [], 0)[0])
        original_stat = lanes.os.stat
        def foreign(path, *args, **kwargs):
            if str(path) == f'/proc/{p.pid}':
                from types import SimpleNamespace
                return SimpleNamespace(st_uid=os.getuid() + 1)
            return original_stat(path, *args, **kwargs)
        with patch.object(lanes.os, 'stat', side_effect=foreign), patch.object(lanes, 'environment_claim', return_value=None):
            lanes.sweep([str(self.root)], grace=.02)
        self.assertFalse(select.select([fd], [], [], 0)[0])

    def test_claim_schema_refuses_unusable_identity_and_liveness(self):
        valid = {'id': 'a' * 32, 'pid': 2, 'start': '12', 'boot': 'boot-proof'}
        self.assertEqual(lanes.parse_claim(json.dumps(valid)), valid)
        for field, value in [('id', 'broken'), ('pid', 0), ('pid', True), ('start', 'invalid'), ('boot', '')]:
            self.assertIsNone(lanes.parse_claim(json.dumps(dict(valid, **{field: value}))))
        self.assertIsNone(lanes.parse_claim('{}'))
        self.assertIsNone(lanes.parse_claim('invalid'))

    def test_self_and_nonprocess_entries_are_not_targets(self):
        c = {'id': 'a' * 32, 'pid': 2, 'start': '0', 'boot': 'old'}
        with patch.object(lanes.os, 'listdir', return_value=[str(os.getpid())]), patch.object(lanes, 'environment_claim', return_value=c), patch.object(lanes, 'owner_state', return_value='dead'), patch.object(lanes.signal, 'pidfd_send_signal') as send:
            lanes.sweep(grace=0)
        send.assert_not_called()
        with patch.object(lanes.os, 'listdir', return_value=['self']):
            lanes.sweep(grace=0)

    def test_missing_kernel_support_refuses_before_launch(self):
        with patch.object(sys, 'argv', ['lane-processes.py', 'run', '--', 'false']), patch.object(lanes.os, 'pidfd_open', side_effect=OSError()), patch.object(lanes, 'run', return_value=0) as launch:
            self.assertEqual(lanes.main(), 3)
        launch.assert_not_called()

    def test_deleted_suffix_can_be_a_live_directory_name(self):
        root = self.root / '.claude/worktrees/wf_live (deleted)'
        root.mkdir(parents=True)
        p, fd = self.child(cwd=root)
        lanes.sweep([str(self.root)], grace=.02)
        self.assertFalse(select.select([fd], [], [], 0)[0])

    def test_unmanaged_directory_is_not_a_lane(self):
        root = self.root / '.claude/worktrees/personal'
        root.mkdir(parents=True)
        p, fd = self.child(cwd=root)
        root.rmdir()
        lanes.sweep([str(self.root)], grace=.02)
        self.assertFalse(select.select([fd], [], [], 0)[0])

    def test_killed_build_leaks_real_grandchild_then_sweep_reaps_it(self):
        code = "import os,subprocess,sys,time; from pathlib import Path; Path('launcher').write_text(str(os.getpid())); subprocess.Popen([sys.executable,'-c',\"import os,signal,time; from pathlib import Path; signal.signal(signal.SIGTERM,signal.SIG_IGN); Path('escaped').write_text(str(os.getpid())); time.sleep(60)\"]); time.sleep(60)"
        owner = self.launch([sys.executable, str(Path(lanes.__file__).resolve()), 'run', '--', sys.executable, '-c', code], cwd=self.root)
        child = int(self.wait_file('escaped'))
        launcher = int(self.wait_file('launcher'))
        for pid in [child, launcher]:
            self.subject_pids.append(pid)
            self.handles.append(os.pidfd_open(pid))
        fd = self.handles[-2]
        owner.kill()
        owner.wait()
        self.assertFalse(select.select([fd], [], [], 0)[0])
        report = lanes.sweep(grace=.02)
        self.assertIn(child, report['reaped'])
        self.assertIn(launcher, report['reaped'])
        self.assertTrue(select.select([fd], [], [], 0)[0])

    def test_normal_wrapper_exit_reaps_descendant(self):
        # The real run path must finish cleanup, including a child ignoring TERM.
        code = "import subprocess,sys,time; subprocess.Popen([sys.executable,'-c',\"import os,signal,time; from pathlib import Path; signal.signal(signal.SIGTERM,signal.SIG_IGN); Path('escaped').write_text(str(os.getpid())); time.sleep(60)\"]); time.sleep(.3)"
        p = self.launch([sys.executable, str(Path(lanes.__file__).resolve()), 'run', '--', sys.executable, '-c', code], cwd=self.root)
        pid = int(self.wait_file('escaped'))
        fd = os.pidfd_open(pid)
        self.handles.append(fd)
        self.assertEqual(p.wait(timeout=5), 0)
        self.assertTrue(select.select([fd], [], [], 0)[0])

    def test_run_preserves_natural_exit_and_restores_signal_handlers(self):
        handlers = {s: signal.getsignal(s) for s in (signal.SIGTERM, signal.SIGINT)}
        for code in (0, 7):
            with self.subTest(code=code):
                self.assertEqual(lanes.run([sys.executable, '-c', f'raise SystemExit({code})']), code)
                self.assertEqual({s: signal.getsignal(s) for s in handlers}, handlers)

    def test_owner_term_confirms_child_exit_before_returning(self):
        owner, _ = self.owner()
        childfd = self.handles[-1]
        owner.terminate()
        self.assertEqual(owner.wait(timeout=5), 143)
        self.assertTrue(select.select([childfd], [], [], 0)[0])

    def test_unconfirmed_cleanup_never_returns_success(self):
        # Inject only cleanup observations, never a widened real process census.
        for child_live, survived in ((False, [123]), (True, [])):
            with self.subTest(child_live=child_live, survived=survived):
                child = Mock(returncode=0)
                child.poll.return_value = None if child_live else 0
                def launch(*_args, **_kwargs):
                    signal.raise_signal(signal.SIGTERM)
                    return child
                stderr = io.StringIO()
                with patch.object(lanes.subprocess, 'Popen', side_effect=launch), \
                        patch.object(lanes, 'sweep', return_value={'reaped': [], 'survived': survived}), \
                        patch.object(sys, 'stderr', stderr):
                    self.assertEqual(lanes.run(['fixture-only']), 143)
                self.assertIn('LANE_PROCESS_CLEANUP_UNCONFIRMED', stderr.getvalue())

    def test_term_spawned_detached_descendant_is_reaped_and_sibling_survives(self):
        late_code = "import os,signal,time; from pathlib import Path; signal.signal(signal.SIGTERM,signal.SIG_IGN); Path('late').write_text(str(os.getpid())); time.sleep(30)"
        code = "import signal,subprocess,sys,time; from pathlib import Path\ndef stop(*_):\n subprocess.Popen([sys.executable,'-c'," + repr(late_code) + "], start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\n sys.exit(0)\nsignal.signal(signal.SIGTERM,stop)\nPath('ready').write_text('yes')\ntime.sleep(30)"
        owner = self.launch([sys.executable, str(Path(lanes.__file__).resolve()), 'run', '--', sys.executable, '-c', code], cwd=self.root)
        self.wait_file('ready')
        sibling, siblingfd = self.child()
        owner.terminate()
        latefd = os.pidfd_open(int(self.wait_file('late')))
        self.handles.append(latefd)
        status = owner.wait(timeout=5)
        self.assertTrue(select.select([latefd], [], [], 0)[0])
        self.assertEqual(status, 143)
        self.assert_survives(sibling, siblingfd, 'late-descendant cleanup', {})

    def test_cleanup_requires_known_empty_census_with_bounded_rescans(self):
        child = Mock(returncode=0)
        child.poll.return_value = 0
        def launch(*_args, **_kwargs):
            signal.raise_signal(signal.SIGTERM)
            return child
        for report, expected_calls in (({'reaped': [123], 'survived': [], 'unknown': 0}, 4),
                                       ({'reaped': [], 'survived': [], 'unknown': 1}, 4)):
            with self.subTest(report=report), patch.object(lanes.subprocess, 'Popen', side_effect=launch), \
                    patch.object(lanes, 'sweep', return_value=report) as sweep, \
                    patch.object(sys, 'stderr', io.StringIO()) as stderr:
                self.assertEqual(lanes.run(['fixture-only']), 143)
                self.assertEqual(sweep.call_count, expected_calls)
                self.assertIn('LANE_PROCESS_CLEANUP_UNCONFIRMED', stderr.getvalue())

    def test_foreground_exit_and_cleanup_unknown_are_independent(self):
        for code in (0, 7):
            report = self.root / f'cleanup-{code}.json'
            child = Mock(returncode=code)
            child.poll.return_value = code
            with self.subTest(code=code), patch.object(lanes.subprocess, 'Popen', return_value=child), \
                    patch.object(lanes, 'sweep', return_value={'reaped': [], 'survived': [], 'unknown': 1}), \
                    patch.object(sys, 'stderr', io.StringIO()) as stderr:
                self.assertEqual(lanes.run(['fixture-only'], report, 'request'), code)
                self.assertEqual(stderr.getvalue(), '')
                observed = json.loads(report.read_text())
                self.assertEqual(observed['status'], 'unknown')
                self.assertEqual(observed['foreground_exit'], code)
                self.assertEqual(observed['exit_code'], code)
                self.assertEqual(observed['token'], 'request')
                self.assertEqual(observed['owner_pid'], os.getpid())
                self.assertIsNone(observed['signal'])

    def test_no_report_shell_caller_retains_exact_primary_stderr(self):
        child = Mock(returncode=3)
        child.poll.return_value = 3
        def launch(*_args, **_kwargs):
            print('EXACT_REFUSAL', file=sys.stderr)
            return child
        with patch.object(lanes.subprocess, 'Popen', side_effect=launch), \
                patch.object(lanes, 'sweep', return_value={'reaped': [], 'survived': [], 'unknown': 1}), \
                patch.object(sys, 'stderr', io.StringIO()) as stderr:
            self.assertEqual(lanes.run(['fixture-only']), 3)
            self.assertEqual(stderr.getvalue(), 'EXACT_REFUSAL\n')

    def test_owner_preserves_each_signal_and_reports_unknown_closure(self):
        for signum in (signal.SIGTERM, signal.SIGINT):
            report = self.root / f'signal-{signum}.json'
            child = Mock(returncode=0)
            child.poll.return_value = 0
            def launch(*_args, **_kwargs):
                signal.raise_signal(signum)
                return child
            with self.subTest(signum=signum), patch.object(lanes.subprocess, 'Popen', side_effect=launch), \
                    patch.object(lanes, 'sweep', return_value={'reaped': [], 'survived': [], 'unknown': 1}), \
                    patch.object(sys, 'stderr', io.StringIO()) as stderr:
                self.assertEqual(lanes.run(['fixture-only'], report, 'request'), 128 + signum)
                self.assertIn('LANE_PROCESS_CLEANUP_UNCONFIRMED', stderr.getvalue())
                observed = json.loads(report.read_text())
                self.assertEqual(observed['status'], 'unknown')
                self.assertEqual(observed['signal'], signum)
                self.assertEqual(observed['exit_code'], 128 + signum)

    def test_inherited_ignored_int_remains_ignored(self):
        previous = signal.signal(signal.SIGINT, signal.SIG_IGN)
        child = Mock(returncode=0)
        child.poll.return_value = 0
        def launch(*_args, **_kwargs):
            self.assertEqual(signal.getsignal(signal.SIGINT), signal.SIG_IGN)
            signal.raise_signal(signal.SIGINT)
            return child
        try:
            with patch.object(lanes.subprocess, 'Popen', side_effect=launch), \
                    patch.object(lanes, 'sweep', return_value={'reaped': [], 'survived': [], 'unknown': 0}):
                self.assertEqual(lanes.run(['fixture-only']), 0)
                self.assertEqual(signal.getsignal(signal.SIGINT), signal.SIG_IGN)
        finally:
            signal.signal(signal.SIGINT, previous)

    def test_cancellation_during_normal_cleanup_requires_known_empty(self):
        child = Mock(returncode=0)
        child.poll.return_value = 0
        def sweep(**_kwargs):
            signal.raise_signal(signal.SIGTERM)
            return {'reaped': [], 'survived': [], 'unknown': 1}
        with patch.object(lanes.subprocess, 'Popen', return_value=child), \
                patch.object(lanes, 'sweep', side_effect=sweep), \
                patch.object(sys, 'stderr', io.StringIO()) as stderr:
            self.assertEqual(lanes.run(['fixture-only']), 143)
            self.assertIn('LANE_PROCESS_CLEANUP_UNCONFIRMED', stderr.getvalue())

    def test_unknown_census_does_not_skip_later_owned_descendant_cleanup(self):
        child = Mock(returncode=0)
        child.poll.return_value = 0
        reports = [{'reaped': [123], 'survived': [], 'unknown': 1},
                   {'reaped': [456], 'survived': [], 'unknown': 1},
                   {'reaped': [], 'survived': [], 'unknown': 0}]
        with patch.object(lanes.subprocess, 'Popen', return_value=child), \
                patch.object(lanes, 'sweep', side_effect=reports) as sweep, \
                patch.object(sys, 'stderr', io.StringIO()):
            self.assertEqual(lanes.run(['fixture-only']), 0)
            self.assertEqual(sweep.call_count, 3)

    def test_exited_handle_is_resolved_but_live_unreadable_claim_is_unknown(self):
        child, fd = self.child()
        with patch.object(lanes, 'environment_claim', side_effect=FileNotFoundError()):
            self.assertGreater(lanes.sweep()['unknown'], 0)
        with patch.object(lanes, 'environment_claim', side_effect=PermissionError()):
            self.assertGreater(lanes.sweep()['unknown'], 0)
            child.kill()
            self.assertTrue(select.select([fd], [], [], 3)[0])
            self.assertEqual(lanes.sweep()['unknown'], 0)


class Census(unittest.TestCase):
    setUp = LaneProcesses.setUp
    tearDown = LaneProcesses.tearDown
    launch = LaneProcesses.launch
    wait_file = LaneProcesses.wait_file

    def claimed(self, claim_id='a' * 32):
        claim = {'id': claim_id, 'pid': os.getpid(), 'start': lanes.birth(os.getpid())[0], 'boot': lanes.boot()}
        marker = f'ready-{len(self.children)}'
        child = self.launch([sys.executable, '-c', f"from pathlib import Path; import time; Path({marker!r}).write_text('ready'); time.sleep(60)"],
                            cwd=self.root, env=dict(os.environ, NEUTRON_LANE_CLAIM=json.dumps(claim),
                            NEUTRON_CODEX_BUILD_CHECKPOINT_RUN_ID='run-proof'))
        self.wait_file(marker)
        return child

    def test_census_live_then_dead(self):
        children = [self.claimed(c * 32) for c in 'abcd']
        report = lanes.census()
        self.assertEqual(report['status'], 'known')
        self.assertEqual(len(report['lanes']), 4)
        self.assertEqual({p['pid'] for lane in report['lanes'] for p in lane['processes']}, {p.pid for p in children})
        self.assertTrue(all(lane['run_id'] == 'run-proof' for lane in report['lanes']))
        self.assertTrue(all(0 < lane['processes'][0]['started_at'] <= time.time() for lane in report['lanes']))
        for p in children:
            p.kill()
            p.wait()
        self.assertEqual(lanes.census()['lanes'], [])
        self.assertEqual(lanes.census()['status'], 'known')

    def test_census_groups_descendants_but_keeps_process_inventory(self):
        self.claimed()
        self.claimed()
        report = lanes.census()
        self.assertEqual(len(report['lanes']), 1)
        self.assertEqual(len(report['lanes'][0]['processes']), 2)

    def test_census_dead_owner_does_not_hide_live_child(self):
        self.claimed()
        with patch.object(lanes, 'owner_state', return_value='dead'):
            report = lanes.census()
        self.assertEqual(len(report['lanes']), 1)
        self.assertEqual(report['lanes'][0]['owner'], 'dead')

    def test_census_unknown_is_not_empty(self):
        self.claimed()
        with patch.object(lanes, 'environment_claim', side_effect=PermissionError()):
            self.assertEqual(lanes.census()['status'], 'unknown')
        with patch.object(lanes.os, 'listdir', side_effect=PermissionError()):
            self.assertEqual(lanes.census()['status'], 'unknown')
        self.assertEqual(lanes.census()['status'], 'known')

    def test_census_checks_handle_after_reads(self):
        child = self.claimed()
        claim = lanes.environment_claim(child.pid)
        def exit_during_read(pid):
            child.kill()
            child.wait()
            return claim
        # Keep the later metadata reads reachable after death to isolate the
        # final pidfd guard (rather than stopping at an earlier ENOENT).
        with patch.object(lanes, 'environment_claim', side_effect=exit_during_read), \
             patch.object(lanes.Path, 'read_bytes', return_value=b''), \
             patch.object(lanes.os, 'readlink', return_value='/tmp/build'):
            self.assertEqual(lanes.census()['lanes'], [])

    def test_census_rejects_zombie_and_unrelated_process(self):
        self.claimed()
        with patch.object(lanes, 'birth', return_value=('1', 'Z')):
            self.assertEqual(lanes.census()['lanes'], [])
        with patch.object(lanes, 'environment_claim', return_value=None):
            self.assertEqual(lanes.census()['lanes'], [])

    def test_census_unclaimed_wrapper(self):
        script = self.root / 'codex-build.sh'
        script.write_text('read -t 60 value\n')
        child = self.launch(['bash', str(script)], env={}, stdin=subprocess.PIPE)
        # Wait for exec; a newborn child can still have its parent's argv.
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            report = lanes.census()
            if report['lanes']:
                break
            time.sleep(.01)
        self.assertEqual(report['lanes'][0]['processes'][0]['pid'], child.pid)
        self.assertEqual(report['lanes'][0]['owner'], 'unknown')


if __name__ == '__main__':
    unittest.main()
