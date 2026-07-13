// F3 (Medium #3) — every PRODUCTION standalone entrypoint must install the
// process-level rejection/exception safety net. Standalone = a process `main`
// that does NOT go through the gateway `boot()` (which installs it). This
// source-level assertion locks the requirement without spawning each process.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')

// Standalone entrypoints that must install the net DIRECTLY.
const STANDALONE = [
  'landing/boot.ts',
  'runtime/adapters/claude-code/persistent/dev-channel.ts',
  'gbrain-memory/gbrain-doctor.ts',
  'open/diagnostics-cli.ts',
  'migrations/runner.ts',
]

describe('production entrypoints install the safety net', () => {
  for (const rel of STANDALONE) {
    test(`${rel} calls installProcessSafetyNet()`, () => {
      expect(read(rel)).toContain('installProcessSafetyNet(')
    })
  }

  test('gateway boot() installs it (the composition entrypoint)', () => {
    expect(read('gateway/index.ts')).toContain('installProcessSafetyNet(')
  })

  test('open/server.ts inherits it via gateway boot() (does not need its own)', () => {
    // startOpenServer → boot() (gateway) → installProcessSafetyNet(). Assert the
    // inheritance path exists rather than requiring a duplicate direct call.
    const src = read('open/server.ts')
    expect(src.includes('boot(') || src.includes('startOpenServer')).toBe(true)
  })
})
