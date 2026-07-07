# Per-Project Settings Tab + Per-Project Credential Scoping — Engineering Plan

**Date:** 2026-06-30
**Repo:** Neutron OPEN (`~/repos/neutron-open`) — all phases land here (engine + web + mobile).
**Status:** PLAN-ONLY. No code written. Four architecture deltas (below) need Ryan sign-off BEFORE any build.
**Spec anchor:** `neutron-managed/SPEC.md:186` (Phases→Steps, WAVE 3) + `SPEC.md:328` (Decisions Log 2026-06-30).
**No feature flags** — build directly (SPEC Decisions Log 2026-06-23 lock; shells degrade to Chat-only if the resolver is unreachable).

---

## 0. Spec-conformance audit (first deliverable, per the spec-conformance-audit rule)

### (a) Settings tab surface

- **SPEC says:** Each project gets a **Settings** tab (project tab set → Chat / Plan / Documents / Settings), web + mobile, owning collaborators (UI scaffold M1, invite/remove M2-gated) + per-project credentials. (`SPEC.md:186`, `:328`)
- **CURRENT wiring does:** Tab set is **registry-driven** (`tabs/registry.ts:97-136` `BUILTIN_TABS` = `chat`/`work_board`[label "Plan"]/`documents` + global `admin`). Adding a builtin = one registry descriptor + one client view keyed to `mount.target` (web `ProjectShell.tsx:114-184` dispatch; mobile expo file-route `app/app/projects/[id]/<target>.tsx`). A `/settings` HTTP surface already exists but only PATCHes `privacy_mode` + `agent_engagement_mode` (`gateway/http/app-projects-surface.ts:9-29`).
- **GAP:** No `settings` builtin descriptor; no web `SettingsTab.tsx`; no mobile `settings.tsx`; the existing settings surface has no credentials/collaborators concept.
- **THIS PLAN COVERS:** Register the `settings` builtin (Phase 1), web `SettingsTab` + mobile `settings.tsx`, extend the settings HTTP surface with credentials + collaborators sections.
- **OUT OF SCOPE:** Custom user-built tabs (SPEC-deferred); the M2 multi-user collaborator backend (GATED).

### (b) Per-project credential resolution

- **SPEC says:** A Core resolves credentials from the **ACTIVE project's Settings**, not a single global install-time secret; the agent's available-services awareness is **project-scoped** so Claude knows exactly which services it can use in a given project. (`SPEC.md:186`, `:328`)
- **CURRENT wiring does:** A **single per-INSTANCE** `OAuthTokenManager` (`gateway/cores/oauth-token-manager.ts`), constructed once at `gateway/cores/mount-open-cores.ts:172-177` with `internal_handle = instance project_slug`, is shared by all three Google Cores (Calendar/Email/Workspace). The token accessor closure `googleOAuthAccessToken(label)` (`mount-open-cores.ts:183-192`) takes only a `label` — **no project dimension**. The `secrets` table's `project_slug` column is a **decoy**: it stores the frozen instance `internal_handle`, deliberately (renaming an instance was silently wiping creds — `auth/secrets-store.ts:14-26`). Google client id/secret are process-global env (`NEUTRON_CORES_GOOGLE_CLIENT_ID` / `_CLIENT_SECRET`). Cores already receive a per-call `project_id` but use it only for **data segmentation** (Gmail `Neutron/<project_id>` labels `email/src/per-project-resolver.ts:30`; calendar `extendedProperties.private.project_id` `calendar/src/backend.ts:626-647`) — the credential layer ignores it. Bundled Cores are composed **unconditionally at boot** (`open/composer.ts:962`) so the agent's tool surface is instance-wide, not per-project.
- **GAP:** No credential key on the **real** project id exists; the token accessor has no project dimension; agent service-awareness is instance-global.
- **THIS PLAN COVERS:** A new `project_credentials` table keyed on the real project id (reusing the existing AES-256-GCM crypto, `auth/secrets-store.ts`), a project-aware resolution order (per-project → global/instance default → unset), and a per-project available-services context block.
- **OUT OF SCOPE (pending sign-off — see Deltas):** Forcing per-project OAuth re-consent for the Google Cores this wave; hard tool-registry gating (vs. context-injection + graceful refusal).

---

## 1. Architecture deltas requiring Ryan sign-off BEFORE build

The spec says "extends the Cores credential model," but the existing model is instance-keyed with an explicit anti-per-project history. Four decisions must be locked before Phase 2:

