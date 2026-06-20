/**
 * Shared test helpers for wow-moment action tests.
 *
 * The actions all consume a `WowActionContext` whose shape is wide. The
 * builder here returns a default-populated context with all the right
 * fakes wired so each test can override only the keys it cares about.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../../../migrations/runner.ts'
import { CronJobRegistry } from '../../../cron/jobs.ts'
import { CronStateStore } from '../../../cron/state.ts'
import { ProjectDb } from '../../../persistence/index.ts'
import { ReminderStore } from '../../../reminders/store.ts'
import type { ButtonPrompt } from '../../../channels/button-primitive.ts'
import type {
  BriefSubstrate,
  CapturedProject,
  GmailDraftClient,
  GmailScopeState,
  RitualEntry,
  StalledEmailThread,
  WowActionContext,
  WowChannelAdapter,
  WowInterviewState,
} from '../action-types.ts'
import type { ImportResult } from '../../history-import/types.ts'

export interface TestFixture {
  dir: string
  db: ProjectDb
  reminders: ReminderStore
  cron_jobs: CronJobRegistry
  cron_state: CronStateStore
  channelCalls: {
    prompts: Array<{ topic_id: string; prompt: ButtonPrompt }>
    texts: Array<{ topic_id: string; body: string }>
  }
  gmailCalls: {
    drafts: Array<{ to: string; subject: string; body: string }>
    sends: Array<{ to: string; subject: string; body: string }>
  }
}

export function makeFixture(): TestFixture {
  const dir = mkdtempSync(join(tmpdir(), 'wow-action-'))
  const db = ProjectDb.open(join(dir, 'project.db'))
  applyMigrations(db.raw())
  const reminders = new ReminderStore(db)
  const cron_jobs = new CronJobRegistry()
  const cron_state = new CronStateStore(db)
  const channelCalls = {
    prompts: [] as Array<{ topic_id: string; prompt: ButtonPrompt }>,
    texts: [] as Array<{ topic_id: string; body: string }>,
  }
  const gmailCalls = {
    drafts: [] as Array<{ to: string; subject: string; body: string }>,
    sends: [] as Array<{ to: string; subject: string; body: string }>,
  }
  return { dir, db, reminders, cron_jobs, cron_state, channelCalls, gmailCalls }
}

export function teardown(fix: TestFixture): void {
  fix.db.close()
  // Don't rmSync — bun test handles tmpdir cleanup eventually; if this
  // becomes a problem we add explicit cleanup, but per-test rm slows the
  // suite measurably.
}

export interface BuildCtxOverrides {
  project_slug?: string
  topic_id?: string
  interview?: WowInterviewState
  import_result?: ImportResult | null
  rituals?: RitualEntry[]
  captured_projects?: CapturedProject[]
  projects_confirmed?: boolean
  contemplative_keywords?: string[]
  stalled_threads?: StalledEmailThread[]
  gmail_scopes?: GmailScopeState | null
  gmail?: GmailDraftClient | null
  substrate?: BriefSubstrate
  now?: () => number
  uuid?: () => string
}

export function buildChannelAdapter(fix: TestFixture): WowChannelAdapter {
  return {
    async emitPrompt(input) {
      fix.channelCalls.prompts.push({ topic_id: input.topic_id, prompt: input.prompt })
      return { prompt_id: input.prompt.prompt_id }
    },
    async sendText(input) {
      fix.channelCalls.texts.push({ topic_id: input.topic_id, body: input.body })
      return { message_id: `msg-${fix.channelCalls.texts.length}` }
    },
  }
}

export function buildRecordingGmail(fix: TestFixture): GmailDraftClient {
  return {
    async createDraft(input) {
      fix.gmailCalls.drafts.push(input)
      return {
        draft_id: `draft-${fix.gmailCalls.drafts.length}`,
        gmail_open_url: `https://mail.google.com/draft/${fix.gmailCalls.drafts.length}`,
      }
    },
  }
}

export function buildContext(
  fix: TestFixture,
  overrides: BuildCtxOverrides = {},
): WowActionContext {
  const project_slug = overrides.project_slug ?? 't1'
  const topic_id = overrides.topic_id ?? 'topic-1'
  let counter = 0
  const ctx: WowActionContext = {
    project_slug,
    topic_id,
    owner_home: fix.dir,
    interview: overrides.interview ?? {
      display_name: 'Alice',
      archetype_blend: ['Athena'],
      phase_state_json: {},
    },
    import_result: overrides.import_result ?? null,
    rituals: overrides.rituals ?? [],
    captured_projects: overrides.captured_projects ?? [],
    contemplative_keywords: overrides.contemplative_keywords ?? [],
    stalled_threads: overrides.stalled_threads ?? [],
    gmail_scopes: overrides.gmail_scopes ?? null,
    reminders: fix.reminders,
    cron_jobs: fix.cron_jobs,
    cron_state: fix.cron_state,
    db: fix.db,
    channel: buildChannelAdapter(fix),
    gmail: overrides.gmail ?? null,
    now: overrides.now ?? ((): number => 1_700_000_000_000),
    uuid: overrides.uuid ?? ((): string => `uuid-${++counter}`),
  }
  if (overrides.substrate !== undefined) ctx.substrate = overrides.substrate
  if (overrides.projects_confirmed !== undefined) {
    ctx.projects_confirmed = overrides.projects_confirmed
  }
  return ctx
}

/** Build a UUID factory that produces canonical 36-char UUIDs. */
export function deterministicUuid(prefix: string): () => string {
  let n = 0
  return (): string => {
    n += 1
    const hex = n.toString(16).padStart(8, '0')
    return `${hex.slice(0, 8)}-${hex.slice(0, 4)}-4${hex.slice(0, 3)}-8${hex.slice(0, 3)}-${hex.padEnd(12, '0')}`
  }
}
