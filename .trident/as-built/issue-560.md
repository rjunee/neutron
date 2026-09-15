## Issue 560 — derive integration connection state from refresh outcome

### What changed

`OAuthTokenManager.getStatus` now treats a stored `invalid_grant` refresh outcome as a definitive disconnected result even when the access-token row remains present (`gateway/cores/oauth-token-manager.ts:700-714`). The status builder already carries that result into the integration row and maps false to `not_connected` (`gateway/cores/integrations.ts:478-505`).

### Decisions

The existing refresh-outcome vocabulary is `ok | invalid_grant | error | null` (`gateway/cores/oauth-token-manager.ts:119-125`). Only `invalid_grant` changes the connection verdict: the refresh path assigns it for that exact provider response and assigns `error` to other failed responses (`gateway/cores/oauth-token-manager.ts:587-612`). A later successful refresh writes `ok`, so the invariant is continuously maintained by refresh metadata rather than depending on the failed provider request to repair state (`gateway/cores/oauth-token-manager.ts:622-637`).

Inconclusive `error` and missing metadata retain the access-row result. This follows the existing probe taxonomy, where only a definitive revocation changes durable availability and non-verdict outcomes remain unknown (`trident/codex-credential.ts:600-642`).

### Tests and mutation evidence

| Guard | Mutation | RED | Restored GREEN |
|---|---|---|---|
| `connected` excludes `invalid_grant` at `gateway/cores/oauth-token-manager.ts:708` | Restored the former `accessRow !== null` expression; the printed mutation landed at line 708 | `getStatus reports invalid_grant as disconnected while inconclusive errors retain row presence` failed at `gateway/cores/__tests__/oauth-token-manager.test.ts:344-347`; `integrations_list reports a grant rejected by the last refresh as disconnected` failed at `gateway/cores/__tests__/integrations-tools.test.ts:155-158` | Both specific files passed: 20 tests, 0 failures |

Focused coverage constructs a non-empty stored access row, so the before and after values differ (`gateway/cores/__tests__/oauth-token-manager.test.ts:324-342`; `gateway/cores/__tests__/integrations-tools.test.ts:132-150`). It also proves the opposite direction by replacing the metadata with `error` and requiring the same access row to remain connected (`gateway/cores/__tests__/oauth-token-manager.test.ts:349-368`).

Lint passed for the three touched TypeScript files. The gateway typecheck reached two unrelated existing errors in `gateway/transcription/__tests__/whisper-install.test.ts:186` and `onboarding/history-import/__tests__/zip-writer.ts:10`; neither file is changed by this work.

### Deliberately not changed

No new outcome, feature switch, or parallel status path was added. The public integration schema and its `connected` / `not_connected` mapping remain unchanged (`gateway/cores/integrations.ts:484-505`). No product decision or current-target specification changed.
