#!/usr/bin/env python3
"""Offline Pi contract probe. Requires pi on PATH; uses an isolated agent directory.
No parent model prompt is sent; the extension child is killed on appearance.
Prints only measured booleans, tool names and exit status.
"""
import json
import os
from pathlib import Path
import select
import shutil
import signal
import subprocess
import tempfile
import time


class Rpc:
    def __init__(self, args, env, cwd):
        self.proc = subprocess.Popen(['pi', '--mode', 'rpc', *args], env=env, cwd=cwd,
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.DEVNULL)
        self.buffer = b''
        self.counter = 0

    def call(self, kind, **fields):
        self.counter += 1
        identity = str(self.counter)
        self.proc.stdin.write((json.dumps(dict(id=identity, type=kind, **fields)) + '\n').encode())
        self.proc.stdin.flush()
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if b'\n' not in self.buffer:
                if not select.select([self.proc.stdout], [], [], 0.1)[0]:
                    continue
                chunk = os.read(self.proc.stdout.fileno(), 65536)
                assert chunk, 'RPC exited before response'
                self.buffer += chunk
                continue
            line, self.buffer = self.buffer.split(b'\n', 1)
            event = json.loads(line)
            if event.get('type') == 'response' and event.get('id') == identity:
                assert event['success'], event.get('command')
                return event.get('data')
        raise RuntimeError('RPC response deadline expired')

    def close(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()


with tempfile.TemporaryDirectory(prefix='pi-contract-') as temp:
    root = Path(temp)
    binary = shutil.which('pi')
    assert binary, 'Install Pi before running this explicit probe'
    package = Path(binary).resolve().parents[2]
    example = package / 'examples/extensions/subagent/index.ts'
    assert example.is_file(), 'Installed package layout changed'
    env = {key: value for key, value in os.environ.items()
           if key in ('PATH', 'LANG', 'TERM', 'TMPDIR')}
    env['PI_CODING_AGENT_DIR'] = str(root / 'agent')
    agents = root / 'agent/agents'
    agents.mkdir(parents=True)
    (agents / 'probe.md').write_text('---\nname: probe\ndescription: offline probe\ntools: read\n---\nOffline probe.\n')
    extension = root / 'probe.ts'
    extension.write_text('import subagent from ' + json.dumps(str(example)) + ';\n' + '''
export default function(pi) {
  let tool;
  subagent(new Proxy(pi, { get(target, key) {
    if (key === 'registerTool') return definition => { tool = definition; pi.registerTool(definition); };
    return target[key];
  }}));
  pi.registerCommand('measure', { handler: async (_args, ctx) => {
    pi.sendMessage({ customType: 'probe', content: 'offline-marker', display: false,
      details: { active: pi.getActiveTools(), all: pi.getAllTools().map(t => t.name) } });
  }});
  pi.registerCommand('child', { handler: async (_args, ctx) => {
    const result = await tool.execute('offline-child', { agent: 'probe', task: 'offline', agentScope: 'user' }, undefined, undefined, ctx);
    pi.sendMessage({ customType: 'child-probe', content: 'child-observed', display: false,
      details: result.details.results.map(r => ({ exitCode: r.exitCode, messages: r.messages.length })) });
  }});
}
''')
    common = ['--no-extensions', '--no-skills', '--no-prompt-templates',
              '-e', str(extension), '--provider', 'anthropic', '--model', 'claude-sonnet-4-5']
    # Seed a valid conversation offline to measure resume without an LLM response.
    session = root / 'project.jsonl'
    session.write_text(json.dumps(dict(type='session', version=3, id='00000000-0000-4000-8000-000000000938',
                                      timestamp='2026-09-15T00:00:00.000Z', cwd=str(root))) + '\n')
    reports = []
    for flags, expected in [(['--tools', 'read,subagent'], ['read', 'subagent']),
                            (['--no-tools'], []),
                            (['--tools', 'read,subagent', '--exclude-tools', 'subagent'], ['read'])]:
        rpc = Rpc([*common, '--session', str(session), *flags], env, root)
        try:
            before = rpc.call('get_state')
            rpc.call('prompt', message='/measure')
            messages = rpc.call('get_messages')['messages']
            probe = [m for m in messages if m.get('customType') == 'probe'][-1]
            assert sorted(probe['details']['active']) == sorted(expected)
            assert sorted(probe['details']['all']) == sorted(expected)
            assert before['sessionId'] == '00000000-0000-4000-8000-000000000938'
            reports.append(dict(active=probe['details']['active'], configured=probe['details']['all']))
        finally:
            rpc.close()
    # A signal-only child close is observable without credentials. Stop the child
    # as soon as Linux exposes it. The isolated agent directory has no credentials.
    rpc = Rpc([*common, '--session', str(session), '--tools', 'read,subagent'], env, root)
    try:
        assert rpc.call('get_state')['sessionId'] == '00000000-0000-4000-8000-000000000938'
        messages = rpc.call('get_messages')['messages']
        continuity = any(m.get('content') == 'offline-marker' for m in messages)
        # The controller must watch concurrently while the extension awaits its child.
        import threading
        killed = []
        def kill_child():
            deadline = time.monotonic() + 10
            child_file = Path('/proc') / str(rpc.proc.pid) / 'task' / str(rpc.proc.pid) / 'children'
            while time.monotonic() < deadline:
                for value in child_file.read_text().split():
                    pid = int(value)
                    try:
                        os.kill(pid, signal.SIGKILL)
                        killed.append(True)
                        return
                    except ProcessLookupError:
                        pass
                time.sleep(0.001)
        watcher = threading.Thread(target=kill_child)
        watcher.start()
        rpc.call('prompt', message='/child')
        watcher.join()
        assert killed, 'Did not observe and kill the extension child'
        messages = rpc.call('get_messages')['messages']
        child = [m for m in messages if m.get('customType') == 'child-probe'][-1]
        print(json.dumps(dict(version=subprocess.check_output(['pi', '--version'], text=True).strip(),
                              rpc_correlated=True, tools=reports, session_id_preserved=True,
                              conversation_persisted=continuity, child_killed=True,
                              child_report=child['details'])))
        assert continuity, 'Conversation did not survive RPC restart'
    finally:
        rpc.close()
