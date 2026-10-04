"""Test-only PID namespace boundary, independent of process-owner code under test.

Every exec and descendant inherits the kernel boundary. A private proc mount
keeps real proc metadata and pidfds usable without exposing the caller's process
table. Missing namespace support is a failed test, never a host-process fallback.
"""

from contextlib import ExitStack
import ctypes
import fcntl
from functools import partial
import os
from pathlib import Path
import signal
import socket
import struct
import subprocess
import sys


SCRIPT = str(Path(__file__).resolve())
REFUSAL = 'Process test isolation refused: private PID and proc namespaces required'
NAMESPACE_TYPES = {'pid': 0x20000000, 'mnt': 0x00020000}
NS_GET_NSTYPE = 0xb703  # linux/nsfs.h: _IO(0xb7, 0x3)
HELLO = b'process-test-init'
APPROVED = b'private-namespace-verified'
PR_SET_PDEATHSIG = 1
_prctl = ctypes.CDLL(None, use_errno=True).prctl
_prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
_prctl.restype = ctypes.c_int


def bind_to_parent(expected_pid):
    """Bind lifetime in the kernel, refusing either side of the setup race."""
    if expected_pid <= 1 or os.getppid() != expected_pid:
        raise RuntimeError('Process test launcher parent changed before lifetime binding')
    if _prctl(PR_SET_PDEATHSIG, signal.SIGKILL, 0, 0, 0) != 0:
        raise RuntimeError('Process test launcher could not bind parent lifetime')
    # Parent death before prctl does not retroactively deliver a signal. Recheck
    # after arming; death after arming is handled even on default exit or SIGKILL.
    if os.getppid() != expected_pid:
        raise RuntimeError('Process test launcher parent changed during lifetime binding')


def namespace_identity(path, name):
    """Only an actual namespace handle, not argv text or an ordinary file."""
    fd = os.open(path, os.O_RDONLY)
    try:
        if fcntl.ioctl(fd, NS_GET_NSTYPE) != NAMESPACE_TYPES[name]:
            raise RuntimeError(REFUSAL)
        value = os.fstat(fd)
        return value.st_dev, value.st_ino
    finally:
        os.close(fd)


def require_boundary():
    """Validate kernel evidence, not an environment variable claiming isolation."""
    try:
        init = Path('/proc/1/cmdline').read_bytes().decode().rstrip('\0').split('\0')
        # The namespace init remains this supervisor while the tests execute.
        if len(init) < 9 or init[1:4] != ['-B', SCRIPT, '--inside'] or init[7] != '--':
            raise ValueError('namespace init is not the test supervisor')
        descriptors = [int(value) for value in init[4:7]]
        if any(fd < 3 for fd in descriptors) or len(set(descriptors)) != 3:
            raise ValueError('invalid bootstrap handles')
        for name, fd in zip(('pid', 'mnt'), descriptors[1:]):
            current = namespace_identity('/proc/self/ns/' + name, name)
            previous = namespace_identity(f'/proc/1/fd/{fd}', name)
            if current == previous:
                raise ValueError('namespace was not replaced')
        if os.readlink('/proc/self') != str(os.getpid()):
            raise ValueError('proc mount belongs to another PID namespace')
        if namespace_identity('/proc/1/ns/pid', 'pid') != namespace_identity('/proc/self/ns/pid', 'pid'):
            raise ValueError('namespace init is outside this PID namespace')
    except (OSError, ValueError, UnicodeError) as error:
        raise RuntimeError(REFUSAL) from error


def authorize_init(channel, child, previous):
    """The outer launcher verifies the actual sender using kernel credentials."""
    packet, ancillary, flags, _address = channel.recvmsg(64, socket.CMSG_SPACE(12))
    credentials = [data for level, kind, data in ancillary
                   if level == socket.SOL_SOCKET and kind == socket.SCM_CREDENTIALS]
    if packet != HELLO or flags or len(credentials) != 1 or len(credentials[0]) != 12:
        raise RuntimeError(REFUSAL)
    pid, uid, _gid = struct.unpack('3i', credentials[0])
    if pid <= 1 or uid != os.getuid():
        raise RuntimeError(REFUSAL)
    status = Path(f'/proc/{pid}/status').read_text().splitlines()
    if next((line.split()[1] for line in status if line.startswith('PPid:')), None) != str(child.pid):
        raise RuntimeError(REFUSAL)
    for name, baseline in zip(('pid', 'mnt'), previous):
        if namespace_identity(f'/proc/{pid}/ns/{name}', name) == baseline:
            raise RuntimeError(REFUSAL)
    channel.sendall(APPROVED)


