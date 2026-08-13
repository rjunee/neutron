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
  // SPEC § WAVE 3.5 — the ACTIVITY INSPECTOR snapshot surface
  // (`GET /api/app/projects/<id>/activity`, `GET /api/app/activity`). Its presence
  // HERE is the done-means-served proof: this test boots the REAL Open composer, so
  // the key only appears if `composeOpen` actually constructs the surface and hands
  // it to the graph — not merely that the module exists.
  'app_activity_surface',
  // The Admin screen's own routes (`/api/app/admin/*` — gateway restart, GBrain
  // browse, connectors). Declared since P5.7 and mounted by no composer until
  // 2026-08-01, so the screen Settings routes to answered 404 everywhere except
  // the diagnostics pane below, which an earlier rung claims.
  'app_admin_surface',
  // Project backups + snapshot restore (`/api/app/projects/<id>/backups[…]`,
  // `POST .../backups/restore`). Same done-means-served proof as the keys around
  // it. Wiring it needed the route MOVE that landed with it: while the restore
  // sat at the bare `.../restore`, the earlier `app_projects_surface` rung
  // claimed that path for un-archive and won, so mounting alone would have
  // served four routes and left the fifth answering the wrong operation.
  'app_backups_surface',
  'app_codex_credential_surface',
  // Device push-token registration (`/api/app/devices/{register,unregister}`).
  // The client calls it on every sign-in and sign-out, so while it was unmounted
  // no device was ever recorded and push had no prerequisite.
  'app_devices_surface',
  // O5 — read-only diagnostics surface (`GET /api/app/admin/diagnostics`).
  'app_diagnostics_surface',
  'app_docs_surface',
  // The owner's GitHub device-flow connect surface (`/api/app/github-auth`). The
  // token storage, the github.com-scoped git helper and the credentialed host
  // runner all shipped before this key existed, and none of them could be STARTED
  // without it — the same done-means-served proof as the keys around it.
  'app_github_connect_surface',
  // The Apps launcher backend (`/api/app/projects/<id>/launcher[*]`). Same
  // done-means-served proof as the keys around it: the Apps tab is a shipped
  // builtin and this key is what stops tapping it from reaching four 404s, as it
  // did in every install until ISSUES #447.
  'app_launcher_surface',
  // The Personality pane inside the Admin screen (`/api/app/persona/*`) —
  // read/write of SOUL.md, USER.md, priority-map.md.
  'app_persona_surface',
  'app_project_credentials_surface',
  'app_projects_surface',
  // The Tasks surface's sibling (`/api/app/projects/<id>/reminders[…]`). A
  // complete screen ships against it; same done-means-served proof as the keys
  // above.
  'app_reminders_surface',
  // The external system-notice route (`POST /api/app/system-notice`). Same
  // done-means-served proof as the usage key below: it appears only if
  // `composeOpen` really constructs the surface and hands it over, which is what
  // makes the route reachable in a real install rather than merely written.
  'app_system_notice_surface',
  'app_tabs_surface',
  'app_tasks_surface',
  // Per-phase build models (`/api/app/trident/phase-models`) — the settings
  // control for which model and reasoning effort run each phase of a build. Its
  // presence HERE is the done-means-served proof, and it matters more than usual:
  // this config was built end to end with NO producer, so the composer handing the
  // surface over is precisely the link that was missing.
  'app_trident_phase_models_surface',
  'app_upload_surface',
  // The active-credential usage meter (`GET /api/app/usage`) that both clients
  // draw the tab-bar divider from. Same done-means-served proof as the activity
  // key above: it appears only if `composeOpen` really constructs the surface.
  'app_usage_surface',
  // Local voice transcription (`/api/app/voice-transcription`) — the Settings
  // control that installs whisper.cpp so voice notes transcribe with no API key.
  // Its presence HERE is the done-means-served proof: the REAL Open composer
  // must construct and hand over the surface, not merely define the module.
  'app_voice_transcription_surface',
  'app_work_board_surface',
  'app_ws_surface',
  'approval_notifier',
  // C5b — Open now supplies the single-owner gate through the unified
  // `composition.auth_gate` seam (both modes flow through ONE seam) instead of
  // wiring `openFetch` as `landing_server.fetch`.
  'auth_gate',
  // X5 — the pre-built ChannelRouter (durable app-ws adapter registered) passed
  // as `composition.channel_router`; build-core-modules reuses it as the ONE
  // delivery seam trident terminal delivery posts through.
  'channel_router',
  'chat_history_surface',
  'chat_topics_surface',
  'chunked_upload_handler',
  'codex_credential',
  // ISSUES #421 — the cross-instance Connect API. Its presence HERE is the
  // done-means-SERVED proof: `connect/` shipped in this repo for months while no
  // composer ever set this field, so a self-hoster carried Connect source they
  // could never serve. The key appears only if the REAL Open composer assembles
  // the connect node and hands it to the graph. Reachability of the mounted
  // surface is then decided per request by the state gate
  // (`connect/surface-gate.ts`) — see `open-connect-served.test.ts`.
  'connect_api',
  'cores',
  // `cores_oauth_broker_surface` is DELIBERATELY ABSENT. It is composed only
  // when a Google client and a declared origin are configured, and this boot
  // configures neither — the env is cleared above precisely so the key set does
  // not depend on what the host happens to have exported.
  //
  // An earlier revision added it here and called it pre-existing inventory
  // drift. That was wrong: the field was missing on this developer box's boot
  // only because the box exports a real Google client, so the "fix" made the
  // characterization pass locally and fail on CI, which exports none.
  'create_project',
  'cron_jobs',
  'db',
  'doc_search',
  // Email Core consolidation P1 — the email pipeline's deps bundle. Its
  // presence HERE is what proves the cron is actually registered on a real
  // boot: without the field, `build-core-modules.ts` skips registration and
  // nothing ever polls the inbox.
  'email_pipeline',
  'heartbeat_tracker',
  'import_resume_handler',
  'import_upload_handler',
  'init_ritual_planner',
  'landing_server',
  // §F2 — the shared loop inventory the Open composer threads through so the
  // gateway boot line inventories the sweeper + lifecycle watchdog it starts.
  'loop_registry',
  // RA2 — coarse memory-backend health provider the boot shell folds into the
  // terminal `/healthz` so a missing gbrain backend reads `status:'degraded'`
  // (loud + monitorable) instead of silently degrading recall to file-grep.
  'memory_health',
  // RA5 — the memory-recall composition field is the backend-neutral
  // `memory_search` (renamed from `gbrain_search`; same MemoryStore wiring).
  'memory_search',
  'message_search',
  // The post-compose hook that hands the composed Cores registry back to the
  // tab resolver. The resolver is built BEFORE `graph.compose()`, so this is
  // the only moment the registry exists while the surface is still upstream of
  // any request — without it, Core-contributed tabs (Tasks) resolve to `[]`.
  'on_cores_ready',
  // F4 — the gateway-tick hook that pulses the supervision-watchdog heartbeat.
  'on_gateway_tick',
  'onboarding_import_running_cron',
  // ISSUES #443 — the overnight-work morning brief's delivery surface. The
  // overnight ENGINE always registered, so the work ran; without this key the
  // reporter had nowhere to post and the owner never saw the result.
  'onboarding_overnight_cron',
  'platform',
  'project_slug',
  // The reminder-fired push hook (`ReminderTickLoop.on_fired`). Registering a
  // device was only ever half of push; this is the delivery half, and its
  // absence is why `createPushDispatcher` had no non-test call site.
  'push_dispatcher',
  'realmode_cleanups',
  'reminder_dispatcher',
  // Executor-mode reminders (plan task 4) — ritual executor factory, set when
  // a credential resolves (llmPool !== null), like `agent_dispatch`/`trident`.
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
  // THE HOST'S OWN GOOGLE CLIENT MUST NOT DECIDE THIS TEST. `cores_oauth_broker
  // _surface` is composed only when a Google client AND a declared origin are
  // configured, so leaving these inherited makes the expected key set differ
  // between a developer box that has them and CI, which does not — the exact
  // way this characterization went red on CI while passing locally. Cleared
  // below so the boot is deterministic in both places.
  'NEUTRON_CORES_GOOGLE_CLIENT_ID',
  'NEUTRON_CORES_GOOGLE_CLIENT_SECRET',
  'NEUTRON_CONNECT_PUBLIC_BASE_URL',
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
  delete process.env['NEUTRON_CORES_GOOGLE_CLIENT_ID']
  delete process.env['NEUTRON_CORES_GOOGLE_CLIENT_SECRET']
  delete process.env['NEUTRON_CONNECT_PUBLIC_BASE_URL']
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
