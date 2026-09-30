## 2026-09-29 — Operator rearm for a capped conversation before supervision

Cold startup refuses a hard-capped Claude conversation, while the existing forced
respawn endpoint requires supervision registration after successful recovery.
The new independently authenticated `POST /admin/rearm-session-cap` closes that dependency.
It requires an Ed25519 operator authorization pinned to protected host/installation
configuration; the web/mobile owner bearer is insufficient. The root-only signing
tool `open/sign-repl-cap-rearm.ts` accepts an exact request on stdin and positional
root-protected private-key path, host ID and installation ID. It emits only the
short-lived signed capability, never the key. Operators run the reviewed tool from
their protected installation. This authorizes one cap release, not child terminality.
It resolves the current conversation provider and credential through the same
authorization path as startup recovery, then compare-and-sets the exact session,
child generation and cap episode under the registry lock. Canonical scope admission
must be open and empty, with no prepared host termination. Deleted, retired, foreign,
busy and mismatched identities refuse without changing the row.
The locked mutation also rechecks the current provider, configured-model override,
credential pool membership/material and substrate retirement after asynchronous
resolution. Deterministic races for provider change, credential replacement/removal
and retirement fail closed, while unchanged authority accepts. Unsigned or oversized
HTTP input cannot consume the operator rate budget; streamed input is bounded before
JSON parsing.

The operation clears only the cap. Normal periodic recovery separately owns any
later resume and retains every ownership, transcript and admission check. Successful
readiness and cap age remain insufficient to clear the operator latch. No historical
native-child evidence is synthesized and no child lease is released.

Focused runtime coverage pairs each refusal with a successful exact rearm and proves
that a separately invoked startup recovery can resume afterwards. The Open composer
test consumes its actual mounted admin handler with no supervision registration,
rejects an unresolved native child and stale/deleted scope, and accepts the exact
released scope without spawning. It then waits for the already-running Open scheduler
to reach the exact recorded-session resume boundary and register supervision, without
another boot or chat; only the native spawn boundary and fixture transcript path are
substituted. Bidirectional semantic mutations and both TypeScript
projects are checked before handoff. This source change does not claim live deployment
or authorization to rearm a particular running conversation.
