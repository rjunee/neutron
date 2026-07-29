/**
 * bun test preload — substrate-credential env hermeticity.
 *
 * Bun auto-loads the repo `.env` for every `bun test` run. A developer
 * `.env` that carries a real `CLAUDE_CODE_OAUTH_TOKEN` (the live Claude
 * Max token the running server uses) then leaks into the unit suite,
 * where `InterviewEngine.maybeAutoAdvancePastMaxOauthOffered` treats a
 * non-empty token as "Max already attached" and AUTO-SKIPS past the
 * `max_oauth_offered` phase (per Sam's 2026-05-28 self-host stop-gap).
 * That auto-skip is correct PRODUCT behavior — but it makes ~48
 * onboarding unit tests environment-dependent: they exercise the
 * not-yet-attached connect/byo/skip routing and must start from a clean
 * substrate, exactly as CI (no real `.env`) sees it.
 *
 * Deleting the token here makes the whole `bun test` run hermetic and
 * reproducible regardless of the developer's `.env`. Tests that need the
 * token PRESENT (e.g. `phase-max-oauth-offered-auto-skip.test.ts`, the
 * Open single-owner e2e walkthrough) set their own value in `beforeEach`
 * /`beforeAll` and restore it — those paths run after this preload and
 * are unaffected.
 *
 * Scope: this affects `bun test` ONLY (bunfig `[test] preload`). The
 * server boot path (`bun run open/server.ts`) does NOT load this file, so
 * a self-hosted install still reads its real token at runtime.
 */
delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
