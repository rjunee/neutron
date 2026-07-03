# M1 UX Redesign — PR-6: Mobile project rail + seated tabs + Work-badge (LAST redesign PR)

**Target:** the Expo/React-Native app under `app/` (NOT `landing/chat-react` — that is web, done in PR-3). Mobile counterpart of PR-3's desktop rail/tabs. Depends on PR-1..5 (all merged). **NO FEATURE FLAGS. One code path.** Dark-token themed. Ryan-locked design (SPEC 2026-07-02 "M1 UX REDESIGN — SIGNED OFF").

Authoritative visual reference: the dedicated mobile prototype `https://neutron-redesign-proto.netlify.app/mobile/` (saved copy analysed). **Override:** the prototype's rail is a 56px **emoji-only** icon rail, but Ryan explicitly flagged emoji-only as insufficient and asked for **emoji + project NAME below** (Telegram-folder-style). Section A below is authoritative over the prototype on that point; every other treatment (work-dot, seated tabs, Work-tab badge, tokens, spacing) follows the prototype.

Simple-enough-for-Alina bar: the rail must read like Telegram's left folder rail — obvious.

---

## The data contract (verified against the codebase — READ THIS FIRST)

The rail's activity/live-run state is a PR-1 (#180) backend contract. Findings from tracing the code:

- **Canonical activity enum** `ProjectActivity = 'idle' | 'working' | 'attention'` — `open/project-rail.ts:15`. Derivation precedence (`deriveProjectActivity`, `project-rail.ts:46-49`): `attention` wins (a failed-not-done Work-Board item OR a stalled live run) → else `working` (a live chat turn OR `live_runs>0` OR an inline-active run) → else `idle`.
- **`live_runs: number`** = count of non-terminal bound runs. Derived in `open/composer.ts` `readProjectRailExtras()` (`composer.ts:1552-1628`), `live_runs` counter at `:1580`.
- **These fields are NOT on the mobile HTTP endpoint.** `GET /api/app/projects` (`gateway/http/app-projects-surface.ts:699` `handleList`, called by `app/lib/projects-client.ts` `ProjectsClient.list()`) returns per project only: `id,name,description,persona,emoji,privacy_mode,billing_mode,agent_engagement_mode,members[],last_activity_at,unread_count,kind,origin_instance,owning_instance_slug`. **No `activity`, no `live_runs`.**
- **The fields ARE fanned live over the app-ws `projects_changed` WebSocket frame** — the SAME frame the web rail consumes. Frame type `AppWsOutboundProjectsChanged`, per-project shape at `channels/adapters/app-ws/envelope.ts:373-384` (carries `id,label,emoji,unread,last_activity_at,activity,preview,preview_from,live_runs`). Emitted from `open/composer.ts` (`emitProjectsChangedNow`/`emitProjectsChangedIfChanged`, `composer.ts:2198-2214`) on every rail-visible change (create, run transitions, activity flips, stalls, chat turns).
- **Web reference to mirror field names/enums:** `landing/chat-react/config.ts:39-51` (`ProjectTab.activity?/preview?/preview_from?/live_runs?`); web ingest `landing/chat-react/controller.ts:829-842`.
- **On-connect seed:** `on_session_open` already calls `emitProjectsChangedIfChanged(user_id)` (`composer.ts:3421-3423`, "FIX 1 #85 — seed the projects rail baseline on connect"). BUT it is **diff-gated on a per-user global snapshot hash** — if another session (e.g. web) already consumed the current snapshot, a freshly-connected mobile socket receives NO frame until the next real change. So a mobile rail that only subscribes will show stale `idle` dots on open when the set is unchanged.

### Chosen architecture (DECISIVE — the composer frame is the single source of truth; do NOT duplicate derivation)

1. **Rail SET** comes from the existing HTTP list (`fetchProjects` → id/name/emoji/unread). The rail is never empty on first paint; activity defaults to `idle` (no dot) until the frame overlays it.
2. **Rail activity/live_runs** come from a live subscription to the app-ws `projects_changed` frame — a new lightweight subscriber mirroring `app/lib/work-board-live.ts` (injectable socket factory, RN+DOM-compatible, read-only, best-effort reconnect). This keeps the composer as the single source of truth — **no re-derivation in the gateway or client** (avoids drift; respects the leak-gate/parity ground rules).
3. **Reliable initial state (minimal server change):** make `on_session_open` push the current projects snapshot to the *newly-connected* session reliably rather than relying on the global diff-gate. Prefer a session-targeted emit; if the emit helpers only broadcast, calling `emitProjectsChangedNow(user_id)` on connect is an acceptable fallback (connects are infrequent; clients diff-apply). Keep this change tiny and localized to the `on_session_open` seed region (`composer.ts:~3421-3423`). Investigate `emitProjectsChangedNow`/`emitProjectsChangedIfChanged` + the app-ws session registry `send` before choosing.

