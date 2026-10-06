"""Real Ed25519 verification and fail-closed admission without credential access."""
import base64
import copy
import importlib.util
import os
from pathlib import Path
import subprocess
import struct
import tempfile
import time
import unittest
from unittest.mock import patch

import codex_account_client as client
from codex_account_observation import ObservationUnknown

spec = importlib.util.spec_from_file_location('writer', Path(__file__).with_name('account-writer.py'))
writer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(writer)


class ClientTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='codex-observer-client-')
        cls.root = Path(cls.temp.name)
        cls.key = cls.root / 'fixture-key.pem'
        subprocess.run([client.OPENSSL, 'genpkey', '-algorithm', 'ED25519', '-out', str(cls.key)], check=True, capture_output=True)
        cls.public = subprocess.run([client.OPENSSL, 'pkey', '-in', str(cls.key), '-pubout'], check=True, capture_output=True).stdout.decode()

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def setUp(self):
        self.started = time.monotonic_ns()
        self.pin = {'version': 1, 'kind': 'codex-observer-pin', 'instanceId': 'fixture',
                    'hostId': 'host', 'socketPath': '/run/neutron-fixture.sock', 'publicKey': self.public}
        self.caller = {'pid': 100, 'startTicks': '123'}
        self.payload = {'version': 1, 'kind': 'codex-live-census', 'instanceId': 'fixture',
                        'uid': os.getuid(), 'hostId': 'host', 'bootId': '00000000-0000-0000-0000-000000000001',
                        'challenge': 'a' * 64, 'caller': self.caller,
                        'startedMonotonicNs': str(time.monotonic_ns()),
                        'finishedMonotonicNs': str(time.monotonic_ns()),
                        'bounds': {'maxProcesses': 65536, 'maxDurationMs': 2000},
                        'scannedProcesses': 2, 'nativeConsumers': [{'pid': 101, 'startTicks': '456', 'accountId': 'b' * 64}]}

    def signed(self, payload=None):
        payload = self.payload if payload is None else payload
        body = self.root / 'fixture-body'
        body.write_bytes(client.canonical_json(payload))
        signature = subprocess.run([client.OPENSSL, 'pkeyutl', '-sign', '-inkey', str(self.key),
                                    '-rawin', '-in', str(body)], capture_output=True, check=True).stdout
        return {'payload': payload, 'signature': base64.b64encode(signature).decode()}

    def validate(self, envelope=None, **overrides):
        values = {'pin': self.pin, 'challenge': 'a' * 64, 'caller': self.caller,
                  'uid': os.getuid(), 'boot': '00000000-0000-0000-0000-000000000001',
                  'started': self.started, 'finished': time.monotonic_ns()}
        values.update(overrides)
        return client.validate_response(self.signed() if envelope is None else envelope, **values)

    def test_real_signature_complete_empty_and_distinct_consumers(self):
        result = self.validate()
        self.assertEqual(result['nativeConsumers'], self.payload['nativeConsumers'])
        self.payload['nativeConsumers'] = []
        self.assertEqual(self.validate()['nativeConsumers'], [])

    def test_forged_and_wrong_key_signatures_refuse(self):
        envelope = self.signed()
        envelope['payload']['nativeConsumers'] = []
        with self.assertRaises(ObservationUnknown):
            self.validate(envelope)
        for signature in ('', '!' * 88, base64.b64encode(bytes(64)).decode()):
            envelope = self.signed()
            envelope['signature'] = signature
            with self.assertRaises((ObservationUnknown, ValueError)):
                self.validate(envelope)
        wrong = copy.deepcopy(self.pin)
        wrong['publicKey'] = self.public.replace(self.public.splitlines()[1], base64.b64encode(bytes.fromhex('302a300506032b6570032100') + bytes(32)).decode())
        with self.assertRaises(ObservationUnknown):
            self.validate(pin=wrong)

    def test_every_binding_and_exact_schema_refuses(self):
        changes = {'version': True, 'kind': 'host-boot', 'instanceId': 'other', 'uid': os.getuid() + 1,
                   'hostId': 'other', 'bootId': 'other', 'challenge': 'c' * 64,
                   'caller': {'pid': 101, 'startTicks': '123'}, 'startedMonotonicNs': '01',
                   'finishedMonotonicNs': str(self.started - 1), 'bounds': {'maxProcesses': 1, 'maxDurationMs': 2000},
                   'scannedProcesses': 0, 'nativeConsumers': [{'pid': True, 'startTicks': '1', 'accountId': 'b' * 64}]}
        for key, value in changes.items():
            with self.subTest(key=key):
                changed = copy.deepcopy(self.payload)
                changed[key] = value
                with self.assertRaises(ObservationUnknown):
                    self.validate(self.signed(changed))
        for key in self.payload:
            changed = copy.deepcopy(self.payload)
            del changed[key]
            with self.assertRaises(ObservationUnknown):
                self.validate(self.signed(changed))
        changed = {**self.payload, 'query': '/proc'}
        with self.assertRaises(ObservationUnknown):
            self.validate(self.signed(changed))

    def test_replayed_future_long_or_duplicate_observations_refuse(self):
        envelope = self.signed()
        with self.assertRaises(ObservationUnknown):
            self.validate(envelope, started=int(self.payload['finishedMonotonicNs']) + 1)
        with self.assertRaises(ObservationUnknown):
            self.validate(envelope, finished=self.started + 3000000001)
        self.payload['nativeConsumers'] *= 2
        with self.assertRaises(ObservationUnknown):
            self.validate()

    def test_strict_decoding_and_refusal_never_grant_permission(self):
        for data in (b'{"version":1,"version":1}', b'{"v":NaN}', b'{"v":"\xff"}', b'{}{}'):
            with self.assertRaises((ObservationUnknown, ValueError, UnicodeError)):
                client.strict_json(data)
        for reason in ('peer', 'request', 'incomplete', 'changed', 'budget', 'unavailable'):
            with self.assertRaises(ObservationUnknown):
                self.validate({'version': 1, 'kind': 'codex-live-census-refusal', 'reason': reason})

    def test_configured_observer_error_never_calls_local_classifier(self):
        with patch.object(client, 'load_pin', return_value=self.pin), \
                patch.object(client, 'observer_request', side_effect=ObservationUnknown('unavailable')), \
                patch.object(client, 'observe_uid') as local:
            with self.assertRaises(ObservationUnknown):
                client.observe_account_consumers(os.getuid())
            local.assert_not_called()
        with patch.object(client, 'load_pin', side_effect=PermissionError()), patch.object(client, 'observe_uid') as local:
            with self.assertRaises(PermissionError):
                client.observe_account_consumers(os.getuid())
            local.assert_not_called()

    def test_present_invalid_and_broken_symlink_pins_never_select_local(self):
        pin = self.root / (str(os.getuid()) + '.json')
        with patch.object(client, 'PIN_ROOT', self.root):
            # Missing configuration below writable ancestry is not proof of an
            # unregistered deployment, even when the leaf does not exist.
            with self.assertRaises(ObservationUnknown):
                client.load_pin(os.getuid())
            pin.symlink_to(self.root / 'missing')
            try:
                with self.assertRaises(ObservationUnknown):
                    client.load_pin(os.getuid())
            finally:
                pin.unlink()
            pin.write_bytes(b'{}')
            try:
                with self.assertRaises(ObservationUnknown):
                    client.load_pin(os.getuid())
            finally:
                pin.unlink()

    def test_missing_verifier_and_wrong_key_type_refuse(self):
        with patch.object(client, 'OPENSSL', '/nonexistent-observer-verifier'):
            with self.assertRaises(FileNotFoundError):
                self.validate()
        with self.assertRaises(ObservationUnknown):
            client._public_der('not an Ed25519 pin')

    def test_transport_half_closes_request_and_requires_single_frame(self):
        owner = self
        class Connection:
            def __init__(self, extra=b''):
                self.closed_write = False
                self.sent = False
                self.extra = extra
            def __enter__(self):
                return self
            def __exit__(self, *_args):
                pass
            def settimeout(self, value):
                owner.assertGreater(value, 0)
                owner.assertLessEqual(value, 3)
            def connect(self, path):
                owner.assertEqual(path, owner.pin['socketPath'])
            def getsockopt(self, *_args):
                return struct.pack('3i', 1, 0, 0)
            def sendall(self, request):
                owner.assertLessEqual(len(request), 1024)
                owner.assertTrue(request.endswith(b'\n'))
                decoded = client.strict_json(request[:-1])
                owner.assertEqual(set(decoded), {'version', 'kind', 'instanceId', 'challenge'})
                owner.assertEqual(decoded['kind'], 'codex-live-census-request')
                payload = copy.deepcopy(owner.payload)
                payload.update(challenge=decoded['challenge'], bootId=client.boot_id(),
                               caller={'pid': os.getpid(), 'startTicks': str(client.process_identity(Path('/proc') / str(os.getpid()))[1])},
                               startedMonotonicNs=str(time.monotonic_ns()), finishedMonotonicNs=str(time.monotonic_ns()))
                self.response = client.canonical_json(owner.signed(payload)) + b'\n' + self.extra
            def shutdown(self, how):
                owner.assertEqual(how, client.socket.SHUT_WR)
                self.closed_write = True
            def recv(self, _size):
                owner.assertTrue(self.closed_write, 'request EOF must precede response read')
                if self.sent:
                    return b''
                self.sent = True
                return self.response
        for extra in (b'', b'{}\n', b'trailing'):
            with patch.object(client.socket, 'socket', return_value=Connection(extra)), patch.object(client, 'protected_path'):
                if extra:
                    with self.assertRaises(ObservationUnknown):
                        client.observer_request(self.pin, os.getuid())
                else:
                    self.assertEqual(client.observer_request(self.pin, os.getuid())['nativeConsumers'], self.payload['nativeConsumers'])

    def test_consuming_auth_probe_and_launch_share_busy_unknown_distinct_results(self):
        home = self.root / 'account'
        home.mkdir(exist_ok=True)
        identity = writer.account_identity(home, os.getuid())
        original_lock_file = writer.lock_file
        for mode in ('probe', 'launch'):
            for account, outcome in ((identity, writer.Busy), ('b' * 64, None), (None, ObservationUnknown)):
                descriptors = set()
                def tracked(*args, **kwargs):
                    fd = original_lock_file(*args, **kwargs)
                    descriptors.add(fd)
                    return fd
                result = {'nativeConsumers': [{'pid': 101, 'startTicks': '456', 'accountId': account}], 'scannedProcesses': 2}
                with patch.object(writer, 'observe_account_consumers', side_effect=ObservationUnknown() if account is None else None,
                                  return_value=result), patch.object(writer, 'native_command', return_value='/fixture/codex'), \
                        patch.object(writer.os, 'execve') as execute, patch.object(writer, 'lock_file', tracked):
                    args = ['--census', str(home)] if mode == 'probe' else ['--home', str(home), '--', 'codex']
                    if outcome:
                        with self.assertRaises(outcome):
                            writer.main(args)
                        execute.assert_not_called()
                    else:
                        writer.main(args)
                        self.assertEqual(execute.call_count, int(mode == 'launch'))
                for fd in descriptors:
                    try:
                        os.close(fd)
                    except OSError:
                        pass  # The successful handoff already closes its reservation.


if __name__ == '__main__':
    unittest.main()
