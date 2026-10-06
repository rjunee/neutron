"""One admission observation client; configured observer failures never fall back."""
import base64
import json
import os
from pathlib import Path
import re
import secrets
import socket
import stat
import struct
import subprocess
import time

from codex_account_observation import (MAX_CONSUMERS, MAX_DURATION_MS, MAX_PROCESSES,
                                      ObservationUnknown, observe_uid, process_identity)

PIN_ROOT = Path('/etc/neutron/codex-observer')
MAX_FRAME = 1048576
REQUEST_TIMEOUT_NS = 3000000000
OPENSSL = '/usr/bin/openssl'


def exact(value, keys):
    if type(value) is not dict or set(value) != set(keys):
        raise ObservationUnknown('request')


def strict_json(data):
    def pairs(items):
        value = {}
        for key, item in items:
            if key in value:
                raise ObservationUnknown('request')
            value[key] = item
        return value

    def invalid(_value):
        raise ObservationUnknown('request')

    return json.loads(data.decode('utf-8', 'strict'), object_pairs_hook=pairs, parse_constant=invalid)


def canonical_json(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True,
                      allow_nan=False).encode('ascii')


def protected_path(path, socket_leaf=False):
    if not path.is_absolute() or str(path) != os.path.normpath(str(path)):
        raise ObservationUnknown('unavailable')
    cursor = path
    while True:
        entry = cursor.lstat()
        leaf = cursor == path
        expected = stat.S_ISSOCK if leaf and socket_leaf else stat.S_ISREG if leaf else stat.S_ISDIR
        if entry.st_uid != 0 or not expected(entry.st_mode) \
                or (not (leaf and socket_leaf) and entry.st_mode & 0o022):
            raise ObservationUnknown('unavailable')
        if cursor == cursor.parent:
            return
        cursor = cursor.parent


def _identifier(value):
    return type(value) is str and re.fullmatch(r'[A-Za-z0-9_.-]{1,128}', value) is not None


