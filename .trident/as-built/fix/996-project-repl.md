## 2026-09-15 — project builds lazily create the long-lived conversation REPL

### Built

The project build context now owns a narrow `spawnProjectSession` seam (`open/wiring/project-build.ts:17-27`). An Anthropic acting turn first refuses ambiguous registration and invalid grants, then invokes that seam when the sole candidate is absent, unpooled, pending, or dead; after the spawn it re-runs the exact-one lookup and the pre-existing readiness, child, and grant checks (`open/wiring/project-build.ts:57-85`). The created session remains in the persistent pool, so the second acting turn does not spawn again (`open/__tests__/project-build-wiring.test.ts:161-184`).

The substrate wiring now exposes a project-pinned factory while deriving both ordinary chat and cold-build creation from one live-agent construction path (`open/wiring/substrates.ts:256-319`). That path retains the warm-chat profile and tool bridge (`open/wiring/substrates.ts:269-315`); its focused test observes the requested project id and the unchanged launch properties (`open/__tests__/open-wiring-substrates.test.ts:276-285`). The composer supplies the seam by draining the same warm-up helper that starts and retains a persistent conversational session (`open/composer.ts:1160-1176`).

### Decisions

Creation is lazy on first build need, matching the decided issue approach. It does not pre-create sessions at boot. Ambiguity is checked before spawning, and grant refusal is checked both before a recovery attempt and after it, so a second session is never selected and an invalid launch is never respawned around (`open/wiring/project-build.ts:59-83`). No new outcome vocabulary was added: spawn/readiness failures remain `unknown`, while provider and grant denials remain `refused`; the existing acting-turn consumer therefore keeps its prior handling defaults (`open/wiring/project-build.ts:58-84`).

### Tests and mutation

| Guard | Compiling mutation | RED | Restored GREEN |
|---|---|---|---|
| Cold or dead session invokes `spawnProjectSession` (`open/wiring/project-build.ts:70`) | Replaced `candidateSession === undefined || candidateSession.hasChildExited()` with `candidateSession !== undefined && candidateSession.hasChildExited()`; the printed mutation landed at line 70 | `acting turn lazily starts and retains a cold project session`: expected `turn-ended`, received `unknown`; 4 pass, 1 fail | Both focused files: 47 pass, 0 fail, 282 assertions |

Validation also passed `bunx tsc -p open/tsconfig.json --noEmit`, `bun scripts/ci/void-promise-check.mjs` (both checks found zero violations), and `git diff --check`.

### Citation corrections and deliberate exclusions

The filed `open/wiring/project-build.ts:58-68` citation still covered the original acting-turn checks. Its pre-warm citation moved: the described block is now `open/wiring/substrates.ts:233-240`, not lines 237-240. The staged issue body had 67 lines and did not include the referenced comment, so the task brief's explicit decided approach supplied that instruction.

No boot-wide project enumeration was added. No driver behavior beyond obtaining a session changed, and no files under the excluded driver directory were modified; the changed-file set was enumerated with `git diff --name-only` and contained only the two Open wiring modules, their composer call site, and their two focused tests before this record was added.
