#!/usr/bin/env python3
"""Offline official-CLI Messages wire proof; no provider or owner credentials.

Run: python3 scripts/proof/native-unix-wire.py --claude /path/to/official/claude
The complete probe runs in a private network/PID namespace. It creates only
synthetic config/transcripts and terminates only its own diagnostic children.
This proves wire framing, not a provider response or live workflow completion.
"""
import argparse
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time
import uuid

MODULE = Path(__file__).resolve().parents[2] / 'runtime/adapters/claude-code/persistent/native-request-relay.ts'


def measure(cli, legacy):
    with tempfile.TemporaryDirectory(prefix='native-wire-') as directory:
        root = Path(directory)
        config, cwd = root / 'config', root / 'work'
        config.mkdir(); cwd.mkdir()
        (config / '.claude.json').write_text(json.dumps({
            'hasCompletedOnboarding': True, 'theme': 'dark',
            'projects': {str(cwd): {'hasTrustDialogAccepted': True, 'allowedTools': [], 'history': []}},
        }))
        path = str(root / 'relay.sock')
        source = ('import {prepareNativeRequestRelay} from ' + json.dumps(str(MODULE)) + ';'
                  'console.log(JSON.stringify(prepareNativeRequestRelay({},'
                  '{version:1,hostId:"fixture",instanceId:"fixture",publicKey:"unused-fixture",'
                  'claudeConfigDir:' + json.dumps(str(config)) + ',socketPath:' + json.dumps(path) + '}).env))')
        launch = json.loads(subprocess.check_output(['bun', '-e', source], text=True))
        if legacy:
            launch['ANTHROPIC_BASE_URL'] = 'https://api.anthropic.com'
        else:
            assert launch['ANTHROPIC_BASE_URL'] == 'http://127.0.0.1:0'
        listener = socket.socket(socket.AF_UNIX)
        listener.bind(path); listener.listen(); listener.settimeout(.2)
        seen, stop = [], threading.Event()

        def serve():
            while not stop.is_set():
                try:
                    conn, _ = listener.accept()
                except TimeoutError:
                    continue
                except OSError:
                    break
                with conn:
                    conn.settimeout(2)
                    try:
                        data = conn.recv(65536)
                    except OSError:
                        continue
                    if data[:1] == b'\x16':
                        seen.append({'protocol': 'TLS', 'prefix': data[:3].hex()})
                    else:
                        line = data.split(b'\r\n', 1)[0].decode('ascii', 'replace')
                        seen.append({'protocol': 'HTTP', 'requestLine': line})
                        body = b'{"type":"error","error":{"type":"authentication_error","message":"Offline fixture complete"}}'
                        try:
                            conn.sendall(b'HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: '
                                         + str(len(body)).encode() + b'\r\nConnection: close\r\n\r\n' + body)
                        except OSError:
                            pass

        thread = threading.Thread(target=serve); thread.start()
        env = {'PATH': os.environ['PATH'], 'TERM': 'xterm-256color', 'CLAUDE_CONFIG_DIR': str(config),
               'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1', 'DISABLE_AUTOUPDATER': '1',
               'DISABLE_TELEMETRY': '1', **launch}
        master, slave = pty.openpty()
        child = subprocess.Popen([cli, '--session-id', str(uuid.uuid4()), '--tools', '',
                                  '--permission-mode', 'dontAsk', '--strict-mcp-config',
                                  '--mcp-config', '{"mcpServers":{}}', '--', 'Reply with OK.'],
                                 cwd=cwd, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        try:
            deadline = time.monotonic() + 25
            def messages():
                return [row for row in seen if row['protocol'] == 'TLS'
                        or row.get('requestLine', '').startswith('POST /v1/messages')]
            while time.monotonic() < deadline and not messages() and child.poll() is None:
                if select.select([master], [], [], .2)[0]:
                    try:
                        os.read(master, 65536)  # Drain only; never print CLI content.
                    except OSError:
                        break
            wire = messages()
            assert wire and wire[0]['protocol'] == ('TLS' if legacy else 'HTTP'), 'Unexpected native Messages wire'
            print(json.dumps({'variant': 'old-HTTPS-control' if legacy else 'shipped-launch', 'wire': wire[0]}), flush=True)
        finally:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL); child.wait()
            os.close(master); stop.set(); thread.join(); listener.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--claude', required=True)
    parser.add_argument('--isolated', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    cli = shutil.which(args.claude)
    assert cli, 'Official CLI not found'
    if not args.isolated:
        subprocess.run(['bwrap', '--unshare-user', '--unshare-net', '--unshare-pid', '--as-pid-1',
                        '--die-with-parent', '--bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
                        '--', 'python3', '-B', str(Path(__file__).resolve()), '--claude', cli, '--isolated'], check=True)
    else:
        assert {name for _, name in socket.if_nameindex()} == {'lo'}, 'Network namespace must contain only loopback'
        print(subprocess.check_output([cli, '--version'], text=True).strip(), flush=True)
        measure(cli, True)
        measure(cli, False)
