/**
 * Ported from Nova `gateway/tests/buildSpawnCommand.test.ts`. Adapted to the
 * argv-array form (no tmux shell string). Asserts every flag the interactive
 * REPL needs is present and ordered, that fresh pins `--session-id` while a
 * respawn replays `--resume`, and that `--model` is emitted LAST.
 */

import { describe, it, expect } from 'bun:test'
import { buildReplArgv } from '../build-repl-argv.ts'

const base = {
  sessionId: 'sess-uuid-1',
  channelName: 'neutron-abcd',
  mcpConfigPath: '/tmp/x-mcp.json',
  settingsPath: '/tmp/x-settings.json',
  appendSystemPromptFile: '/p/repl-agent-base.md',
  model: 'claude-opus-4-7',
  addDir: '/srv/neutron/owners/acme',
}

describe('buildReplArgv', () => {
  it('fresh spawn pins --session-id (not --resume)', () => {
    const argv = buildReplArgv({ ...base, resume: false, claudeBin: 'claude' })
    expect(argv[0]).toBe('claude')
    expect(argv).toContain('--session-id')
    expect(argv[argv.indexOf('--session-id') + 1]).toBe('sess-uuid-1')
    expect(argv).not.toContain('--resume')
  })

  it('respawn replays --resume with the same id', () => {
    const argv = buildReplArgv({ ...base, resume: true, claudeBin: 'claude' })
    expect(argv).toContain('--resume')
    expect(argv[argv.indexOf('--resume') + 1]).toBe('sess-uuid-1')
    expect(argv).not.toContain('--session-id')
  })

  it('includes the dev-channel + mcp-config + settings + system-prompt flags', () => {
    const argv = buildReplArgv({ ...base, resume: false })
    expect(argv).toContain('--dangerously-load-development-channels')
    expect(argv[argv.indexOf('--dangerously-load-development-channels') + 1]).toBe('server:neutron-abcd')
    expect(argv[argv.indexOf('--mcp-config') + 1]).toBe('/tmp/x-mcp.json')
    expect(argv[argv.indexOf('--settings') + 1]).toBe('/tmp/x-settings.json')
    expect(argv[argv.indexOf('--append-system-prompt-file') + 1]).toBe('/p/repl-agent-base.md')
    expect(argv[argv.indexOf('--add-dir') + 1]).toBe('/srv/neutron/owners/acme')
  })

  it('NEVER emits -p / --print (interactive only)', () => {
    const argv = buildReplArgv({ ...base, resume: false })
    expect(argv).not.toContain('-p')
    expect(argv).not.toContain('--print')
    expect(argv).not.toContain('stream-json')
  })

  it('--model is emitted LAST so nothing shadows it', () => {
    const argv = buildReplArgv({ ...base, resume: false })
    expect(argv[argv.length - 2]).toBe('--model')
    expect(argv[argv.length - 1]).toBe('claude-opus-4-7')
  })

  it('appends --dangerously-skip-permissions only when requested', () => {
    expect(buildReplArgv({ ...base, resume: false })).not.toContain('--dangerously-skip-permissions')
    expect(buildReplArgv({ ...base, resume: false, skipPermissions: true })).toContain(
      '--dangerously-skip-permissions',
    )
  })

  it('omits --add-dir when not provided', () => {
    const { addDir: _drop, ...noDir } = base
    const argv = buildReplArgv({ ...noDir, resume: false })
    expect(argv).not.toContain('--add-dir')
  })

  // SECURITY-CRITICAL (Codex-r1-P1): the persistent path MUST honor `tools: []`
  // exactly like the retired per-turn path — default-deny so an untrusted-content
  // turn (history-import) running under skip-permissions cannot reach Bash/Read/etc.
  describe('--tools default-deny (Codex-r1-P1 tool restriction)', () => {
    it('emits --tools "" when tools is undefined (default-deny)', () => {
      const argv = buildReplArgv({ ...base, resume: false })
      const i = argv.indexOf('--tools')
      expect(i).toBeGreaterThanOrEqual(0)
      expect(argv[i + 1]).toBe('')
    })

    it('emits --tools "" when tools is empty (a tools:[] caller gets NO tools)', () => {
      const argv = buildReplArgv({ ...base, resume: false, tools: [] })
      const i = argv.indexOf('--tools')
      expect(argv[i + 1]).toBe('')
      // No built-in tool name leaks into the argv.
      expect(argv).not.toContain('Bash')
      expect(argv).not.toContain('Read')
    })

    it('emits --tools <comma-list> when a surface is declared', () => {
      const argv = buildReplArgv({ ...base, resume: false, tools: ['Read', 'Grep'] })
      const i = argv.indexOf('--tools')
      expect(argv[i + 1]).toBe('Read,Grep')
    })
  })

  // P0-1 — the native-MCP tool bridge permission grant. ORTHOGONAL to --tools:
  // --allowedTools grants the MCP namespace WITHOUT re-enabling any built-in.
  describe('--allowedTools (P0-1 native-MCP tool bridge grant)', () => {
    it('omits --allowedTools by default (unchanged behaviour)', () => {
      const argv = buildReplArgv({ ...base, resume: false })
      expect(argv).not.toContain('--allowedTools')
    })

    it('omits --allowedTools for an empty grant', () => {
      const argv = buildReplArgv({ ...base, resume: false, allowedMcpTools: [] })
      expect(argv).not.toContain('--allowedTools')
    })

    it('emits --allowedTools <namespace> when the bridge is attached, leaving --tools "" intact', () => {
      const argv = buildReplArgv({
        ...base,
        resume: false,
        tools: [], // untrusted/default-deny built-ins
        allowedMcpTools: ['mcp__neutron'],
      })
      const a = argv.indexOf('--allowedTools')
      expect(a).toBeGreaterThanOrEqual(0)
      expect(argv[a + 1]).toBe('mcp__neutron')
      // The built-in default-deny is NOT relaxed by the MCP grant.
      const t = argv.indexOf('--tools')
      expect(argv[t + 1]).toBe('')
      expect(argv).not.toContain('Bash')
    })
  })
})
