/**
 * O3 — producer-side spawn/channel error classification.
 *
 * Pins that the persistent-REPL adapter stamps the correct `SubstrateErrorClass`
 * for its own spawn/channel failure shapes, so the composer classifies on `code`
 * first. Mirrors the composer's `detectBinaryNotFound` / `detectChannelWedged`
 * negative-space guarantees at the producer.
 */

import { describe, expect, test } from 'bun:test'

import { classifySpawnError } from '../classify-spawn-error.ts'

describe('classifySpawnError', () => {
  test('missing `claude` binary shapes → binary_not_found', () => {
    expect(classifySpawnError('Executable not found in $PATH: "claude"')).toBe('binary_not_found')
    expect(classifySpawnError('Error: spawn claude ENOENT')).toBe('binary_not_found')
    expect(classifySpawnError('sh: claude: command not found')).toBe('binary_not_found')
    expect(classifySpawnError('spawn claude: no such file or directory')).toBe('binary_not_found')
  })

  test('an unrelated file ENOENT is NOT binary_not_found (requires a `claude` mention)', () => {
    expect(classifySpawnError('Error: spawn ENOENT')).toBeUndefined()
    expect(classifySpawnError('ENOENT: no such file or directory, open /tmp/settings.json')).toBeUndefined()
  })

  test('a missing OTHER executable is NOT binary_not_found — the executable-not-found branch also requires a `claude` mention', () => {
    // A spawn failure for some other binary (e.g. a helper the child shells out
    // to) must not be mislabelled as "Claude not on PATH".
    expect(classifySpawnError('Executable not found in $PATH: "bun"')).toBeUndefined()
    expect(classifySpawnError('Executable not found in $PATH: "ripgrep"')).toBeUndefined()
  })

  test('post-spawn-assertion / channel failures → channel_wedged', () => {
    for (const reason of ['channel-wedged', 'no-channel-ready', 'no-http-health', 'dead-child']) {
      expect(classifySpawnError(`persistent-repl: spawn failed (${reason}; pid=1)`)).toBe('channel_wedged')
    }
    expect(classifySpawnError('[channel-wedged] REPL sess still unwired')).toBe('channel_wedged')
    expect(classifySpawnError('persistent-repl: channel not ready')).toBe('channel_wedged')
  })

  test('an ordinary retryable turn error is unclassified (undefined → composer ladder decides)', () => {
    expect(classifySpawnError('persistent-repl: REPL process exited')).toBeUndefined()
    expect(classifySpawnError('some transient inner hiccup')).toBeUndefined()
  })
})