`preview`/`preview_from` are NOT needed — the Telegram-folder rail shows emoji+name, not a preview line. Carry them through the subscriber harmlessly if trivial, but do not render them.

---

## Scope (mobile app rail + tabs ONLY)

### A. Mobile project rail — Telegram-folder-style (emoji + NAME BELOW + work-dot)
New persistent vertical rail on the LEFT of the project workspace (matches the prototype `body { grid-template-columns: <rail> 1fr }`). Currently there is **no** persistent mobile rail — the switcher is the full-screen card list (`app/app/projects/index.tsx`) and the workspace (`app/app/projects/[id]/_layout.tsx`) has only header + tabs + slot. This PR adds the rail into the workspace layout.

New component `app/components/ProjectRail.tsx`. Per project entry:
- Project **emoji** (~26px identity glyph).
- Project **NAME directly BELOW the emoji** — small label (`TYPOGRAPHY.caption`), 1 line, ellipsised (`numberOfLines={1}`); font-weight bumps when `unread_count>0`.
- Per-project **work-activity dot** on the emoji's corner: `working` → pulsing `--work` @2.4s / `attention` → static `--attention` / `idle` → none. **General has no dot.** Respect reduced-motion (gate the pulse via `AccessibilityInfo.isReduceMotionEnabled`, mirroring `SlotFader` in `_layout.tsx`).
- Active project visually selected (active-bg highlight per the prototype `.icon.active`).
- Tap switches project → `router.replace('/projects/<id>')`.
- A `+` affordance at the bottom of the rail to add a project (prototype's `+` icon). Lowest-risk: navigate to the projects list screen (`/projects`, which owns Create Project). Inline create is optional if cheap.
- Rail width sized to fit a short name below the emoji (~72px; tune to the prototype's proportions — the prototype icon rail is 56px but that's emoji-only; widen for the name).

Pure, RN-free, unit-tested helper module `app/lib/project-rail-view.ts` (mirrors PR-3 web `railDotClass`): e.g. `railDotKind(activity, isGeneral): 'work' | 'attention' | null` (General always null; idle/absent → null; working → 'work'; attention → 'attention'). Add whatever small pure derivations the component needs so logic is testable without mounting RN (the app suite never mounts RN — see existing `*.test.ts` convention, e.g. `project-card-interactivity.test.ts`).

### B. Seated tabs on mobile
Match PR-3's desktop **seated tabs** on mobile: the tab band reads as seated sheets, the active tab fuses to the content sheet. In `app/components/ProjectTabBar.tsx` `NarrowTabBar` (the phone/native path), replace the current underline/`surface_raised`-pill treatment with the prototype's seated treatment:
- Band: `align-items:flex-end`, top padding, bottom hairline, `surface` background (prototype `.tabs`).
- Tab: `border:1px transparent`, `border-bottom:0`, `borderRadius` top corners only (`9 9 0 0`), muted text (prototype `.tab`).
- Active tab: text `fg`, weight bump, background = content `background`, `borderColor` = hairline, and `marginBottom:-1` so it fuses over the band's bottom border (prototype `.tab.active`).
Keep touch-sized. RN can't do a real negative-margin border-fuse identically; approximate faithfully (top-rounded seated sheet + active fused to content bg + overlapping the hairline). Keep the `WideTabBar` (web-wide) path unchanged.

### C. Work-badge on the mobile Work tab
The mobile **Work tab** shows a badge with the live-run count (prototype `.tab .cap`, phase-build tinted, e.g. "2") — consuming the CURRENT project's `live_runs`. Render only when `live_runs>0`.

**Note — verify the Work tab exists on mobile first.** The tab set is registry-driven (`GET /api/app/projects/<id>/tabs` → `descriptorsToResolvedTabs`); the loading default `PROJECT_TABS` (`app/lib/project-tabs.ts`) is `chat/launcher/tasks/reminders/docs/settings` — **no "work" entry**, and `app/app/projects/[id]/workboard.tsx` exists as a route but is not linked from any tab bar today. During PLAN: determine the Work tab's real key on mobile (is it emitted by the server tab registry? is it `workboard`? or must this PR also register it as a builtin tab?). The badge attaches to whichever tab routes to the Work board. If the Work tab is genuinely absent on mobile, registering the builtin Work tab is IN SCOPE for this PR (it's the tab the badge lives on); wire it to the existing `workboard.tsx` route. Keep the tab set change minimal and one-code-path.

