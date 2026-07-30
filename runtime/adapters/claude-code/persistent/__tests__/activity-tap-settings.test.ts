/**
 * `buildSettings` — the ACTIVITY INSPECTOR tool tap's HOOK WIRING.
 *
 * A hook file that exists but is never named in a spawned session's `--settings` is
 * dead code, so these tests assert the actual generated JSON: the `PreToolUse` group,
 * the ADDITIONAL unscoped `PostToolUse` group, the baked env prefixes, and — the
 * subtle one — that wiring the tap does not clobber the pre-existing TodoWrite→board
 * `PostToolUse` group. It also pins the opt-in boundary: no `activityTap` config ⇒
 * neither key appears, byte-identical to before for the disposable Trident build
 * REPLs and the untrusted history-import REPL.
 */

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ACTIVITY_TAP_HOOK_PATH, buildSettings } from '../build-settings.ts'

interface HookGroup {
  matcher: string
  hooks: Array<{ type: string; command: string }>
}

function write(input: Parameters<typeof buildSettings>[0]): Record<string, HookGroup[]> {
  const dir = mkdtempSync(join(tmpdir(), 'act-tap-settings-'))
  const path = join(dir, 'settings.json')
  buildSettings({ ...input, settingsPath: path })
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { hooks: Record<string, HookGroup[]> }
  return parsed.hooks
}

const TAP = { sinkPort: 4242, sinkToken: 'tok-9', sessionId: 'sess-1' }
const TODO = { sinkPort: 4242, sinkToken: 'tok-9', sessionId: 'sess-1' }

describe('buildSettings — activity tap', () => {
  it('emits a PreToolUse group with an UNSCOPED matcher and the baked env', () => {
    const hooks = write({ settingsPath: '', activityTap: TAP })
    const pre = hooks['PreToolUse']
    expect(pre).toHaveLength(1)
    // Unscoped: every tool the agent touches must be reported, not just one.
    expect(pre?.[0]?.matcher).toBe('')
    const cmd = pre?.[0]?.hooks[0]?.command ?? ''
    expect(cmd).toContain('SINK_PORT=4242')
    expect(cmd).toContain('SINK_TOKEN=tok-9')
    expect(cmd).toContain('SESSION_ID=sess-1')
    expect(cmd).toContain('TAP_PHASE=pre')
    expect(cmd).toContain(ACTIVITY_TAP_HOOK_PATH)
  })

  it('emits a matching PostToolUse group with TAP_PHASE=post', () => {
    // Both phases: a `pre` with no matching `post` for minutes IS the hang signal.
    const hooks = write({ settingsPath: '', activityTap: TAP })
    const post = hooks['PostToolUse']
    expect(post).toHaveLength(1)
    expect(post?.[0]?.matcher).toBe('')
    expect(post?.[0]?.hooks[0]?.command).toContain('TAP_PHASE=post')
  })

  it('APPENDS to the TodoWrite PostToolUse group instead of replacing it', () => {
    // Regression guard: assigning `hooks['PostToolUse']` outright would silently
    // delete the TodoWrite→Work Board sync, breaking an unrelated shipped feature.
    const hooks = write({ settingsPath: '', todoSync: TODO, activityTap: TAP })
    const post = hooks['PostToolUse'] ?? []
    expect(post).toHaveLength(2)
    expect(post.map((g) => g.matcher)).toEqual(['TodoWrite', ''])
    expect(post[0]?.hooks[0]?.command).toContain('todo-sync.ts')
    expect(post[1]?.hooks[0]?.command).toContain('activity-tap.ts')
  })

  it('emits NEITHER key when no activityTap is supplied (the opt-in boundary)', () => {
    const hooks = write({ settingsPath: '' })
    expect(hooks['PreToolUse']).toBeUndefined()
    expect(hooks['PostToolUse']).toBeUndefined()
    // The Stop hook (the reply invariant) is untouched either way.
    expect(hooks['Stop']).toHaveLength(1)
  })

  it('a todoSync-only REPL keeps exactly its one TodoWrite group', () => {
    const hooks = write({ settingsPath: '', todoSync: TODO })
    expect(hooks['PreToolUse']).toBeUndefined()
    expect(hooks['PostToolUse']).toHaveLength(1)
    expect(hooks['PostToolUse']?.[0]?.matcher).toBe('TodoWrite')
  })

  it('honours a hookPath override so tests can point at a stub', () => {
    const hooks = write({
      settingsPath: '',
      activityTap: { ...TAP, hookPath: '/tmp/fake-tap.ts' },
    })
    expect(hooks['PreToolUse']?.[0]?.hooks[0]?.command).toContain('/tmp/fake-tap.ts')
    expect(hooks['PreToolUse']?.[0]?.hooks[0]?.command).not.toContain(ACTIVITY_TAP_HOOK_PATH)
  })
})
