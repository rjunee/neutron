/**
 * Item 5 (post-onboarding experience, ISSUES #208) — FREE-FORM project
 * opening message.
 *
 * Per docs/plans/project-opening-message-redesign-2026-06-10.md +
 * docs/plans/post-onboarding-experience-spec-2026-06-10.md § ITEM 5:
 * each project's opening message must be an LLM-GENERATED, free-form,
 * BUTTON-LESS bubble —
 *
 *   1. a free-form paragraph telling the user what the project IS,
 *      synthesized from the project's MATERIALIZED docs (Item 4:
 *      Projects/<slug>/README.md + docs/transcript-summary.md) with the
 *      import_result as fallback signal;
 *   2. exactly ONE next move (suggested action OR a reminder offer OR
 *      "What would you like to do next?");
 *   3. NO buttons at all — `options: []`, `allow_freeform: true`; the
 *      user just types.
 *
 * REPRODUCE-FIRST: this file is RED on pre-Item-5 main, where
 * `emitProjectSeeds` emits the templated rationale + the Summarise-X /
 * Tell-me-what-you-know / Not-now button wall and has no
 * `composeProjectOpening` / `readProjectDoc` seams at all.
 */

import { afterEach, beforeEach, describe, expect, test, mock } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigrations } from '../../../migrations/runner.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { ButtonStore } from '../../../channels/button-store.ts'
import {
  buildOnboardingHandoffHook,
  OPENING_MESSAGE_MAX_CHARS,
  type ComposeProjectOpeningFn,
  type ComposeProjectOpeningInput,
} from '../build-onboarding-handoff.ts'
import type { ImportResult } from '../../../onboarding/history-import/types.ts'

let tmp: string
let db: ProjectDb
let buttonStore: ButtonStore

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-opening-message-'))
  db = ProjectDb.open(join(tmp, 'owner.db'))
  applyMigrations(db.raw())
  buttonStore = new ButtonStore({ db, now: () => 1_700_000_000_500 })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function makeImportResult(
  proposed_projects: Array<{ name: string; rationale: string; suggested_topics: string[] }>,
): ImportResult {
  return {
    entities: [],
    topics: [],
    proposed_projects,
    proposed_tasks: [],
    proposed_reminders: [],
    voice_signals: {} as ImportResult['voice_signals'],
    facts: { user_role: 'Founder', companies: ['Acme'], key_people: ['Casey'] },
  }
}

const README_BODY = [
  '# Acme',
  '',
  'Acme is your DTC skincare venture with Casey: brand launch is two',
  'weeks out, the convertible note negotiation is the live legal thread,',
  'and the operating agreement still needs counter-signature.',
].join('\n')

const SUMMARY_BODY = [
  '# Transcript summary - Acme',
  '',
  'Key decisions: the note converts at a $8M cap. Open threads: operating',
  'agreement counter-signature, launch-week retail samples.',
].join('\n')

async function readSeed(topic_id: string) {
  const history = await buttonStore.listHistoryByTopic({
    topic_id,
    before: 1_700_000_001_000,
    before_prompt_id: null,
    limit: 5,
    now: 1_700_000_001_000,
  })
  expect(history.turns).toHaveLength(1)
  const prompt = await buttonStore.get(history.turns[0]!.prompt_id, 1_700_000_001_000)
  expect(prompt).not.toBeNull()
  return prompt!
}

