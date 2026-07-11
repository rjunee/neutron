/**
 * Characterization snapshot for the Open composition (C3a guard).
 *
 * This is the ground-truth guard the whole C3a→C3d `open/composer.ts` carve
 * series leans on. It boots the REAL Open composer with a capturing fake
 * `substrateFactory` (credentialed → substrates actually build) and pins:
 *
 *   1. The EXACT set of `CompositionInput` field KEYS Open sets. Any carve that
 *      silently adds/drops/renames a composition field trips this immediately.
 *   2. The build-time substrate dispatch: exactly ONE `cc-llm-*` pre-warm fires
 *      at boot, and it does NOT carry `enableToolBridge` (only `cc-agent-*` does
 *      — that substrate is lazy and never dispatches at build, so its flag is
 *      pinned by the focused `wireSubstrates` unit test instead).
 *
 * Captured against the pre-carve composer as ground truth, and MUST stay green
 * across every carve unit. It asserts real wiring, not phase-machine bookkeeping.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyMigrations } from '@neutronai/migrations/runner.ts'
import { ProjectDb } from '@neutronai/persistence/index.ts'
import type { SessionHandle } from '@neutronai/runtime/session-handle.ts'
import type { Event } from '@neutronai/runtime/events.ts'
import type { Substrate } from '@neutronai/runtime/substrate.ts'
import type { ClaudeCodeSubstrateOptions } from '@neutronai/runtime/adapters/claude-code/index.ts'
import { buildOpenGraphComposer } from '../composer.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANDING_DIR = join(HERE, '..', '..', 'landing')

/**
 * The exact `CompositionInput` field-key set the Open COMPOSER assigns
 * (single-owner boot, one credential present), as returned by `composer(...)`.
 * Frozen here as the carve's characterization anchor.
 *
 * NOTE: `cores_surface` / `cores_integrations_surface` are intentionally ABSENT
 * — those two surfaces are appended LATER, by `composeProductionGraph` when it
 * mounts the running cores, not by the composer closure the C3a-d carve
 * touches. This snapshot pins the composer's OWN output, so it stays light (no
 * production graph / cron schedulers) and does not race the async cores mount.
 */
const EXPECTED_COMPOSITION_KEYS = [
  'agent_dispatch',
  'app_codex_credential_surface',
  // O5 — read-only diagnostics surface (`GET /api/app/admin/diagnostics`).
  'app_diagnostics_surface',
  'app_docs_surface',
  'app_project_credentials_surface',
  'app_projects_surface',
  'app_tabs_surface',
  'app_tasks_surface',
  'app_upload_surface',
  'app_work_board_surface',
  'app_ws_surface',
  'approval_notifier',
  // C5b — Open now supplies the single-owner gate through the unified
  // `composition.auth_gate` seam (both modes flow through ONE seam) instead of
  // wiring `openFetch` as `landing_server.fetch`.
  'auth_gate',
  'chat_history_surface',
  'chat_topics_surface',
  'chunked_upload_handler',
  'codex_credential',
  'cores',
  'create_project',
  'cron_jobs',
  'db',
  'doc_search',
  'heartbeat_tracker',
  'import_resume_handler',
  'import_upload_handler',
  'landing_server',
  // RA5 — the memory-recall composition field is the backend-neutral
  // `memory_search` (renamed from `gbrain_search`; same MemoryStore wiring).
  'memory_search',
  'message_search',
  // F4 — the gateway-tick hook that pulses the supervision-watchdog heartbeat.
  'on_gateway_tick',
  'onboarding_import_running_cron',
  'platform',
  'project_slug',
  'realmode_cleanups',
  'reminder_dispatcher',
  'skill_forge',
  'tasks',
  'topic_handler',
  'trident',
  'trident_build_dispatch',
  // F4 — the credential pool the substrate_cooldown_saturation detector watches
  // (present when an LLM pool resolved; this characterization sets ANTHROPIC_API_KEY).
  'watchdog_credential_pool',
  'watchdog_notifier',
  'work_board',
] as const

const SAVED_ENV_KEYS = [
  'NEUTRON_HOME',
  'OWNER_HOME',
  'NEUTRON_DB_PATH',
  'NEUTRON_INSTANCE_SLUG',
  'NEUTRON_LANDING_STATIC_DIR',
  'NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'NOTIFY_SOCKET',
] as const

