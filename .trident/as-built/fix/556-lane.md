## 2026-09-14 — A terminal deploy wakes its requesting conversation

### What changed

Host deploy now emits a typed terminal outcome containing the requesting topic, ref, sha, result kind, and secret-scrubbed detail (`open/host-deploy.ts:311-318`, `open/host-deploy.ts:790-800`). Both authenticated dispatch paths call the same wake seam after `performDeploy` settles: a standing-window request at `open/host-deploy.ts:957-962`, and an approved tap at `open/host-deploy.ts:1675-1677`.

The new observer composes an acting turn with the live agent tool surface and posts the resulting reply back to the same topic (`gateway/proactive/terminal-deploy-wake.ts:45-76`). Open constructs that observer on the shared project-chat turn queue, maps the requesting topic back to its project scope, and installs it as the host-deploy terminal callback (`open/composer.ts:3049-3071`, `open/composer.ts:3122-3127`). The callback starts through `fireAndForget`, so a failed wake cannot rewrite a deploy result already returned by the control plane (`open/host-deploy.ts:790-800`).

### Decisions and outcome vocabulary

The outcome joins the existing `performDeploy` vocabulary: `accepted`, `refused`, `timeout`, `error`, and `unconfigured` (`open/host-deploy.ts:1697-1766`). The observer treats `accepted` as quiet success and every other existing or future kind as loud by default (`gateway/proactive/terminal-deploy-wake.ts:65-66`). A timeout retains its existing unknown semantics and gets a dedicated instruction to inspect status before any retry (`gateway/proactive/terminal-deploy-wake.ts:31-39`); other results default to taking the most valuable available next action.

The requesting-topic invariant is maintained at both complete dispatch call sites, enumerated with `rg -n "performDeploy\\(|wakeRequestingSession\\(" open/host-deploy.ts`: the definition and exactly two callers appeared at `open/host-deploy.ts:958`, `open/host-deploy.ts:1675`, and both adjacent wake calls appeared at `open/host-deploy.ts:962`, `open/host-deploy.ts:1676`. The same search's positive control was the known `performDeploy` definition at `open/host-deploy.ts:1697`. The callback is required by the service contract (`open/host-deploy.ts:649-653`), and Open arms it when installing host deploy (`open/composer.ts:3050-3071`, `open/composer.ts:3127`); an LLM-less install takes the explicit no-wake branch (`gateway/proactive/terminal-deploy-wake.ts:48-50`).

### Mutation evidence

Every mutation was applied alone, its landed line was printed, and its targeted test was run before restoration.

| Guard | Mutation | Landed | Red evidence | Restored |
|---|---|---|---|---|
| Approved-tap terminal wake | removed the wake call | `open/host-deploy.ts:1677` before the required-callback cleanup; restored at current `open/host-deploy.ts:1676` | expected one terminal outcome, received none | 131 pass |
| Standing-window terminal wake | removed the wake call | `open/host-deploy.ts:963` before the required-callback cleanup; restored at current `open/host-deploy.ts:962` | expected the accepted terminal outcome, received `undefined` | 131 pass |
| Production arm | removed `on_terminal` from the service installation | `open/composer.ts:3127` | wiring test expected two split segments, received one | 131 pass |
| Missing LLM guard | inverted the null check | `gateway/proactive/terminal-deploy-wake.ts:49` | contained-failure assertion received no logged error because the available observer was skipped | 131 pass |
| Observer failure containment | rethrew from the catch block | `gateway/proactive/terminal-deploy-wake.ts:68` | expected a resolved observer promise, received a rejection | 131 pass |
| Timeout is unknown | classified `accepted` instead of `timeout` | `gateway/proactive/terminal-deploy-wake.ts:37` | timeout prompt lacked `UNKNOWN, not failed` | 131 pass |

Service assertions prove an approved tap wakes once and a repeat tap does not duplicate it (`open/__tests__/host-deploy.test.ts:714-743`), while the standing-window assertion proves the second dispatch path carries the same terminal payload (`open/__tests__/host-deploy-window.test.ts:307-333`). Observer tests prove requesting-topic delivery, unknown timeout guidance, unavailable-LLM behavior, failure containment, and data quoting (`gateway/proactive/__tests__/terminal-deploy-wake.test.ts:46-88`). The composition test pins construction, installation, and use of the shared acting-turn queue (`open/__tests__/open-terminal-deploy-wake-wiring.test.ts:9-12`).

### Verification

- `bun test gateway/proactive/__tests__/terminal-deploy-wake.test.ts open/__tests__/host-deploy.test.ts open/__tests__/host-deploy-window.test.ts open/__tests__/open-terminal-deploy-wake-wiring.test.ts` — 131 pass, 0 fail.
- `bunx eslint gateway/proactive/terminal-deploy-wake.ts gateway/proactive/__tests__/terminal-deploy-wake.test.ts open/host-deploy.ts open/composer.ts open/__tests__/host-deploy.test.ts open/__tests__/host-deploy-window.test.ts open/__tests__/open-terminal-deploy-wake-wiring.test.ts` — green.
- `bunx tsc --noEmit` — no errors in changed files; the command remains red on three unchanged test-file errors at `gateway/transcription/__tests__/whisper-install.test.ts:186`, `logger/__tests__/fire-and-forget.test.ts:301`, and `onboarding/history-import/__tests__/zip-writer.ts:10`. `git diff --name-only origin/main --` over those three paths returned empty; the same command's positive control over `open/host-deploy.ts` returned that changed file.
- `git diff --check` — green.
- `bash scripts/ci/leak-gate.sh` — zero findings in every rule that ran; exit 3 because the local PII denylist is unavailable, so its two rules could not run.

### Deliberately not changed

The existing inert `post_notice` path remains for standing-window audit notices and stale-approval expiry; it is not an acting turn (`open/host-deploy.ts:643-653`, `open/composer.ts:3122-3127`). No deploy approval, precondition, timeout, retry, or authenticated-dispatch behavior changed. No product decision in `SPEC.md` or a spec item changed.
