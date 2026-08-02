/**
 * THE ROUTE-SLOT BASELINE — which declared HTTP surfaces the product actually
 * serves today, and for the ones it does not, WHY.
 *
 * Read `route-slot-coverage.test.ts` first: it boots the real Open composition,
 * asks the composed graph which slots it carries, and checks the answer against
 * the two lists below. This file is data only — it imports NOTHING, deliberately,
 * so `scripts/ci/route-slot-ratchet-guard.sh` can write main's copy of it to a
 * scratch path and import that too.
 *
 * HOW TO CHANGE IT.
 *   - Wired a surface? Move its entry from UNMOUNTED_SLOTS to MOUNTED_SLOTS. The
 *     coverage test fails until you do — a stale "not served" line is an
 *     allowlist entry that has stopped being true.
 *   - Added a slot? Classify it here. An unclassified slot fails the build.
 *   - Tempted to move an entry the OTHER way to get green? That is the one edit
 *     the ratchet guard exists to stop. Re-wire the surface, or delete the slot
 *     and its dead handler.
 *
 * EVERY UNMOUNTED ENTRY CARRIES ITS REASON, and the reason is the point. A bare
 * list of names rots into permission: the next reader sees an established
 * allowlist and adds one more. A written reason is a claim someone can check, and
 * `costs` says out loud what the owner is currently missing — several of these are
 * live defects, not decisions, and the list should read that way until they are
 * fixed.
 *
 * VERIFIED 2026-08-01 against the composed production graph, on a credentialed
 * boot. The hosted overlay does not change the answer: it spawns this same
 * `open/server.ts` per instance, so there is no second composer that mounts more.
 *
 * 2026-08-01 — four rungs moved from unserved to served (`app-reminders`,
 * `app-devices`, `app-admin`, `app-persona`), each of which had a shipped client
 * calling it. `open/__tests__/app-surfaces-served.test.ts` drives all four
 * through the composed `graph.fetch`, because "the composition carries the
 * field" and "a request reaches the handler" are different claims and only this
 * file checks the first one.
 *
 * 2026-08-02 — `app-backups` joins them, and it needed a path change first, not
 * just a composer line. Its restore route was the bare
 * `POST /api/app/projects/<id>/restore`, which `app-projects` (an EARLIER rung)
 * already owns for un-archiving a project; mounting the surface would not have
 * fixed that, because the earlier rung wins regardless. The restore moved to
 * `POST .../backups/restore` — disjoint by shape, so no reordering can bring the
 * collision back — and only then was the surface wired.
 *
 * 2026-08-02 — `telegram-webhook` joins them, and it is the first entry here
 * whose mounting is CONDITIONAL ON STORED STATE rather than unconditional. The
 * surface exists iff the instance's SecretsStore holds the three Telegram
 * values; a default Open install stores none of them, so the route stays absent
 * there BY DESIGN — it is an unauthenticated endpoint and an instance with no
 * configured secret has nothing to authenticate against.
 *
 * That is why the probe in `route-slot-coverage.test.ts` now SEEDS those
 * secrets before composing. The file already fakes `ANTHROPIC_API_KEY` for the
 * same reason and states the intent out loud — "the widest composition an Open
 * instance produces, so a surface that is absent HERE is absent everywhere".
 * Seeding widens the probe to match that claim instead of quietly narrowing the
 * claim to match the probe. Without it this entry could only ever be recorded
 * as unserved, and the ratchet would be measuring the fixture rather than the
 * product. The reachability half — that a real request reaches the handler, and
 * that a request with a missing or wrong secret is REJECTED BY IT rather than
 * 404ing past it — is `open/__tests__/telegram-webhook-served.test.ts`.
 */

/** A slot the product SERVES. Regressing one of these means the path starts 404ing. */
export interface RouteSlotServedEntry {
  /** `RouteSlot.rung` — the registry's unique label for this ladder rung. */
  readonly rung: string
  /** `RouteSlot.composition` — the `CompositionInput` field that promotes it. */
  readonly composition: string
  /** What the owner loses if it stops being served. */
  readonly serves: string
}

/** A slot the product DOES NOT serve, with why and what that costs. */
export interface RouteSlotUnservedEntry {
  readonly rung: string
  readonly composition: string
  /** Why no composer sets it. */
  readonly why: string
  /** What the owner is missing because of that, in plain terms. */
  readonly costs: string
}

/** Structural union used by the coverage test's derived-slot list. */
export interface RouteSlotBaselineEntry {
  readonly rung: string
  readonly composition: string
}

/**
 * Floor for the "is the probe alive at all" assertion. Not the exact count — that
 * would be a second baseline to keep in sync. It only has to be high enough that
 * a probe which composed nothing fails instead of reporting a clean sweep of
 * absences (or, worse, passing vacuously over an empty set).
 */
export const MIN_EXPECTED_MOUNTED_SLOTS = 20

/**
 * SERVED by the production Open composition. This list may only grow.
 */
