"""Canonical credential-free Codex process classifier, shared by every observer.

The caller must establish a complete proc view. This module never opens auth
files, creates account directories, or controls any observed process.
"""
import hashlib
import os
from pathlib import Path
import pwd
import re
import stat
import time

PF_KTHREAD = 0x00200000
MAX_PROCESSES = 65536
MAX_DURATION_MS = 2000
MAX_CONSUMERS = 4096
MAX_PROC_BYTES = 1048576


class ObservationUnknown(ValueError):
    def __init__(self, reason='incomplete'):
        self.reason = reason if reason in ('peer', 'request', 'incomplete', 'changed', 'budget', 'unavailable') else 'incomplete'
        super().__init__(self.reason)


def read_bounded(path):
    with path.open('rb') as handle:
        value = handle.read(MAX_PROC_BYTES + 1)
    if len(value) > MAX_PROC_BYTES:
        raise ObservationUnknown('budget')
    return value


def process_identity(path):
    data = read_bounded(path / 'stat').decode('utf-8', 'strict')
    pid, opening, rest = data.partition(' (')
    _comm, closing, tail = rest.rpartition(') ')
    fields = tail.split()
    if not opening or not closing or pid != path.name or len(fields) < 20 \
            or fields[0] not in ('R', 'S', 'D', 'T', 't', 'X', 'Z', 'P', 'I') \
            or any(not re.fullmatch(r'[0-9]+', value) for value in (fields[6], fields[19])):
        raise ObservationUnknown('incomplete')
    flags = int(fields[6])
    if flags > 0xffffffff:
        raise ObservationUnknown('incomplete')
    return fields[0], int(fields[19]), flags


def process_uids(path):
    lines = [line for line in read_bounded(path / 'status').splitlines() if line.startswith(b'Uid:')]
    if len(lines) != 1 or not re.fullmatch(rb'Uid:\s+[0-9]+\s+[0-9]+\s+[0-9]+\s+[0-9]+\s*', lines[0]):
        raise ObservationUnknown('incomplete')
    return tuple(int(value) for value in lines[0].split()[1:])


def account_evidence(path, uid):
    path = Path(path)
    if not path.is_absolute():
        raise ObservationUnknown('incomplete')
    canonical = path.resolve(strict=True)
    observed = canonical.stat()
    if not stat.S_ISDIR(observed.st_mode) or observed.st_uid != uid:
        raise ObservationUnknown('incomplete')
    return str(canonical), observed.st_dev, observed.st_ino


def account_identity(path, uid):
    return _account_digest(account_evidence(path, uid))


def _account_digest(evidence):
    _canonical, device, inode = evidence
    # Bind mounts can give one directory object multiple canonical paths.
    # Paths remain observation evidence, but cannot split account exclusion.
    return hashlib.sha256(b'neutron-codex-account-v1\0' + str(device).encode('ascii')
                          + b':' + str(inode).encode('ascii')).hexdigest()


def _exe(path):
    target = os.readlink(path / 'exe')
    observed = (path / 'exe').stat()
    if not stat.S_ISREG(observed.st_mode):
        raise ObservationUnknown('incomplete')
    return target, observed.st_dev, observed.st_ino


def _sudo_reference():
    """Protected canonical system launcher identity, never a name allowlist.

    Optional evidence: without it the ordinary native recognition still applies.
    Walk the literal system path through no-follow directory descriptors so
    symlink hops cannot discard unprotected ancestry before identity is proved.
    """
    descriptors = []
    try:
        canonical = Path('/usr/bin/sudo')
        descriptors.append(os.open('/', os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW))
        evidence = []
        for index, name in enumerate(('', *canonical.parts[1:])):
            if index:
                flags = os.O_PATH | os.O_NOFOLLOW
                if index < len(canonical.parts) - 1:
                    flags |= os.O_DIRECTORY
                descriptors.append(os.open(name, flags, dir_fd=descriptors[-1]))
            observed = os.fstat(descriptors[-1])
            regular = index == len(canonical.parts) - 1
            if observed.st_uid != 0 or observed.st_mode & 0o022 \
                    or not (stat.S_ISREG(observed.st_mode) if regular else stat.S_ISDIR(observed.st_mode)):
                return None
            evidence.append((observed.st_dev, observed.st_ino, observed.st_uid, observed.st_mode,
                             observed.st_size, observed.st_mtime_ns, observed.st_ctime_ns))
        return str(canonical), tuple(evidence)
    except (OSError, ValueError):
        return None
    finally:
        for fd in descriptors:
            os.close(fd)


