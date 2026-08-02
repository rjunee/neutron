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
 * boot. Managed does not change the answer: it spawns the same
 * `open/server.ts` per tenant, so there is no second composer that mounts more.
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
    rung: 'app-reminders',
    composition: 'app_reminders_surface',
    why: 'createAppRemindersSurface (gateway/http/app-reminders-surface.ts:118) has no non-test call site — only the JSDoc reference at gateway/composition/input/app-surfaces-input.ts:118.',
    costs:
      'A complete reminders UI ships against it — app/lib/reminders-client.ts:78,91,103,111,131 (list/create/snooze/cancel/convert) behind app/app/projects/[id]/reminders.tsx. The reminder push deep link (app/lib/push-deep-link-dispatch.ts:106) lands there too.',
  },
  {
    rung: 'app-admin',
    composition: 'app_admin_surface',
    why: 'createAppAdminSurface (gateway/http/app-admin-surface.ts:179) has no non-test call site; gateway/http/app-diagnostics-surface.ts:46 already records it as never wired into open/composer.ts.',
    costs:
      'Settings routes to the Admin screen (app/app/settings.tsx:362) and roughly ten of its calls 404 (app/lib/admin-client.ts:289-420). Only the diagnostics pane works, because the earlier appDiagnostics rung claims that one path — a partial failure, which reads as a broken screen rather than a missing one.',
  },
  {
    rung: 'app-persona',
    composition: 'app_persona_surface',
    why: 'createAdminPersonalitySurface (gateway/http/admin-personality-surface.ts:154) has no non-test call site.',
    costs:
      'The Personality pane inside that same reachable Admin screen cannot read or save SOUL/USER/priority-map (app/lib/admin-personality-client.ts:101,111,128,144 via app/features/admin/PersonalityPane.tsx).',
  },
  {
    rung: 'app-devices',
    composition: 'app_devices_surface',
    why: 'createAppDevicesSurface (gateway/http/app-devices-surface.ts:53) has no non-test call site.',
    costs:
      'Push-token registration runs on every login and every sign-out (app/lib/push.ts:143,177 → app/lib/devices-client.ts:65,78) and 404s, so no device is ever registered. That disables push notifications entirely, which is also most of why the reminder deep link above is dead.',
  },
  {
    rung: 'app-backups',
    composition: 'app_backups_surface',
    why: 'createAppBackupsSurface (gateway/http/app-backups-surface.ts:61) has no non-test call site.',
    costs:
      'The project settings drawer routes to a backups screen whose list/create/download calls 404 (app/lib/backups-client.ts:96,105,117,129). Worse than a 404 on ONE of them: POST /api/app/projects/<id>/restore is also claimed by the SERVED appProjects rung (gateway/http/app-projects-surface.ts:560), which sits earlier in the ladder — so the restore-from-backup button silently UN-ARCHIVES the project and reports success instead of failing.',
  },
  {
    rung: 'cores-oauth',
    composition: 'cores_oauth_surface',
    why: 'gateway/composition/wire-cores-surfaces.ts:102 auto-builds it only when `cores.oauth` is supplied, and no composer supplies that field. Not env-conditional: the field has no setter at all.',
    costs:
      'Settings routes to Integrations (app/app/settings.tsx:378) and the Google connect/status/disconnect calls 404 (app/lib/cores-client.ts:161,168,175), so Google-backed Cores cannot be connected from the app.',
  },
  {
    rung: 'telegram-webhook',
    composition: 'telegram_webhook',
    why: 'buildTelegramWebhookSurface (gateway/wiring/build-telegram-webhook.ts:109) documents itself as "called only by the Managed composer" — but Managed spawns this same open/server.ts per tenant, so no such composer exists and nothing sets the field.',
    costs:
      "The Managed hosting overlay forwards every inbound Telegram update to POST /webhook/telegram on the tenant instance; that path 404s, so a tenant's Telegram bot is inert. Managed's own contract check greps `gateway/` for the literal path string, which route-slots.ts satisfies whether or not anything serves it — the check cannot see this.",
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
