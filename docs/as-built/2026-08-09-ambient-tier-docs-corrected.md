# The ambient tier's comments said "macOS Keychain". That cost an investigation.

**Landed:** 2026-08-09 · **ISSUES:** #517 (safe half) · **Docs-only, no behaviour change**

## What was wrong

Two docblocks described the ambient credential tier as a macOS-only convenience:

- `gateway/wiring/resolve-llm-credentials.ts` — "the macOS *Claude
  Code-credentials* Keychain item", and "Open single-owner ONLY; Managed never
  allows it";
- `open/composer.ts` — "the owner ran `claude` login on this Mac", "the box owner's
  own", "SINGLE-OWNER ONLY".

Both mislead, and believing them produces a **dangerous** conclusion:

1. The probe (`open/ambient-claude-auth.ts`) branches on **platform**. macOS reads
   the Keychain; **every other platform reads `$HOME/.claude/.credentials.json`**.
   On a hosted Linux deployment that file is written by the credential rotator, so
   this tier is a normal production path there.
2. "Managed never allows it" is true only of that one function. The Open composer
   sets `allowAmbient: true` itself, and a hosted install boots that composer — so
   ambient is reachable, and was **measured on a live hosted install as the ONLY tier that
   resolved**, because tiers 2 and 4 were unset.

A reader who believed the old comments would conclude the install was misconfigured
and "fix" it by disabling ambient — leaving that deployment with **no credential at
all**. That is exactly what the #517 tracker note proposed.

## What changed

The comments now describe both platform branches, say plainly that `allowAmbient`
is a statement about which *composer* enables the tier rather than which
*deployment* runs it, and record the known limitation where it is relevant: an
ambient pool holds one credential-less entry, so it has **no failover** — rotation
happens outside it, at the file level.

**The pool id `ambient_keychain` is deliberately NOT renamed.** It becomes
`credential_identity`, which is folded into `poolKeyFor()` — renaming it re-keys
every warm REPL, the same stranded-pool-key hazard #143's review reproduced. That
is a migration, not a rename. My own SPEC note called it "safe and separable"; it
is separable but **not safe**, and that note is corrected too.

## Coverage

No new test: the platform branch was **already** pinned
(`open/__tests__/ambient-claude-auth.test.ts` — linux consults the creds file, not
the Keychain). Only the prose was wrong. What was added is a comment on those two
cases explaining what they protect, so a future reader trusting the pool's NAME
doesn't delete the guard. Mutant: collapsing the probe to Keychain-only — the exact
"simplification" the old comments invited — reds both.