### DELTA 1 — New `project_credentials` table, do NOT overload `secrets`
The `secrets` table (`migrations/0009_p15_onboarding_prereqs.sql:24-36`) keys on `internal_handle` (stored in a column misleadingly named `project_slug`) and carries an explicit history warning that treating that column as the mutable project slug corrupted lookups. **Recommendation:** a NEW `0092_project_credentials` table keyed on the real `project_id` (the `projects.id` slug), reusing the AES envelope helpers from `SecretsStore` (`encrypt`/`decrypt`/`ensureKey`, `auth/secrets-store.ts:401-471`) but NOT its instance-scoped table. Keeps OAuth-client + Max tokens (genuinely instance-level) in `secrets`, and puts genuinely per-project service tokens in the new table. **Sign-off:** new table vs. overloaded `secrets`.

### DELTA 2 — Scope: static service tokens now; per-project OAuth grants deferred
The spec examples (Meta Ads, Google Ads) are **static long-lived API tokens** set by paste — a different shape from the 3-legged OAuth-refresh dance the Google Cores use. **Recommendation:** new static per-project service tokens are per-project from day one (Phase 2–3); the existing OAuth Google Cores keep the **instance grant as the "global default"** and gain an OPTIONAL per-project OAuth override in a LATER wave (do NOT force every project to re-run Google consent now). This preserves backward-compat and avoids a large OAuth rework in this wave. **Sign-off:** confirm per-project OAuth grants for Google Cores are DEFERRED (not built now), or explicitly pull them into this wave.

### DELTA 3 — Agent service-awareness: context-injection + graceful refusal, not hard tool gating
Today bundled Cores compose unconditionally at boot (`open/composer.ts:962`), so every tool is registered instance-wide. **Recommendation (lighter):** keep tools composed, but (i) inject a per-project **"services available in THIS project"** context block (derived from `project_credentials` + installed Cores) into the turn, and (ii) make a Core call **hard-fail with a clear "not credentialed in this project"** error when the active project has no creds. Full per-project tool-**registry** gating (unregistering tools per project/turn) is heavier and touches the composer's tool-assembly hot path. **Sign-off:** context-awareness + graceful refusal (recommended) vs. hard per-project tool-registry gating.

### DELTA 4 — Resolution order / global default (backward-compat)
**Recommendation:** `per-project credential → instance/global default → unset`. An existing single-owner install keeps working unchanged (the instance OAuth grant IS the global default); per-project creds override when present. This is the answer to the spec's explicit "backward-compat with a global default?" question. **Sign-off:** confirm the fallback order.

> If Ryan disagrees with any delta, the affected phase changes shape — do not start Phase 2 until 1/2/4 are locked (Phase 1 is delta-independent and can start immediately).

---

## 2. Phased plan

Ordering: **Phase 1 (container, delta-independent) → 2 (store) → 3 (Cores resolution rework — the meaty part) → 4 (agent awareness) → 5 (collaborators scaffold, can run parallel to 2–4).**

### Phase 1 — Settings tab surface (web + mobile, registry-driven)
Delivers the visible container with two section shells (Credentials — empty/CRUD wired in Phase 2; Collaborators — disabled M2 scaffold). Delta-independent; can start now.

**Work:**
- `tabs/registry.ts` — add one `TabDescriptor` to `BUILTIN_TABS`: `key:'settings'`, `label:'Settings'`, `scope:'project'`, `source:'builtin'`, `order:15` (between `documents`=10 and Core base=100), `mount:{kind:'builtin', target:'settings'}`. Update `tabs/__tests__/registry.test.ts`.
- Web: new `landing/chat-react/SettingsTab.tsx`; add `import` + a `tab.mount.target === 'settings'` branch to `TabContent` (`ProjectShell.tsx:148-183`); component CSS in `landing/chat-react.html`.
- Mobile: new expo file-route `app/app/projects/[id]/settings.tsx` (filename must equal `mount.target` — expo-router auto-registers, no `_layout` edit). Add `settings` to `LastTabValue` + `LEGAL_TABS` in `app/lib/last-tab-storage.ts:27-35`.
- Settings HTTP surface: extend `gateway/http/app-projects-surface.ts` (or a sibling `app-project-settings-surface.ts`) to serve the tab's read model (project meta + section availability). `project_slug` server-derived via `resolveBearer` (mirror `work-board-surface.ts:77-81`).