def obtain_authorization(fd):
    with socket.socket(fileno=fd) as channel:
        channel.settimeout(5)
        peer_pid, peer_uid, _gid = struct.unpack('3i', channel.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        # The creator must be outside this PID namespace. A socketpair created
        # by an existing PID 1 reports PID 1, so forged --inside arguments fail.
        if peer_pid != 0 or peer_uid != os.getuid():
            raise RuntimeError(REFUSAL)
        channel.sendall(HELLO)
        if channel.recv(64) != APPROVED:
            raise RuntimeError(REFUSAL)


def enter(command, parent_pid=None):
    if not command:
        raise ValueError('an isolated test command is required')
    # The Bun caller supplies its PID before spawning us. Direct Python test
    # entry also refuses an already-orphaned launcher rather than binding PID 1.
    bind_to_parent(os.getppid() if parent_pid is None else parent_pid)
    with ExitStack() as cleanup:
        handles = []
        for name in ('pid', 'mnt'):
            fd = os.open('/proc/self/ns/' + name, os.O_RDONLY)
            cleanup.callback(os.close, fd)
            handles.append(fd)
        previous = [namespace_identity(f'/proc/self/fd/{fd}', name)
                    for name, fd in zip(('pid', 'mnt'), handles)]
        outer, inner = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        cleanup.enter_context(outer)
        cleanup.enter_context(inner)
        outer.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
        outer.settimeout(5)
        inherited = (inner.fileno(), *handles)
        # The invoking host's operator authority belongs to its live instance.
        # Quota registration also belongs to the live instance, not fake test
        # children. Explicit signed relay fixtures provide their own pin/socket.
        # Mask only these directories in this private mount namespace. Do not ask
        # bwrap to create missing parents through the host's bind-mounted root.
        authority_roots = ['/etc/neutron/native-host-recovery', '/etc/neutron/claude-capacity']
        authority_mounts = [arg for root in authority_roots if os.path.isdir(root)
                            for arg in ('--tmpfs', root)]
        argv = ['bwrap', '--unshare-user', '--uid', str(os.getuid()), '--gid', str(os.getgid()),
                '--unshare-pid', '--as-pid-1', '--die-with-parent', '--bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
                *authority_mounts, sys.executable, '-B', SCRIPT, '--inside', *map(str, inherited), '--', *command]
        # Only bootstrap descriptors cross exec, never an unrelated inherited pidfd.
        child = subprocess.Popen(argv, close_fds=True, pass_fds=inherited,
                                 preexec_fn=partial(bind_to_parent, os.getpid()))
        inner.close()
        try:
            authorize_init(outer, child, previous)
            status = child.wait()
            return status if status >= 0 else 128 - status
        finally:
            # This Popen is solely the launcher we created, never a census target.
            # bwrap then kills its init, whose exit retires the whole namespace.
            if child.poll() is None:
                child.kill()
            child.wait()


def run_as_init(command):
    """Wait for our command and reap its adopted orphans in this private init.

    Called only after main authenticates the freshly created namespace init.
    One waiter owns all child statuses; Popen.poll/wait must not race it.
    """
    if os.getpid() != 1:
        raise RuntimeError(REFUSAL)
    # An inherited ignored disposition auto-reaps children, and an inherited
    # handler could consume their statuses. This fresh authenticated init owns
    # the disposition; neither the caller nor --check reaches this reset.
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)
    child = subprocess.Popen(command, close_fds=True)
    while True:
        pid, status = os.waitpid(-1, 0)
        if pid == child.pid:
            child.returncode = os.waitstatus_to_exitcode(status)
            # Do not wait for still-live orphans. Init exit retires the namespace.
            return child.returncode if child.returncode >= 0 else 128 - child.returncode


def main(args):
    if args == ['--check']:
        require_boundary()
        return 0
    if args[:1] == ['--inside']:
        if len(args) < 6 or args[4] != '--' or os.getpid() != 1:
            raise RuntimeError(REFUSAL)
        require_boundary()
        obtain_authorization(int(args[1]))
        # The init supervisor stays alive until the tested command returns.
        # No mutable process-owner module is imported before this boundary.
        return run_as_init(args[5:])
    parent_pid = None
    if args[:1] == ['--parent-pid']:
        if len(args) < 4:
            raise ValueError('parent PID and isolated command are required')
        parent_pid = int(args[1])
        args = args[2:]
    if args[:1] != ['--']:
        raise ValueError('usage: process-test-isolation.py [--parent-pid PID] -- COMMAND [ARG ...]')
    return enter(args[1:], parent_pid)


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except (OSError, RuntimeError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(3)
