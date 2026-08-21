/**
 * Production-composition acceptance for the email pipeline.
 *
 * Unit tests for `email-pipeline-wiring.ts` only prove that the module works
 * when called. This drives the real `buildCoreModules` tasks initializer so a
 * future edit that leaves the module present but severs its invocation fails.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildSeededInMemoryGmailClient } from '@neutronai/email-managed-core'
import type { GmailClient } from '@neutronai/email-managed-core/backend'
import { seedMigratedDb } from '../../tests/support/migrated-db.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import { STUB_PLATFORM } from '@neutronai/runtime/__tests__/stub-platform.ts'
import { buildCoreModules } from './build-core-modules.ts'
import type { CompositionInput } from './input/composition-input.ts'
import type { ModuleContext } from '../module-graph.ts'
import {
  EMAIL_PIPELINE_POLL_HANDLER_NAME,
  EMAIL_PIPELINE_POLL_JOB_NAME,
} from '../cores/email-pipeline-wiring.ts'

describe('buildCoreModules email pipeline invocation', () => {
  let home: string
  let db: ProjectDb

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'email-pipeline-composition-'))
    seedMigratedDb(join(home, 'project.db'))
    db = ProjectDb.open(join(home, 'project.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(home, { recursive: true, force: true })
  })

  test('the tasks initializer invokes the wiring and registers the poll job', async () => {
    const input: CompositionInput = {
      db,
      project_slug: 'instance',
      topic_handler: async () => {},
      approval_notifier: { notify: async () => undefined },
      watchdog_notifier: { notify: async () => undefined },
      reminder_dispatcher: { dispatch: async () => undefined },
      heartbeat_tracker: { lastHeartbeatAt: () => Date.now() },
      platform: STUB_PLATFORM,
      email_pipeline: {
        gmail: buildSeededInMemoryGmailClient() as GmailClient,
        owner_home: home,
        project_slug: 'instance',
        deliver: async () => ({ prompt_id: null, persisted: true, delivered_live: false }),
        escalation_topic_id: 'app:owner',
        push: null,
        llm: null,
      },
    }
    const modules = buildCoreModules(input)
    const cron = await Promise.resolve(modules.cronModule.init({} as ModuleContext))
    const context: ModuleContext = {
      graph: {
        get: ((name: string) => {
          if (name === 'cron') return cron
          if (name === 'reminders') return { store: {} as never }
          return { async send(): Promise<string> { return 'message-id' } }
        }) as never,
        names: () => ['cron', 'reminders', 'channels'],
      },
      config: {},
    }

    const tasks = await Promise.resolve(modules.tasksModule.init(context))
    try {
      expect(cron.jobs.get(EMAIL_PIPELINE_POLL_JOB_NAME)?.handler).toBe(
        EMAIL_PIPELINE_POLL_HANDLER_NAME,
      )
      expect(cron.handlers.get(EMAIL_PIPELINE_POLL_HANDLER_NAME)).toBeDefined()
    } finally {
      await modules.tasksModule.shutdown?.(tasks)
      await modules.cronModule.shutdown?.(cron)
    }
  })
})
