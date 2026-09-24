import { describe, expect, test } from 'bun:test'
import { deriveClaimedPaths } from './claimed-paths.ts'

describe('deriveClaimedPaths', () => {
  const evidence = 'open/__tests__/project-build-e2e.test.ts, trident/tsconfig.json and scripts/ci/typecheck-all.sh'
  test('read-only E2E, config, scripts and filename verbs acquire no ownership', () => {
    for (const task of [
      `Run ${evidence}`, `Inspect ${evidence}`, `Review ${evidence}`,
      'Run `bun test open/__tests__/project-build-e2e.test.ts`, `tsc -p trident/tsconfig.json`, and `bash scripts/ci/typecheck-all.sh`.',
      'Tests: run the build checks in open/__tests__/project-build-e2e.test.ts and trident/tsconfig.json.',
      'Run `bun run build` with `trident/tsconfig.json`.',
      'Inspect `pkg/edit-handler.ts` and pkg/create-handler.ts.',
      'Do not edit; run open/__tests__/project-build-e2e.test.ts.',
    ]) expect(deriveClaimedPaths({ task })).toEqual([])
  })

  test('explicit writes retain exact claims including slash-joined verbs', () => {
    for (const verb of ['Edit', 'Create', 'Update', 'Remove', 'Edit/update', 'Create/edit']) {
      expect(deriveClaimedPaths({ task: `${verb} ${evidence}` })).toEqual([
        'open/__tests__/project-build-e2e.test.ts', 'trident/tsconfig.json', 'scripts/ci/typecheck-all.sh',
      ])
      expect(deriveClaimedPaths({ task: `${verb} trident/new-store.ts` })).toEqual(['trident/new-store.ts'])
    }
  })

  for (const [task, paths, sibling] of [
    ['Run tests before you edit trident/store.ts', ['trident/store.ts'], 'Run tests before inspect trident/store.ts'],
    ['Review the plan before you create trident/new-store.ts', ['trident/new-store.ts'], 'Review the plan before inspect trident/new-store.ts'],
    ['Check the result then carefully move trident/store.ts to trident/new-store.ts', ['trident/store.ts', 'trident/new-store.ts'], 'Check the result then inspect trident/store.ts and trident/new-store.ts'],
    ['Run checks and with previously unseen filler edit/update trident/store.ts', ['trident/store.ts'], 'Inspect trident/store.ts'],
    ['Do not edit trident/store.ts, but with due care edit trident/new-store.ts', ['trident/new-store.ts'], 'Do not edit trident/store.ts, but inspect trident/new-store.ts'],
    ['Add a test in trident/store.test.ts', ['trident/store.test.ts'], 'Run trident/store.test.ts'],
    ['Update the test in trident/store.test.ts', ['trident/store.test.ts'], 'Inspect trident/store.test.ts'],
    ['Edit the read helper in trident/store.ts', ['trident/store.ts'], 'Read trident/store.ts'],
    ['Edit the test and read helpers in trident/store.ts', ['trident/store.ts'], 'Review trident/store.ts'],
    ['Edit and test trident/store.ts', ['trident/store.ts'], 'Run trident/store.ts'],
  ] as const) {
    test(`instruction scope: ${task}`, () => {
      expect(deriveClaimedPaths({ task })).toEqual([...paths])
      expect(deriveClaimedPaths({ task: sibling })).toEqual([])
    })
  }

  test('complete read clauses omit only their paths across clear boundaries', () => {
    for (const separator of ['; ', '. ', ', then ', ' then ', ' before ', ' after ']) {
      expect(deriveClaimedPaths({ task: `Edit trident/store.ts${separator}run ${evidence}` })).toEqual(['trident/store.ts'])
      expect(deriveClaimedPaths({ task: `Run ${evidence}${separator}create trident/new-store.ts` })).toEqual(['trident/new-store.ts'])
    }
    expect(deriveClaimedPaths({ task: 'Do not edit trident/store.ts; Do not change trident/tick.ts; create trident/new-store.ts' })).toEqual(['trident/new-store.ts'])
  })

  test('unknown and ambiguous prose conservatively claims every recognized path', () => {
    for (const task of [
      'Run trident/store.ts and edit trident/tick.ts',
      'Edit trident/store.ts and run trident/tick.ts',
      'Edit trident/store.ts without touching trident/tick.ts',
      'Edit trident/store.ts and the read helper in trident/tick.ts',
      'Do not edit trident/store.ts or change trident/tick.ts',
      'Unfamiliar prose about trident/store.ts and trident/tick.ts',
    ]) expect(deriveClaimedPaths({ task })).toEqual(['trident/store.ts', 'trident/tick.ts'])
    expect(deriveClaimedPaths({ task: 'Run tests before you inspect trident/store.ts' })).toEqual(['trident/store.ts'])
    expect(deriveClaimedPaths({ task: 'Read-only check: run trident/store.ts and edit trident/tick.ts' })).toEqual(['trident/store.ts', 'trident/tick.ts'])
  })

  test('sanitized General controls task and plan with explicit reference clauses claim only app writes', () => {
    // Equivalent scope to #1293, with narrative references explicitly marked.
    // The original live prose is NOT claimed to satisfy this narrow grammar.
    const task = [
      'Fix General native controls null scope.',
      'Edit app/lib/native-owner-control-client.ts to repair read validation, action serialization and routing.',
      'Edit app/__tests__/native-owner-control.test.tsx to cover General approval and interrupt succeeding.',
      'Read-only reference: app/components/NativeOwnerControl.tsx.',
      'Read-only check: Do not edit open/__tests__/project-build-e2e.test.ts; run it.',
      'Read-only check: Do not edit trident/tsconfig.json; run tsc -p trident/tsconfig.json.',
      'Read-only check: Do not edit scripts/ci/typecheck-all.sh; run it.',
      'Read-only reference: Do not edit gateway/http/app-native-owner-control-surface.ts.',
    ].join('\n')
    const planDoc = [
      '# Write scope',
      '- app/lib/native-owner-control-client.ts',
      '- app/__tests__/native-owner-control.test.tsx',
      'Read-only reference: `SPEC.md:338` and docs/spec-items/project-herdr-workspaces.md:17.',
      'Read-only reference: gateway/http/app-native-owner-control-surface.ts:33.',
      '- Do not edit open/__tests__/project-build-e2e.test.ts; run it.',
      '- Do not edit trident/tsconfig.json; run tsc -p trident/tsconfig.json.',
      '- Do not edit scripts/ci/typecheck-all.sh; run it.',
    ].join('\n')
    expect(deriveClaimedPaths({ task, planDoc })).toEqual(['app/lib/native-owner-control-client.ts', 'app/__tests__/native-owner-control.test.tsx'])
  })

  test('accepted ranges preserve offsets, lexical order, line refs and filename verbs', () => {
    expect(deriveClaimedPaths({ task: '🛠 Edit pkg/run-and-edit.ts:12:4 and `SPEC.md`, then `pkg/create.ts` and pkg/run-and-edit.ts.' })).toEqual(['pkg/run-and-edit.ts', 'SPEC.md', 'pkg/create.ts'])
  })
  test('extracts a bare repo-relative path from prose', () => {
    const paths = deriveClaimedPaths({
      task: 'The publish step in trident/inner-workflow.mjs trims the replay patch.',
    })
    expect(paths).toContain('trident/inner-workflow.mjs')
  })

  test('extracts a backticked path', () => {
    const paths = deriveClaimedPaths({ task: 'Add the gates to `trident/board-dispatch.ts`.' })
    expect(paths).toContain('trident/board-dispatch.ts')
  })

  test('ignores URLs — a link is not a file', () => {
    const paths = deriveClaimedPaths({ task: 'See https://a.b/c.d for the rationale.' })
    expect(paths).toEqual([])
  })

  test('ignores version-ish tokens (no slash, no known extension)', () => {
    const paths = deriveClaimedPaths({ task: 'Bump the pinned toolchain to v1.2.3 before building.' })
    expect(paths).not.toContain('v1.2.3')
    expect(paths).toEqual([])
  })

  test('rejects absolute paths and parent escapes', () => {
    const paths = deriveClaimedPaths({
      task: 'Do not read /etc/passwd.txt nor ../secrets/keys.json from here.',
    })
    expect(paths).toEqual([])
  })

  test('dedupes across the task and the plan doc, preserving first-seen order', () => {
    const paths = deriveClaimedPaths({
      task: 'Edit trident/store.ts then trident/tick.ts.',
      planDoc: 'Also `trident/store.ts` — same file, second mention.',
    })
    expect(paths).toEqual(['trident/store.ts', 'trident/tick.ts'])
  })

  test('strips trailing sentence punctuation and a leading ./', () => {
    const paths = deriveClaimedPaths({ task: 'Touch ./work-board/store.ts, then stop.' })
    expect(paths).toEqual(['work-board/store.ts'])
  })

  test('caps at 64 paths', () => {
    const task = `Edit ${Array.from({ length: 100 }, (_, i) => `pkg/file${i}.ts`).join(' ')}`
    expect(deriveClaimedPaths({ task })).toHaveLength(64)
  })

  test('does not claim guard rails, package specifiers, directories, or incidental references', () => {
    expect(deriveClaimedPaths({
      task: 'Avoid `trident/inner-workflow.mjs` entirely. Import @neutronai/logger. See docs/AS_BUILT.md.',
    })).toEqual([])
    expect(deriveClaimedPaths({ task: 'Edit docs/as-built/ and `@neutronai/logger`.' })).toEqual([])
  })

  test('normalizes line references and extracts lists as distinct claims', () => {
    expect(deriveClaimedPaths({
      task: 'Update `trident/store.ts and trident/tick.ts`, plus gateway/composition/build-core-modules.ts:621,work-board/store.ts.',
    })).toEqual([
      'trident/store.ts',
      'trident/tick.ts',
      'gateway/composition/build-core-modules.ts',
      'work-board/store.ts',
    ])
  })

  test('empty input derives nothing (and therefore can never hold a dispatch)', () => {
    expect(deriveClaimedPaths({ task: '' })).toEqual([])
    expect(deriveClaimedPaths({ task: 'ship the thing', planDoc: null })).toEqual([])
  })

  test('repetition inside a claim span is trimmed, and an oversized span is ignored', () => {
    // CodeQL flagged two HIGH polynomial-ReDoS patterns in the first cut of this
    // file: `/[.,;:)\]}]+$/` on a run of `)`, and `/\s+(?:and|or)\s+|\s*,\s*/i`
    // on a run of spaces. Both were rewritten as linear scans.
    //
    // I first wrote this as a TIMING test with 50k-character inputs. It failed,
    // and the reason is the useful part: `BACKTICKED` is capped at `{1,200}`, so
    // an oversized span never matches at all and the derivation returns []. The
    // quadratic patterns were therefore never reachable with an input large
    // enough to hurt — the cap was the real bound the whole time. A timing
    // assertion at 200 characters would separate nothing, so this pins the two
    // things that ARE true and load-bearing instead.
    const parens = ')'.repeat(60)
    expect(deriveClaimedPaths({ task: `edit \`trident/store.ts${parens}\`` })).toEqual([
      'trident/store.ts',
    ])
    expect(deriveClaimedPaths({ task: 'edit `trident/store.ts   and    trident/tick.ts`' })).toEqual(
      ['trident/store.ts', 'trident/tick.ts'],
    )
    // The cap itself, pinned: raise it and this fails, which is the reminder
    // that the linear rewrites are what keep that safe to do.
    expect(deriveClaimedPaths({ task: `edit \`${'x'.repeat(200)}/store.ts\`` })).toEqual([])
  })
})