let savedEnv: Record<string, string | undefined> = {}
let tmpDir: string | undefined

beforeEach(() => {
  savedEnv = {}
  for (const k of SAVED_ENV_KEYS) savedEnv[k] = process.env[k]
  tmpDir = mkdtempSync(join(tmpdir(), 'neutron-open-comp-fields-'))
  process.env['NEUTRON_HOME'] = tmpDir
  process.env['OWNER_HOME'] = tmpDir
  process.env['NEUTRON_DB_PATH'] = join(tmpDir, 'project.db')
  process.env['NEUTRON_INSTANCE_SLUG'] = 'owner'
  process.env['NEUTRON_LANDING_STATIC_DIR'] = LANDING_DIR
  process.env['NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET'] = 'open-test-secret-0123456789'
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-comp-fields'
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  delete process.env['NOTIFY_SOCKET']
})

afterEach(() => {
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  // Guard on successful setup — a failed mkdtemp (sandbox) leaves tmpDir
  // undefined; an unguarded rmSync would throw in afterEach and mask it.
  if (tmpDir !== undefined) rmSync(tmpDir, { recursive: true, force: true })
  tmpDir = undefined
})

function cannedHandle(instanceId: string): SessionHandle {
  const events = (async function* (): AsyncGenerator<Event, void, void> {
    yield { kind: 'token', text: 'ready' }
    yield {
      kind: 'completion',
      usage: { input_tokens: 1, output_tokens: 1 },
      substrate_instance_id: instanceId,
    }
  })()
  return {
    events,
    async respondToTool(): Promise<void> {},
    async cancel(): Promise<void> {},
    tool_resolution: 'internal',
  }
}

async function bootAndInspect(
  assert: (composition: Record<string, unknown>, captured: ClaudeCodeSubstrateOptions[]) => void,
): Promise<void> {
  const captured: ClaudeCodeSubstrateOptions[] = []
  const substrateFactory = (opts: ClaudeCodeSubstrateOptions): Substrate => {
    captured.push(opts)
    return { start: () => cannedHandle(opts.substrate_instance_id) }
  }
  const db = ProjectDb.open(process.env['NEUTRON_DB_PATH']!)
  applyMigrations(db.raw())
  const composer = buildOpenGraphComposer({ env: process.env, substrateFactory })
  // Only compose the CompositionInput — we deliberately do NOT stand up the
  // production graph (HTTP server + cron schedulers), so this characterization
  // never leaks a scheduler into a sibling test's shared bun process. The
  // fire-and-forget `cc-llm-*` pre-warm fires during `composer()` build itself.
  const composition = await composer({ db, project_slug: 'owner' })
  try {
    // Let the fire-and-forget pre-warm dispatch flush so it appears in `captured`.
    await Bun.sleep(20)
    assert(composition as unknown as Record<string, unknown>, captured)
  } finally {
    for (const cleanup of composition.realmode_cleanups ?? []) {
      try {
        cleanup()
      } catch {
        /* best-effort */
      }
    }
    db.close()
  }
}

describe('Open composition — field-key characterization (C3a carve guard)', () => {
  // ONE composer boot covers both assertions (composition keys + the build-time
  // pre-warm dispatch) to keep this heavy characterization's footprint minimal.
  test('composer sets EXACTLY the expected fields + fires one cc-llm-* pre-warm (no tool bridge)', async () => {
    await bootAndInspect((composition, captured) => {
      expect(Object.keys(composition).sort()).toEqual([...EXPECTED_COMPOSITION_KEYS])

      // The onboarding phase-spec pre-warm is the ONLY build-time dispatch.
      expect(captured.length).toBe(1)
      const opts = captured[0]!
      expect(opts.substrate_instance_id.startsWith('cc-llm-')).toBe(true)
      // The phase-spec substrate is NOT the tool-bridge one (only cc-agent- is).
      expect(opts.enableToolBridge).not.toBe(true)
      // Warm + snappy: not ephemeral, no per-turn /clear.
      expect(opts.ephemeral).not.toBe(true)
      expect(opts.reset_context_per_turn).not.toBe(true)
    })
  }, 30_000)
})