def _namespace(path):
    return tuple(os.readlink(path / 'ns' / name) for name in ('mnt', 'user', 'pid'))


def _account_in_root(path, candidate, uid):
    """Resolve inside the target root using directory FDs, including symlinks.

    An absolute symlink resets to that root, never the observer's root. This
    permits read-only mount namespaces only when actual account identity agrees.
    """
    descriptors = [os.open(path / 'root', os.O_PATH | os.O_DIRECTORY)]
    parts = []
    pending = list(candidate.parts[1:])
    links = 0
    try:
        root = os.fstat(descriptors[0])
        while pending:
            name = pending.pop(0)
            if name in ('', '.'):
                continue
            if name == '..':
                if parts:
                    parts.pop()
                    os.close(descriptors.pop())
                continue
            observed = os.stat(name, dir_fd=descriptors[-1], follow_symlinks=False)
            if stat.S_ISLNK(observed.st_mode):
                links += 1
                if links > 40:
                    raise ObservationUnknown('incomplete')
                target = os.readlink(name, dir_fd=descriptors[-1])
                if target.startswith('/'):
                    while len(descriptors) > 1:
                        os.close(descriptors.pop())
                    parts = []
                pending = target.split('/') + pending
                continue
            descriptors.append(os.open(name, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW,
                                       dir_fd=descriptors[-1]))
            parts.append(name)
        observed = os.fstat(descriptors[-1])
        if observed.st_uid != uid:
            raise ObservationUnknown('incomplete')
        return (root.st_dev, root.st_ino), ('/' + '/'.join(parts), observed.st_dev, observed.st_ino)
    finally:
        for fd in descriptors:
            os.close(fd)


def _native_home(path, uid, environment):
    values = {}
    for entry in environment.split(b'\0'):
        key, separator, value = entry.partition(b'=')
        if separator and key in (b'CODEX_HOME', b'HOME'):
            if key in values:
                raise ObservationUnknown('incomplete')
            values[key] = os.fsdecode(value)
    nss = None
    value = values.get(b'CODEX_HOME')
    if not value:
        parent = values.get(b'HOME')
        if not parent:
            record = pwd.getpwuid(uid)
            nss = (record.pw_uid, record.pw_dir)
            if record.pw_uid != uid or not record.pw_dir or not Path(record.pw_dir).is_absolute():
                raise ObservationUnknown('incomplete')
            parent = record.pw_dir
        value = str(Path(parent) / '.codex')
    candidate = Path(value)
    cwd = None
    if not candidate.is_absolute():
        cwd = os.readlink(path / 'cwd')
        if not Path(cwd).is_absolute() or cwd.endswith(' (deleted)'):
            raise ObservationUnknown('incomplete')
        candidate = Path(cwd) / candidate
    if len(os.fsencode(candidate)) > 4096:
        raise ObservationUnknown('budget')
    return candidate, cwd, nss