export const MOUNTED_SLOTS: readonly RouteSlotServedEntry[] = [
  {
    rung: 'chat-history',
    composition: 'chat_history_surface',
    serves: 'GET /api/v1/chat/history — the web chat hydrates its transcript on load',
  },
  {
    rung: 'chat-topics',
    composition: 'chat_topics_surface',
    serves: 'GET /api/v1/chat/topics — the sidebar topic rail',
  },
  {
    rung: 'chunked-upload',
    composition: 'chunked_upload_handler',
    serves: 'resumable chunked uploads — a large import survives a dropped connection',
  },
  {
    rung: 'import-resume',
    composition: 'import_resume_handler',
    serves: 'POST /api/import/<job>/resume — a stalled history import can be restarted',
  },
  {
    rung: 'import-upload',
    composition: 'import_upload_handler',
    serves: 'POST /api/upload/<source> — the ChatGPT/Claude export ZIP upload',
  },
  {
    rung: 'app-ws',
    composition: 'app_ws_surface',
    serves: 'the unified /ws/app/chat socket — the whole chat product, both clients',
  },
  {
    rung: 'app-upload',
    composition: 'app_upload_surface',
    serves: 'chat attachments — sending a file or image in chat',
  },
  {
    rung: 'app-voice-transcription',
    composition: 'app_voice_transcription_surface',
    serves: 'install/remove of the local whisper.cpp voice backend',
  },
  {
    rung: 'app-tasks',
    composition: 'app_tasks_surface',
    serves: 'the Tasks tab — list, create, complete, cancel',
  },
  {
    rung: 'app-reminders',
    composition: 'app_reminders_surface',
    serves:
      'the Reminders screen — list, create, snooze, cancel (convert-to-task answers 501 until the Core adapter is threaded in)',
  },
  {
    rung: 'app-devices',
    composition: 'app_devices_surface',
    serves:
      'device push-token register/unregister on sign-in and sign-out — the prerequisite for any push at all',
  },
  {
    rung: 'app-admin',
    composition: 'app_admin_surface',
    serves: 'the Admin screen — gateway restart, GBrain browse, installed-connectors list',
  },
  {
    rung: 'app-persona',
    composition: 'app_persona_surface',
    serves: 'the Personality pane — read/write SOUL.md, USER.md, priority-map.md',
  },
  {
    rung: 'app-tabs',
    composition: 'app_tabs_surface',
    serves: 'the tab resolver — which tabs a project shows at all',
  },
  {
    rung: 'app-work-board',
    composition: 'app_work_board_surface',
    serves: 'the Work Board',
  },
  {
    rung: 'app-activity',
    composition: 'app_activity_surface',
    serves: 'the Activity inspector snapshot on panel open',
  },
  {
    rung: 'app-usage',
    composition: 'app_usage_surface',
    serves: 'the credential usage meter under the tab bar',
  },
  {
    rung: 'app-system-notice',
    composition: 'app_system_notice_surface',
    serves: 'the one way an out-of-process caller can put a durable system message in chat',
  },
  {
    rung: 'app-project-credentials',
    composition: 'app_project_credentials_surface',
    serves: 'per-project credential CRUD in project Settings',
  },
  {
    rung: 'app-codex-credential',
    composition: 'app_codex_credential_surface',
    serves: 'Connect Codex, globally and per project',
  },
  {
    rung: 'app-projects',
    composition: 'app_projects_surface',
    serves: 'the project list and per-project settings drawer',
  },
  {
    rung: 'app-diagnostics',
    composition: 'app_diagnostics_surface',
    serves: 'GET /api/app/admin/diagnostics — answering "why is memory/chat/import broken"',
  },
  {
    rung: 'app-docs',
    composition: 'app_docs_surface',
    serves: 'the Docs tab — tree, read, write, move, folders',
  },
  {
    rung: 'app-backups',
    composition: 'app_backups_surface',
    serves:
      'the project Backups screen — snapshot list, preview, per-file body/diff, and the restore itself at POST .../backups/restore (it was .../restore, which the earlier appProjects rung claims for un-archive and won)',
  },
  {
    rung: 'telegram-webhook',
    composition: 'telegram_webhook',
    serves:
      'POST /webhook/telegram — the ONLY inbound path for a Telegram bot. Mounted iff this instance has Telegram secrets stored (unconfigured installs correctly serve nothing); when it regresses, a configured owner’s bot goes deaf and every message he sends is dropped with no error anywhere, because Telegram reads the 404 as delivery and stops retrying.',
  },
  {
    rung: 'cores-integrations',
    composition: 'cores_integrations_surface',
    serves: 'the Integrations list and API-key management',
  },
  {
    rung: 'cores',
    composition: 'cores_surface',
    serves: 'GET /api/cores — the bundled-Cores admin view',
  },
  {
    rung: 'landing.pathset',
    composition: 'landing_server',
    serves: 'the web app itself — every page and asset the browser loads',
  },
  {
    rung: 'connect',
    composition: 'connect_api',
    serves: 'the cross-instance Connect API (gated per request by live connect state)',
  },
]