**Acceptance:** Every project renders a Settings tab (web + mobile) via the registry (no hardcoding); the tab shows a Credentials section (empty state) and a Collaborators section (visibly disabled/"M2"); General/global view unaffected; a fresh `:78xx` install shows the tab at order 15.

**Risks:** `app/lib/project-tabs.ts` `PROJECT_TABS` loading-default list is stale (Chat/Apps/Tasks/Reminders/Docs) — cosmetic loading flash only; note it, optionally refresh. Order-15 slot must not collide with any Core base (base is 100 — safe).

### Phase 2 — Per-project credential store + schema/migration
The store + HTTP + Settings-UI CRUD for setting a static service token per project. Blocked on DELTA 1/2/4.

**Work:**
- Migration `0092_project_credentials.sql` (STRICT + CHECK + ISO-8601 TEXT, forward-only, mirroring `0090_work_board_items.sql:61-75`): columns `id` (ULID PK), `project_id TEXT NOT NULL`, `service TEXT NOT NULL` (e.g. `meta_ads`,`google_ads`), `ciphertext TEXT NOT NULL` (AES envelope JSON), `label TEXT`, `created_at`/`updated_at`/`expires_at` (ISO TEXT), `UNIQUE(project_id, service)`, index `(project_id)`.
- `ProjectCredentialStore` class (mirror `WorkBoardStore` `work-board/store.ts:209`): `set/get/list/delete`, `project_id` first arg always server-derived, reuse `SecretsStore` AES helpers for encrypt/decrypt (share `ensureKey` keyfile `.neutron-aes-key`). List returns metadata only (service, label, set-at, expires) — never ciphertext.
- HTTP surface `gateway/http/project-credentials-surface.ts` (mirror `work-board-surface.ts:56`): `GET/POST/DELETE /api/app/projects/<id>/credentials[/<service>]`; `project_id` from `resolveBearer`, not the path; validation-error→400 envelope. Wire into composer (`open/composer.ts` construct + `app_project_credentials_surface` in the compose input, mirror `:1971`+`:3178`; declare in `gateway/composition/input/app-surfaces-input.ts`; route in `gateway/http/compose.ts`).
- Settings UI Credentials section (web `SettingsTab.tsx` + mobile `settings.tsx`): list configured services, add (service picker + token paste), delete. Web `project-credentials-client.ts` + mobile `app/lib/project-credentials-client.ts`.

**Acceptance:** A service token set in project A is stored encrypted, listed (metadata-only) in A's Settings, and is absent in project B; deleting removes it; two projects hold distinct tokens for the same service; ciphertext at rest (no plaintext in the DB); server derives `project_id` (client cannot write another project's creds).

**Risks:** ULID generation is in-store (no `ulid` npm dep — copy `defaultUlid` `work-board/store.ts:171-191`). Keyfile sharing with `SecretsStore` must not double-init the key.

### Phase 3 — Cores per-project credential resolution rework (THE MEATY PART)
Make Cores resolve from the active project's Settings with the DELTA-4 fallback. Blocked on Phase 2 + DELTA 2/3/4.

**Work:**
- Thread a project dimension into the token accessor. Change `googleOAuthAccessToken(label)` (`mount-open-cores.ts:183-192`) → `(label, project_id)`; the Core tools already carry a per-call `project_id` (`calendar/src/tools.ts:118,152,233`; `google-workspace/src/tools.ts:79,100`) so the call sites can pass it.
- Resolution function (new, central): `resolveCoreCredential({ project_id, service/label })` implementing DELTA-4 order — check `ProjectCredentialStore.get(project_id, service)` first; else fall back to the instance `OAuthTokenManager.getAccessToken(label)` (the "global default"); else missing→`OAuthMissingError` (`calendar/src/backend.ts:178`) with a project-scoped message.
- Per DELTA 2: static-token services resolve from `project_credentials`; the OAuth Google Cores keep the instance grant as the global default (no per-project OAuth grant this wave). If DELTA 2 is overridden to include per-project OAuth, add per-project rows to the OAuth-pending/token flow (`cores-oauth-surface.ts`, `oauth-token-manager.ts`) — LARGER scope, re-plan.
- Update the three Core wirings (`mount-open-cores.ts:198-220`, `boot-helpers.ts:1001-1066`) to pass `project_id` through the accessor.

