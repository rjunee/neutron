/**
 * P11 (world-class refactor, 2026-07) — corrupt-policy pin for the
 * `button_prompts.options_json` codec routing.
 *
 * `rowToHistoryTurn` now decodes `options_json` through the shared
 * `parseJsonColumn` codec (persistence/sidecar.ts) instead of a hand-rolled
 * `JSON.parse`. This test pins the column's PRE-EXISTING log+fallback
 * corrupt-policy BYTE-FOR-BYTE: a malformed `options_json` on a RESOLVED row
 * emits a `console.warn` and falls the rendered `resolution_text` back to the
 * raw `resolution_value` (rather than blanking the chat or throwing).
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { buildButtonPrompt, type ButtonChoice, type ButtonPrompt } from '../button-primitive.ts'
import { ButtonStore } from '../button-store.ts'

let tmp: string
let db: ProjectDb
let store: ButtonStore
const NOW = 1_000_000

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'neutron-p11-button-'))
  db = ProjectDb.open(join(tmp, 'project.db'))
  applyMigrations(db.raw())
  store = new ButtonStore({ db, now: () => NOW })
})

afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

function samplePrompt(): ButtonPrompt {
  // body != value so a healthy decode renders the option BODY ("Apple"),
  // while a corrupt decode falls back to the raw value ("a") — distinguishable.
  return buildButtonPrompt({
    body: 'Pick a fruit',
    options: [
      { label: 'A', body: 'Apple', value: 'a' },
      { label: 'B', body: 'Banana', value: 'b' },
    ],
  })
}

function choice(prompt: ButtonPrompt, value: string): ButtonChoice {
  return {
    prompt_id: prompt.prompt_id,
    choice_value: value,
    chosen_at: 2_000_000,
    speaker_user_id: 'user-1',
    channel_kind: 'telegram',
  }
}

async function readTurnText(promptId: string): Promise<string | null> {
  const { turns } = await store.listHistoryByTopic({
    topic_id: 'topic-1',
    before: 3_000_000,
    before_prompt_id: null,
    limit: 10,
    now: 3_000_000,
  })
  const turn = turns.find((t) => t.prompt_id === promptId)
  return turn?.resolution_text ?? null
}

test('parse-ok: a healthy options_json renders the matched option body', async () => {
  const prompt = samplePrompt()
  await store.emit(prompt, { topic_id: 'topic-1' })
  await store.resolve({ choice: choice(prompt, 'a') })
  expect(await readTurnText(prompt.prompt_id)).toBe('Apple')
})

test('corrupt-policy: malformed options_json warns and falls back to the raw resolution_value', async () => {
  const prompt = samplePrompt()
  await store.emit(prompt, { topic_id: 'topic-1' })
  await store.resolve({ choice: choice(prompt, 'a') })

  // Poison the column on the resolved row.
  await db.run(`UPDATE button_prompts SET options_json = '{oops' WHERE prompt_id = ?`, [
    prompt.prompt_id,
  ])

  const warnings: unknown[][] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]): void => {
    warnings.push(args)
  }
  try {
    // Does NOT throw; falls back to the raw resolution_value ("a").
    const text = await readTurnText(prompt.prompt_id)
    expect(text).toBe('a')
  } finally {
    console.warn = originalWarn
  }
  // The policy's warn side-effect fired exactly once for the corrupt row.
  expect(warnings.length).toBe(1)
  expect(String(warnings[0]?.[0] ?? '')).toContain('corrupt options_json')
})