describe('Item 5 — free-form LLM project opening message (no buttons)', () => {
  test('matched project: opening is the LLM-composed body sourced from the materialized docs, with ZERO options', async () => {
    const seen: ComposeProjectOpeningInput[] = []
    const composer: ComposeProjectOpeningFn = mock(async (input: ComposeProjectOpeningInput) => {
      seen.push(input)
      return {
        body:
          `${input.name} is your skincare venture with Casey - the convertible note is the live thread and launch is two weeks out.\n\n` +
          'Want me to pull together where the convertible note landed and what is still open?',
      }
    })
    const docReads: Array<{ slug: string; relpath: string }> = []
    const readProjectDoc = (slug: string, relpath: string): string | null => {
      docReads.push({ slug, relpath })
      if (slug !== 'acme') return null
      if (relpath === 'README.md') return README_BODY
      if (relpath === join('docs', 'transcript-summary.md')) return SUMMARY_BODY
      return null
    }
    const hook = buildOnboardingHandoffHook({
      buttonStore,
      composeProjectOpening: composer,
      readProjectDoc,
    })
    await hook.emitProjectSeeds({
      project_slug: 'sam',
      user_id: 'u-1',
      primary_projects: ['Acme'],
      import_result: makeImportResult([
        {
          name: 'Acme',
          rationale: '84 LLC mentions plus 67 brand mentions.',
          suggested_topics: ['acme-convertible-note'],
        },
      ]),
      observed_at: 1_700_000_000_000,
    })
    const seed = await readSeed('web:u-1:acme')
    // THE Item 5 contract — no button wall, free-typed reply only.
    expect(seed.options).toHaveLength(0)
    expect(seed.allow_freeform).toBe(true)
    // The body is the LLM composition (paragraph + single next-move),
    // NOT the old templated rationale + "Want me to summarise X?" shape.
    expect(seed.body).toContain('skincare venture with Casey')
    expect(seed.body).toContain('Want me to pull together')
    expect(seed.body).not.toContain('Want me to summarise')
    // The composer received the MATERIALIZED project docs as its
    // primary source (Item 4 read-path), not just the import row.
    expect(seen).toHaveLength(1)
    expect(seen[0]!.project_docs.readme).toContain('convertible note negotiation')
    expect(seen[0]!.project_docs.transcript_summary).toContain('$8M cap')
    expect(seen[0]!.imported_project?.rationale).toContain('84 LLC mentions')
    // And the docs came off the per-project repo paths.
    expect(docReads).toContainEqual({ slug: 'acme', relpath: 'README.md' })
    expect(docReads).toContainEqual({
      slug: 'acme',
      relpath: join('docs', 'transcript-summary.md'),
    })
  })

  test('skipped-import project (no signal, no docs): free-form fallback prose, still ZERO options', async () => {
    const hook = buildOnboardingHandoffHook({ buttonStore })
    await hook.emitProjectSeeds({
      project_slug: 'sam',
      user_id: 'u-2',
      primary_projects: ['LA Property'],
      import_result: null,
      observed_at: 1_700_000_000_000,
    })
    const seed = await readSeed('web:u-2:la-property')
    // No 2-button [A]/[B] fallback wall any more — prose only.
    expect(seed.options).toHaveLength(0)
    expect(seed.allow_freeform).toBe(true)
    // § 4.4 no-history voice: tell me what it is + what to track.
    expect(seed.body).toContain('LA Property')
    expect(seed.body.toLowerCase()).toContain('tell me what it is')
    expect(seed.body.toLowerCase()).toContain('track')
  })

  test('composer throws: deterministic free-form fallback ships (never empty, never buttons)', async () => {
    const composer: ComposeProjectOpeningFn = async () => {
      throw new Error('synthetic LLM outage')
    }
    const hook = buildOnboardingHandoffHook({
      buttonStore,
      composeProjectOpening: composer,
    })
    await hook.emitProjectSeeds({
      project_slug: 'sam',
      user_id: 'u-3',
      primary_projects: ['Topline'],
      import_result: makeImportResult([
        {
          name: 'Topline',
          rationale: 'The Topline JV cash flow is the highest-leverage thread.',
          suggested_topics: ['Topline JV threads'],
        },
      ]),
      observed_at: 1_700_000_000_000,
    })
    const seed = await readSeed('web:u-3:topline')
    expect(seed.options).toHaveLength(0)
    expect(seed.body.length).toBeGreaterThan(0)
    // Deterministic fallback still reads from the import rationale.
    expect(seed.body).toContain('cash flow')
  })

  test('runaway composer body is clamped to OPENING_MESSAGE_MAX_CHARS', async () => {
    const composer: ComposeProjectOpeningFn = async () => ({
      body: `${'A long sentence about the project. '.repeat(120)}`,
    })
    const hook = buildOnboardingHandoffHook({
      buttonStore,
      composeProjectOpening: composer,
    })
    await hook.emitProjectSeeds({
      project_slug: 'sam',
      user_id: 'u-4',
      primary_projects: ['Topline'],
      import_result: makeImportResult([
        { name: 'Topline', rationale: 'Cash flow.', suggested_topics: [] },
      ]),
      observed_at: 1_700_000_000_000,
    })
    const seed = await readSeed('web:u-4:topline')
    expect(OPENING_MESSAGE_MAX_CHARS).toBe(700)
    expect(seed.body.length).toBeLessThanOrEqual(OPENING_MESSAGE_MAX_CHARS)
    expect(seed.options).toHaveLength(0)
  })

  test('em dashes in the composed body are normalized to hyphens (hard rule)', async () => {
    const composer: ComposeProjectOpeningFn = async () => ({
      body: 'Topline is the JV — cash flow is the live thread.\n\nWhat would you like to do next?',
    })
    const hook = buildOnboardingHandoffHook({
      buttonStore,
      composeProjectOpening: composer,
    })
    await hook.emitProjectSeeds({
      project_slug: 'sam',
      user_id: 'u-5',
      primary_projects: ['Topline'],
      import_result: makeImportResult([
        { name: 'Topline', rationale: 'Cash flow.', suggested_topics: [] },
      ]),
      observed_at: 1_700_000_000_000,
    })
    const seed = await readSeed('web:u-5:topline')
    expect(seed.body).not.toContain('—')
    expect(seed.body).toContain('Topline is the JV - cash flow')
  })

  test('default doc reader: owner_home wired → composer reads the real Projects/<slug>/ docs off disk', async () => {
    const ownerHome = join(tmp, 'project-home')
    const projectRoot = join(ownerHome, 'Projects', 'acme')
    mkdirSync(join(projectRoot, 'docs'), { recursive: true })
    writeFileSync(join(projectRoot, 'README.md'), README_BODY, 'utf8')
    writeFileSync(join(projectRoot, 'docs', 'transcript-summary.md'), SUMMARY_BODY, 'utf8')
    const seen: ComposeProjectOpeningInput[] = []
    const composer: ComposeProjectOpeningFn = async (input) => {
      seen.push(input)
      return { body: 'Disk-backed opening.\n\nWhat would you like to do next?' }
    }
    const hook = buildOnboardingHandoffHook({
      buttonStore,
      composeProjectOpening: composer,
      owner_home: ownerHome,
    })
    await hook.emitProjectSeeds({
      project_slug: 'sam',
      user_id: 'u-6',
      primary_projects: ['Acme'],
      import_result: null,
      observed_at: 1_700_000_000_000,
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.project_docs.readme).toContain('convertible note negotiation')
    expect(seen[0]!.project_docs.transcript_summary).toContain('$8M cap')
    const seed = await readSeed('web:u-6:acme')
    expect(seed.body).toContain('Disk-backed opening.')
    expect(seed.options).toHaveLength(0)
  })
})