**Acceptance:** With project A credentialed for a service and project B not, a Core call in A uses A's creds and a call in B falls back to the global default (or fails with a clear project-scoped "not credentialed" error if no default); the existing single-owner instance keeps working unchanged (fallback path); no regression in Calendar/Email/Workspace Cores against their current tests.

**Risks:** The `internal_handle` decoy (DELTA 1) — every touch of `secrets`/`OAuthTokenManager` must not confuse instance handle with project id. Accessor-signature change ripples to all three Cores + both wiring sites — cover with tests. Refresh-token semantics stay instance-level (only static tokens go per-project this wave) — keep them separate to avoid per-project refresh races.

### Phase 4 — Project-scoped available-services awareness
Claude knows which services it can use in the active project. Blocked on Phase 3 + DELTA 3.

**Work (per DELTA 3, recommended path):**
- Build a per-project available-services descriptor: `installed Cores (per-project + global) ∪ project_credentials(project_id)`, resolved from `core_installations`/`core_global_installations` (`installations-store.ts`) + the new store.
- Inject a compact **"Services available in this project"** block into the turn (adjacent to the agent-profile splice seam `open/agent-profile-backend.ts:18` / composer system-prompt assembly). Per-turn, project-scoped.
- Graceful refusal: a Core tool invoked without creds for the active project returns a typed "not credentialed in <project> — set it in Settings" result rather than a raw OAuth error.

**Acceptance:** In a project where service X is uncredentialed, the agent's context lists X as unavailable and the agent does not attempt/─or gracefully declines─X; in a project where X is credentialed, X is listed available and usable; switching projects flips availability within one turn.

**Risks:** Prompt bloat — keep the block minimal (names + available/unavailable), mirror the Work Board per-turn injection's terseness. If DELTA 3 is overridden to hard-gate the tool registry, this becomes a composer tool-assembly change (heavier, re-plan).

### Phase 5 — Collaborators UI scaffold (M2-gated, UI only)
UI/scaffold only; NO multi-user backend (that's M2/WAVE 6, GATED `SPEC.md:213-215`). Can run parallel to Phases 2–4.

**Work:**
- Settings Collaborators section (web + mobile): render the project owner + a visibly-disabled "Invite / Remove (available in M2)" affordance. Read-only list backed by the existing `project_members` table (`migrations/0038_projects_canonical.sql:96-105`) — display only.
- No invite/remove endpoints, no email/invite flow, no membership mutation.

**Acceptance:** Collaborators section present in every project's Settings showing the owner; invite/remove is visibly gated to M2 (disabled, labeled); NO membership mutation path exists in code (grep-confirmed no new write endpoint).

**Risks:** Scope creep into M2 — hard-hold the line: display-only, zero mutation.

---

## 3. Repo routing & cross-cutting

- **All phases: Neutron OPEN.** Engine (`tabs/`, `migrations/`, `gateway/http/`, `gateway/cores/`, `open/composer.ts`, new stores) + web (`landing/chat-react/`) + mobile (`app/`). Managed consumes Open unmodified — verify the Open→Managed contract gate (`src/ops/open-contract.ts` in managed) still passes on the composer surface change (Phase 3/4 touch `open/composer.ts`).
- **AS-BUILT.md** (`~/repos/neutron-open/AS-BUILT.md`) — update on every deploy per each phase (spec-guard pre-commit).
- **SPEC.md** — `SPEC.md:186` moves `[ ]`→`[x]` only when the full acceptance is met; append a Decisions Log entry recording the four deltas as locked once Ryan signs off.
- **No feature flags** anywhere; each phase ships live and is browser/instance-verified (mirror the Work Board Phase-1 "browser-verified on a fresh install" bar).
- **Tests:** registry test (Phase 1), store + HTTP surface tests (Phase 2), Cores resolution + fallback tests incl. the two-project distinct-creds case (Phase 3), awareness-block tests (Phase 4). STRICT/CHECK/ISO-ts migration convention.

## 4. Open questions for Ryan (blockers before Phase 2)

1. **DELTA 1:** New `project_credentials` table (recommended) vs. overloading `secrets`?
2. **DELTA 2:** Per-project OAuth grants for the Google Cores DEFERRED (recommended) or pulled into this wave?
3. **DELTA 3:** Context-injection + graceful refusal (recommended) vs. hard per-project tool-registry gating?
4. **DELTA 4:** Confirm fallback order `per-project → global/instance default → unset`.
5. Which services seed the picker first (Meta Ads / Google Ads named in spec — any others for v1)?
