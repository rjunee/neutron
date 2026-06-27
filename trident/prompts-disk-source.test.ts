import { describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  loadAgentSystemPrompt,
  PERSONA_AGENT_KINDS,
} from './agent-prompts.ts'
import {
  loadArgusTemplate,
  loadForgeTemplate,
  renderArgusPrompt,
  renderForgePrompt,
} from './prompts.ts'
import type { TridentRun } from './store.ts'

/**
 * P1-3 VERIFY — the Forge/Argus build-loop contract is now a SINGLE on-disk
 * source (`prompts/forge.md` / `prompts/argus.md`), not an inline string. The
 * lifted prompt files used to be dead code (the audit's "drift landmine":
 * editing the file the team reads changed nothing). These tests prove:
 *   1. on-disk file content actually reaches the spawned agent's prompt — an
 *      edited marker line in forge.md shows up in the rendered Forge prompt
 *      (the round-trip the brief's VERIFY asks for);
 *   2. all four dispatchable roles resolve their prompt from disk BY TYPE
 *      (forge/argus as the user-message contract; atlas/sentinel as the
 *      system persona).
 */

const FORGE_MD = fileURLToPath(new URL('../prompts/forge.md', import.meta.url))
const ARGUS_MD = fileURLToPath(new URL('../prompts/argus.md', import.meta.url))

function makeRun(over: Partial<TridentRun> = {}): TridentRun {
  return {
    id: 'r1',
    slug: 'add-widget',
    project_slug: 'proj',
    repo_path: '/repo',
    worktree: '/repo/.wt/add-widget',
    task: 'Add a widget',
    branch: 'trident/add-widget',
    phase: 'forge-init',
    round: 1,
    max_rounds: 8,
    merge_mode: 'pr',
    subagent_run_id: null,
    subagent_status: null,
    pr: null,
    ralph: false,
    failure_reason: null,
    created_at: new Date(0).toISOString(),
    last_advanced_at: new Date(0).toISOString(),
    ...over,
  } as TridentRun
}

describe('P1-3 — forge/argus contract is sourced from the on-disk prompt files', () => {
  test('the rendered Forge prompt is sourced from prompts/forge.md (a verbatim on-disk line shows up)', () => {
    // A line that exists ONLY in the on-disk forge.md body, not in the terse
    // degraded fallback — its presence proves the FILE reached the prompt.
    const onDiskLine =
      'CROSS-MODEL REVIEW (best-effort — NEVER a hang point)'
    expect(readFileSync(FORGE_MD, 'utf8')).toContain(onDiskLine)
    expect(renderForgePrompt(makeRun(), 'main')).toContain(onDiskLine)
  })

  test('editing a marker line in forge.md flows through to the spawned prompt (live single source)', () => {
    const original = readFileSync(FORGE_MD, 'utf8')
    const marker = 'NEUTRON_P1_3_DISK_SOURCE_MARKER_42'
    try {
      writeFileSync(FORGE_MD, `${original}\n${marker}\n`, 'utf8')
      // renderForgePrompt re-reads the file fresh, so the marker appears — the
      // exact drift-killer the lift delivers (the file the team edits IS what
      // the agent receives).
      expect(renderForgePrompt(makeRun(), 'main')).toContain(marker)
    } finally {
      writeFileSync(FORGE_MD, original, 'utf8')
    }
    // Restored: the marker is gone again.
    expect(renderForgePrompt(makeRun(), 'main')).not.toContain(marker)
  })

  test('the rendered Argus prompt is sourced from prompts/argus.md', () => {
    const onDiskRule =
      'NEVER exit silently. If you cannot complete the review'
    expect(readFileSync(ARGUS_MD, 'utf8')).toContain(onDiskRule)
    const out = renderArgusPrompt({
      branch: 'feat-x',
      pr_number: 42,
      round: 1,
      max_rounds: 8,
      base_branch: 'main',
      diff_line_count: 10,
    })
    expect(out).toContain(onDiskRule)
  })

  test('render still resolves the lowercase tokens (loadPrompt leaves them for fill())', () => {
    const out = renderForgePrompt(makeRun({ branch: 'feat-z' }), 'develop')
    expect(out).toContain('Feature branch (create + use this): feat-z')
    expect(out).toContain('Base branch: develop')
    // No unresolved render token survived.
    expect(out).not.toContain('{{repo_path}}')
    expect(out).not.toContain('{{branch}}')
  })
})

describe('P1-3 — all four roles resolve a non-empty prompt BY TYPE from disk', () => {
  test('forge + argus load their contract body from disk', () => {
    const forge = loadForgeTemplate()
    const argus = loadArgusTemplate()
    expect(forge.trim().length).toBeGreaterThan(0)
    expect(argus.trim().length).toBeGreaterThan(0)
    // The rich on-disk body, not the terse fallback.
    expect(forge).toContain('CROSS-MODEL REVIEW')
    expect(forge).toContain('PR_NUMBER=')
    expect(argus).toContain('APPROVE / REQUEST CHANGES')
  })

  test('atlas + sentinel load their persona from disk (source = file)', () => {
    for (const kind of PERSONA_AGENT_KINDS) {
      const got = loadAgentSystemPrompt(kind)
      expect(got.source).toBe('file')
      expect(got.content.trim().length).toBeGreaterThan(0)
    }
  })

  test('the four dispatchable roles are exactly {forge, argus, atlas, sentinel}', () => {
    // forge/argus drive the build loop (user-message contract); atlas/sentinel
    // are the persona dispatch path. Together they are the full role set the
    // dispatch closure serves — every one resolving its prompt from disk.
    const roles = new Set<string>(['forge', 'argus', ...PERSONA_AGENT_KINDS])
    expect([...roles].sort()).toEqual(['argus', 'atlas', 'forge', 'sentinel'])
  })
})