/**
 * NOT served. Each line is a claim about the product — check it, do not inherit
 * it. Most of these are DEFECTS awaiting a wire-or-delete decision, not settled
 * design; they are listed so the gate can be trusted, not so they can be
 * forgotten. Nothing in this list is a reason to add another entry to it.
 */
export const UNMOUNTED_SLOTS: readonly RouteSlotUnservedEntry[] = [
  // ── Live callers exist → these paths 404 in production ────────────────────
  {
    rung: 'admin-respawn',
    composition: 'admin_respawn_handler',
    why: 'No composer sets it; the field has no setter anywhere outside its own declaration (gateway/composition/input/http-surfaces-input.ts:104).',
    costs:
      'The dead-REPL detector tells the operator to POST /admin/respawn-session (runtime/adapters/claude-code/persistent/dead-repl-detector.ts:110,125,134 and channel-unbound-respawn.ts:103). Following that instruction hits a 404, so the documented recovery for a wedged REPL does not exist.',
  },
  {
    rung: 'app-launcher',
    composition: 'app_launcher_surface',
    why: 'createAppLauncherSurface (gateway/http/app-launcher-surface.ts:49) has no non-test call site.',
    costs:
      'The Apps tab is a shipped builtin (tabs/registry.ts:109-114) and app_tabs_surface IS served, so the tab renders and taps through to a screen whose every call 404s (app/lib/launcher-client.ts:79,89,97,109).',
  },
  {
    rung: 'cores-oauth',
    composition: 'cores_oauth_surface',
    why: 'gateway/composition/wire-cores-surfaces.ts:102 auto-builds it only when `cores.oauth` is supplied, and no composer supplies that field. Not env-conditional: the field has no setter at all.',
    costs:
      'Settings routes to Integrations (app/app/settings.tsx:378) and the Google connect/status/disconnect calls 404 (app/lib/cores-client.ts:161,168,175), so Google-backed Cores cannot be connected from the app.',
  },

  // ── Dead at both ends → mounting alone would serve nothing ────────────────
  {
    rung: 'app-focus',
    composition: 'app_focus_surface',
    why: 'createAppFocusSurface (gateway/http/app-focus-surface.ts:157) has no non-test call site.',
    costs:
      'app/lib/focus-client.ts:122 calls it, but from app/app/focus.tsx, which nothing navigates to — it is registered in the router (app/app/_layout.tsx:220) and never pushed. Mounting the backend alone would serve an unreachable screen, so this one needs a product decision (wire the entry point, or delete both ends) rather than a wiring fix.',
  },
  {
    rung: 'app-focus-current',
    composition: 'app_focus_current_surface',
    why: 'createAppFocusCurrentSurface has no non-test call site.',
    costs: 'Same orphaned Focus screen as above (app/lib/focus-client.ts:167). Same decision.',
  },
  {
    rung: 'app-connect-auth',
    composition: 'app_connect_auth_surface',
    why: 'No composer sets it.',
    costs:
      'No caller found in any client. Per gateway/composition/input/app-surfaces-input.ts:160 the intended consumer hides itself when /status 404s, so nothing is visibly broken — but a declared surface with no producer and no consumer is dead code either way.',
  },
  {
    rung: 'avatar',
    composition: 'avatar_handler',
    why: 'buildAvatarRouteHandler (onboarding/profile-pic/storage.ts:688) has no non-test call site.',
    costs:
      'Nothing requests /avatar.png in any client, and the producer is dead too: buildProfilePicEngineHook (onboarding/profile-pic/storage.ts:383) is never invoked outside tests, so no portrait is ever generated to serve.',
  },
  {
    rung: 'profile-pic-candidate',
    composition: 'candidate_handler',
    why: 'buildCandidateRouteHandler (onboarding/profile-pic/storage.ts:740) has no non-test call site.',
    costs:
      'The onboarding gallery renders whatever image_url an option carries (landing/chat-react/ChatApp.tsx:593), and that URL shape is minted by imageUrlBuilder (onboarding/profile-pic/storage.ts:508,608) — which, like the hook above, is only ever supplied by tests. Both ends of the portrait picker are dark.',
  },
  {
    rung: 'slug-check',
    composition: 'slug_check_handler',
    why: 'No composer sets it.',
    costs:
      'Nothing calls the per-instance route. The name collides with a Managed control-plane route of the same shape, which is served by Managed itself and does not reach here — so this slot is a leftover of the slug-rename work, not a hosting seam.',
  },
  {
    rung: 'internal-cache-invalidate',
    composition: 'internal_cache_invalidate',
    why: 'No composer sets it.',
    costs:
      'No caller found in this repo or the hosting overlay. It was built for a slug-rename orchestrator to poke after a rename commits; on Open the owner handle is frozen, so there is no rename to invalidate.',
  },
]