To feed the badge, the layout needs the current project's `live_runs` — it already has it from the same `projects_changed` overlay used by the rail (overlay by `project_id`).

---

## Files (expected; PLAN confirms)
- `app/components/ProjectRail.tsx` — NEW rail component.
- `app/lib/project-rail-view.ts` — NEW pure helper (dot-kind etc.), RN-free.
- `app/lib/projects-rail-live.ts` — NEW app-ws `projects_changed` subscriber (mirror `work-board-live.ts`; injectable socket factory).
- `app/lib/theme.ts` — ADD `work` + `attention` color tokens (mirror web `--work:#66ccff`/`--attention:#ffd27d`; PHASE colors already added in PR-2). Re-export unaffected.
- `app/lib/projects.ts` + `app/lib/projects-client.ts` — ADD optional `activity?: ProjectActivity` + `live_runs?: number` to `Project`/`ProjectListItem` (back-compat: absent ⇒ idle/0). The overlay writes these; HTTP list leaves them undefined.
- `app/app/projects/[id]/_layout.tsx` — restructure narrow/native body to `[ProjectRail | (tabs+content)]`; fetch the project list; subscribe to the overlay; pass current project's `live_runs` to the tab bar; pass per-project activity/live_runs to the rail.
- `app/components/ProjectTabBar.tsx` — seated NarrowTabBar + Work-tab `live_runs` badge (thread a per-tab-key badge count in via props/tabs).
- `open/composer.ts` — minimal on-connect snapshot fix in `on_session_open`.
- Tests: `app/__tests__/project-rail-view.test.ts` (pure helper), `app/__tests__/project-rail.test.tsx` (rail render: name-below, dot kinds, active, General no-dot, reduced-motion), `app/__tests__/projects-rail-live.test.ts` (subscriber parse via fake socket), tab-bar seated + badge test. Follow existing `__tests__` conventions (bun test; no RN mount — pure logic + light component tests as the repo already does).
- `SYSTEM-OVERVIEW.md` — FLAG the mobile UI section change (see below).

## HARD RULES
- NO FEATURE FLAGS. One code path (replace the underline tabs; add the rail — do not keep an old+new toggle).
- Dark-token themed via `app/lib/theme.ts` — no inline magic hex in components (theme guard; add tokens to theme.ts first). The mobile app is dark-only today; "light+dark" in the dispatch is aspirational — use tokens consistently so a future light theme works, do not invent a light palette.
- Open leak-gate SILENT — no multi-occupant/isolation vocabulary, no banned retired identifiers. Run `bash scripts/ci/leak-gate.sh --tree .` before push.
- Motion: reduced-motion gated pulse.
- Match the prototype's spacing/tokens.

## Verify (real local + component/unit tests)
- `tsc` clean for the app (`cd app && bunx tsc --noEmit` or the app's typecheck script) AND for `open`/gateway if touched (use the correct tsconfig — root tsc misses trident; check the touched package's tsconfig).
- Rail + tab + badge + subscriber + helper tests green (`cd app && bun test`).
- Leak-gate SILENT.
- Where feasible, a real local run: boot the Open server (quiet install pattern), exercise the app so the rail renders emoji+name-below, a project with a live run shows the pulsing dot, active is selected, General has no dot; the Work tab shows the live-run badge when `live_runs>0`. Screenshot if the harness allows. Component/unit tests are the primary gate.

## SYSTEM-OVERVIEW.md change to FLAG in the PR
Mobile UI section: the mobile project rail is now Telegram-folder-style (emoji + name-below + per-project work-dot), the tab band is seated (active tab fused to content), and the mobile Work tab carries a live-run badge. The rail's activity/live_runs are driven by the existing app-ws `projects_changed` frame (single source of truth in the composer); `on_session_open` now reliably seeds a freshly-connected session's rail.

## Out of scope
Desktop web (PR-1..5), docs drill-down (PR-5 shipped it), preview-line on the rail, any re-derivation of activity/live_runs outside the composer.
