import { describe, expect, test } from 'bun:test'

import type { Event } from '../../events.ts'
import { startCodexExec } from './exec.ts'

async function collect(gen: AsyncGenerator<Event, void, void>): Promise<Event[]> {
  const out: Event[] = []
  for await (const e of gen) out.push(e)
  return out
}

describe('codex-cli exec spawn-error handling (Codex r1 P2 fix)', () => {
  test('missing binary surfaces a clean substrate error event, not an unhandled process error', async () => {
    const events = await collect(
      startCodexExec({
        prompt: 'hi',
        spawn_env: {},
        signal: new AbortController().signal,
        bin: '/this/path/does/not/exist/codex-binary',
      }),
    )
    const err = events.find((e) => e.kind === 'error')
    expect(err?.kind).toBe('error')
    if (err?.kind === 'error') {
      expect(err.message).toMatch(/codex (spawn failed|child error|exec exited)/)
    }
  })
})