def load_pin(uid):
    path = PIN_ROOT / (str(uid) + '.json')
    try:
        path.lstat()
    except FileNotFoundError:
        # An absent pin is the only local-transport selection. Broken symlinks
        # and permission errors are present/unknown and cannot select local.
        cursor = path.parent
        while True:
            try:
                ancestor = cursor.lstat()
            except FileNotFoundError:
                pass
            else:
                # No pin is being trusted here. Read-only rootless self-hosts
                # can see unmapped ancestor ownership; symlinks or writable
                # ancestry still cannot prove that registration is absent.
                if not stat.S_ISDIR(ancestor.st_mode) or ancestor.st_mode & 0o022:
                    raise ObservationUnknown('unavailable')
            if cursor == cursor.parent:
                break
            cursor = cursor.parent
        return None
    protected_path(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        entry = os.fstat(fd)
        named = path.lstat()
        if not stat.S_ISREG(entry.st_mode) or entry.st_uid != 0 or entry.st_mode & 0o022 \
                or (entry.st_dev, entry.st_ino) != (named.st_dev, named.st_ino):
            raise ObservationUnknown('unavailable')
        data = os.read(fd, 8193)
        if len(data) > 8192:
            raise ObservationUnknown('unavailable')
    finally:
        os.close(fd)
    value = strict_json(data)
    exact(value, ('version', 'kind', 'instanceId', 'hostId', 'socketPath', 'publicKey'))
    if type(value['version']) is not int or value['version'] != 1 or value['kind'] != 'codex-observer-pin' \
            or not _identifier(value['instanceId']) or not _identifier(value['hostId']) \
            or type(value['socketPath']) is not str or not Path(value['socketPath']).is_absolute() \
            or len(os.fsencode(value['socketPath'])) > 107:
        raise ObservationUnknown('unavailable')
    _public_der(value['publicKey'])
    return value


def _public_der(pem):
    if type(pem) is not str:
        raise ObservationUnknown('unavailable')
    match = re.fullmatch(r'-----BEGIN PUBLIC KEY-----\n([A-Za-z0-9+/=\n]+)-----END PUBLIC KEY-----\n?', pem)
    if not match:
        raise ObservationUnknown('unavailable')
    der = base64.b64decode(match[1].replace('\n', ''), validate=True)
    # RFC 8410 Ed25519 SubjectPublicKeyInfo; exactly one 32-byte public key.
    if len(der) != 44 or der[:12] != bytes.fromhex('302a300506032b6570032100'):
        raise ObservationUnknown('unavailable')
    return der


def _verify_signature(public_key, payload, signature, timeout):
    if type(signature) is not str:
        raise ObservationUnknown('request')
    decoded = base64.b64decode(signature, validate=True)
    if len(decoded) != 64 or base64.b64encode(decoded).decode('ascii') != signature:
        raise ObservationUnknown('request')
    descriptors = []
    try:
        for content in (_public_der(public_key), canonical_json(payload), decoded):
            fd = os.memfd_create('codex-observation-verification', os.MFD_CLOEXEC)
            descriptors.append(fd)
            os.write(fd, content)
            os.lseek(fd, 0, os.SEEK_SET)
        key, body, signed = ['/proc/self/fd/' + str(fd) for fd in descriptors]
        result = subprocess.run([OPENSSL, 'pkeyutl', '-verify', '-pubin', '-keyform', 'DER',
                                 '-inkey', key, '-rawin', '-in', body, '-sigfile', signed],
                                pass_fds=descriptors, stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                timeout=timeout, env={'PATH': '/usr/bin:/bin'})
        if result.returncode != 0:
            raise ObservationUnknown('request')
    finally:
        for fd in descriptors:
            os.close(fd)


def _integer(value, minimum=0, maximum=9007199254740991):
    return type(value) is int and minimum <= value <= maximum


def _decimal(value):
    return type(value) is str and re.fullmatch(r'0|[1-9][0-9]{0,19}', value) is not None


def boot_id():
    value = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    if re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', value) is None:
        raise ObservationUnknown('unavailable')
    return value


def validate_response(value, pin, challenge, caller, uid, boot, started, finished):
    exact(value, ('payload', 'signature'))
    payload = value['payload']
    exact(payload, ('version', 'kind', 'instanceId', 'uid', 'hostId', 'bootId', 'challenge',
                    'caller', 'startedMonotonicNs', 'finishedMonotonicNs', 'bounds',
                    'scannedProcesses', 'nativeConsumers'))
    if type(payload['version']) is not int or payload['version'] != 1 \
            or payload['kind'] != 'codex-live-census' or payload['instanceId'] != pin['instanceId'] \
            or payload['hostId'] != pin['hostId'] or payload['bootId'] != boot \
            or not _integer(payload['uid']) or payload['uid'] != uid or payload['challenge'] != challenge:
        raise ObservationUnknown('request')
    exact(payload['caller'], ('pid', 'startTicks'))
    if not _integer(payload['caller']['pid'], 1) or not _decimal(payload['caller']['startTicks']) \
            or payload['caller'] != caller:
        raise ObservationUnknown('peer')
    exact(payload['bounds'], ('maxProcesses', 'maxDurationMs'))
    if type(payload['bounds']['maxProcesses']) is not int or type(payload['bounds']['maxDurationMs']) is not int \
            or payload['bounds'] != {'maxProcesses': MAX_PROCESSES, 'maxDurationMs': MAX_DURATION_MS} \
            or not _integer(payload['scannedProcesses'], 1, MAX_PROCESSES):
        raise ObservationUnknown('budget')
    if not _decimal(payload['startedMonotonicNs']) or not _decimal(payload['finishedMonotonicNs']):
        raise ObservationUnknown('request')
    scan_start, scan_end = int(payload['startedMonotonicNs']), int(payload['finishedMonotonicNs'])
    if not started <= scan_start <= scan_end <= finished or finished - started > REQUEST_TIMEOUT_NS \
            or scan_end - scan_start > MAX_DURATION_MS * 1000000:
        raise ObservationUnknown('budget')
    consumers = payload['nativeConsumers']
    if type(consumers) is not list or len(consumers) > min(MAX_CONSUMERS, payload['scannedProcesses']):
        raise ObservationUnknown('budget')
    last = 0
    for consumer in consumers:
        exact(consumer, ('pid', 'startTicks', 'accountId'))
        if not _integer(consumer['pid'], last + 1) or not _decimal(consumer['startTicks']) \
                or type(consumer['accountId']) is not str or re.fullmatch(r'[0-9a-f]{64}', consumer['accountId']) is None:
            raise ObservationUnknown('request')
        last = consumer['pid']
    remaining = (REQUEST_TIMEOUT_NS - (time.monotonic_ns() - started)) / 1000000000
    if remaining <= 0:
        raise ObservationUnknown('budget')
    _verify_signature(pin['publicKey'], payload, value['signature'], remaining)
    return {'nativeConsumers': consumers, 'scannedProcesses': payload['scannedProcesses']}


def observer_request(pin, uid):
    path = Path(pin['socketPath'])
    protected_path(path, socket_leaf=True)
    challenge = secrets.token_hex(32)
    caller = {'pid': os.getpid(), 'startTicks': str(process_identity(Path('/proc') / str(os.getpid()))[1])}
    boot = boot_id()
    started = time.monotonic_ns()

    def remaining():
        value = (REQUEST_TIMEOUT_NS - (time.monotonic_ns() - started)) / 1000000000
        if value <= 0:
            raise ObservationUnknown('budget')
        return value

    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(remaining())
        connection.connect(str(path))
        _pid, peer_uid, _gid = struct.unpack('3i', connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        if peer_uid != 0:
            raise ObservationUnknown('peer')
        request = canonical_json({'version': 1, 'kind': 'codex-live-census-request',
                                  'instanceId': pin['instanceId'], 'challenge': challenge}) + b'\n'
        connection.settimeout(remaining())
        connection.sendall(request)
        connection.shutdown(socket.SHUT_WR)
        data = bytearray()
        while True:
            connection.settimeout(remaining())
            chunk = connection.recv(min(65536, MAX_FRAME + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > MAX_FRAME:
                raise ObservationUnknown('budget')
        if not data.endswith(b'\n') or data.count(b'\n') != 1:
            raise ObservationUnknown('request')
    result = validate_response(strict_json(bytes(data[:-1])), pin, challenge, caller, uid,
                               boot, started, time.monotonic_ns())
    if boot_id() != boot or process_identity(Path('/proc') / str(os.getpid()))[1] != int(caller['startTicks']):
        raise ObservationUnknown('changed')
    remaining()
    return result


def _local_proc_view():
    fd = os.open('/proc', os.O_PATH | os.O_DIRECTORY)
    try:
        identity = os.fstat(fd)
        fields = Path('/proc/self/fdinfo/' + str(fd)).read_text().splitlines()
        mount_ids = [line.split()[1] for line in fields if line.startswith('mnt_id:')]
        if len(mount_ids) != 1:
            raise ObservationUnknown('incomplete')
        mounts = Path('/proc/self/mountinfo').read_text().splitlines()
        matching = [line for line in mounts if line.split()[0] == mount_ids[0]]
        if len(matching) != 1 or ' - proc ' not in matching[0] or matching[0].split()[4] != '/proc' \
                or re.search(r'(?:^|[, ])(?:hidepid=(?!0(?:,| |$))|subset=pid)', matching[0]):
            raise ObservationUnknown('incomplete')
        return identity.st_dev, identity.st_ino, matching[0]
    finally:
        os.close(fd)


def observe_account_consumers(uid):
    pin = load_pin(uid)
    if pin is not None:
        return observer_request(pin, uid)
    # Local transport is never selected by an observer error. A complete local
    # proc mount remains the self-host prerequisite; test namespaces are local.
    view = _local_proc_view()
    boot = boot_id()
    result = observe_uid(uid)
    if boot_id() != boot or _local_proc_view() != view or load_pin(uid) is not None:
        raise ObservationUnknown('changed')
    return result