def _inspect(path, uid, proc):
    before = process_identity(path)
    uids = process_uids(path)
    # Membership is credential evidence, including protected tasks whose proc
    # inode becomes root-owned. Even excluded tasks have stable credentials.
    if uid not in uids or before[0] in ('Z', 'X') or before[2] & PF_KTHREAD:
        after = process_identity(path)
        if before[1:] != after[1:] or uids != process_uids(path) \
                or (before[0] in ('Z', 'X') and after[0] not in ('Z', 'X')):
            raise ObservationUnknown('changed')
        return None, (before[1:], uids, 'excluded')
    executable = _exe(path)
    argv = read_bounded(path / 'cmdline')
    args = os.fsdecode(argv).split('\0')
    # Proc retains the regular executable inode after unlink. Preserve the raw
    # target for stability checks; remove its marker only for recognition.
    deleted = executable[0].endswith(' (deleted)')
    executable_name = executable[0][:-10] if deleted else executable[0]
    explicit_native = Path(executable_name).name == 'codex' or Path(args[0]).name in ('codex', 'codex.js')
    native = explicit_native or any(Path(arg).name in ('codex', 'codex.js') for arg in args[1:2])
    launcher = None
    if native and not explicit_native:
        reference = _sudo_reference()
        if reference is not None and executable[1:] == reference[1][-1][:2]:
            # A retained sudo's argv describes its child. The kernel executable
            # identity, backed by protected system ancestry, proves the parent.
            launcher = reference
            native = False
    environment = candidate = cwd = nss = namespaces = account = root_account = None
    if native:
        if any(value != uid for value in uids):
            raise ObservationUnknown('incomplete')
        namespaces = _namespace(path)
        observer_namespaces = _namespace(proc / str(os.getpid()))
        if namespaces[1:] != observer_namespaces[1:]:
            raise ObservationUnknown('incomplete')
        environment = read_bounded(path / 'environ')
        candidate, cwd, nss = _native_home(path, uids[0], environment)
        # Root/account identity does not establish another mount namespace's
        # NSS providers or database. Missing environment requires that view too.
        if nss is not None and namespaces != observer_namespaces:
            raise ObservationUnknown('incomplete')
        account = account_evidence(candidate, uid)
        root_account = _account_in_root(path, candidate, uid)
        if root_account[1] != account:
            raise ObservationUnknown('incomplete')
        # Canonical host NSS is looked up for the verified real UID. A target
        # with a different filesystem root cannot establish that host identity.
        host_root = Path('/').stat()
        if nss is not None and root_account[0] != (host_root.st_dev, host_root.st_ino):
            raise ObservationUnknown('incomplete')
    after = process_identity(path)
    if before[1:] != after[1:] or after[0] in ('Z', 'X') or uids != process_uids(path) \
            or executable != _exe(path) or argv != read_bounded(path / 'cmdline'):
        raise ObservationUnknown('changed')
    if launcher is not None and launcher != _sudo_reference():
        raise ObservationUnknown('changed')
    if native:
        if environment != read_bounded(path / 'environ') or namespaces != _namespace(path) \
                or account != account_evidence(candidate, uid) \
                or root_account != _account_in_root(path, candidate, uid) \
                or (cwd is not None and cwd != os.readlink(path / 'cwd')):
            raise ObservationUnknown('changed')
        if nss is not None:
            record = pwd.getpwuid(uids[0])
            if nss != (record.pw_uid, record.pw_dir):
                raise ObservationUnknown('changed')
    evidence = (before[1:], uids, executable, argv, environment, cwd, nss, namespaces, account, root_account, launcher)
    consumer = {'pid': int(path.name), 'startTicks': str(before[1]),
                'accountId': _account_digest(account)} if native else None
    return consumer, evidence


def observe_uid(uid, proc=Path('/proc'), max_processes=MAX_PROCESSES, timeout_ms=MAX_DURATION_MS):
    """Bounded complete two-pass observation; caller proves proc-view authority."""
    if type(uid) is not int or uid < 0 or type(max_processes) is not int or not 1 <= max_processes <= MAX_PROCESSES \
            or type(timeout_ms) is not int or not 1 <= timeout_ms <= MAX_DURATION_MS:
        raise ObservationUnknown('request')
    deadline = time.monotonic_ns() + timeout_ms * 1000000

    def budget():
        if time.monotonic_ns() > deadline:
            raise ObservationUnknown('budget')

    def entries():
        found = []
        for path in proc.iterdir():
            budget()
            if path.name.isascii() and path.name.isdecimal():
                found.append(path)
                if len(found) > max_processes:
                    raise ObservationUnknown('budget')
        if str(os.getpid()) not in {path.name for path in found}:
            raise ObservationUnknown('incomplete')
        return sorted(found, key=lambda path: int(path.name))

    try:
        paths = entries()
        observations = []
        consumers = []
        for path in paths:
            budget()
            consumer, evidence = _inspect(path, uid, proc)
            observations.append(evidence)
            if consumer is not None:
                consumers.append(consumer)
                if len(consumers) > MAX_CONSUMERS:
                    raise ObservationUnknown('budget')
        if paths != entries():
            raise ObservationUnknown('changed')
        for path, evidence in zip(paths, observations):
            budget()
            if _inspect(path, uid, proc)[1] != evidence:
                raise ObservationUnknown('changed')
        if paths != entries():
            raise ObservationUnknown('changed')
        budget()
        return {'nativeConsumers': consumers, 'scannedProcesses': len(paths)}
    except ObservationUnknown:
        raise
    except (OSError, ValueError, KeyError, UnicodeError) as error:
        raise ObservationUnknown('incomplete') from error
