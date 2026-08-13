# The Kimi key comes from the store, and only the store

## The decision

Owner-directed: *"we shouldn't be using an env var at all — that was a temporary hack,
not a production-grade decision."*

`resolveKimiApiKey` read `KIMI_API_KEY` **first** and fell back to the credential
store. That made the environment a second resolution path, and the reason to remove it
is structural rather than stylistic:

- **The same settings screen produced different behaviour on two boxes**, depending on
  how one of them happened to be provisioned.
- **It failed in the direction nobody checks.** Paste a new key in settings, see it
  saved, and every review keeps using the shell's — with nothing anywhere reporting a
  conflict.

That is the no-dual-code-paths rule applied to configuration.

## What changed

`resolveKimiApiKey(lookup)` — the env argument is **gone from the signature**, which is
the strongest available form of "it is not read": there is nothing to pass.

`ensureKimiKeyExported` still writes the resolved key into the child's environment.
**That indirection is load-bearing and stays** — `kimi-review-cli.ts` runs in its own
process and reads the variable from there, which is what keeps the key out of prompt
text. The env var is now purely an **output** — the channel the resolved key travels on
— never an input.

Two behaviours flipped as a consequence, and both are now asserted:

- **A pre-set env value is overwritten** by the stored key. It used to be preserved
  ("an operator-set value is left exactly as they set it"), which was the silent
  failure above.
- **Clearing the key in settings clears the export too.** Easy to forget, and without
  it a previously-exported key survives in the process environment and the reviewer
  keeps running on a credential the owner believes they removed — the mirror image of
  the bug being fixed.

## The live key was migrated BEFORE this shipped

The reference deployment had its key in the unit env and **nothing at all in the
credential store** (`project_credentials` was empty, verified). Shipping store-only
first would have silenced the K3 reviewer.

So the key was moved into the store first, on the box, by a one-shot script that
printed only lengths and outcomes and never the value:
`env-key-len=51 → migrated=true round-trip-matches=true`, and the row is now
`kimi | global | Kimi K3`. The temporary file was removed and `vendor/` verified clean.

**A lesson from that migration, worth more than the migration:** the script failed
twice with an opaque `failed to open SQLite` that looked like a permissions or locking
problem — root could read the same file with `sqlite3`, and running as the owning unix
user changed nothing. **The cause was `{ create: false }`, an option production never
passes.** A probe that does not use the production call shape can fail in a way that
looks like an environment problem and sends you debugging the wrong system. This is the
same family as "a store probe must use the production READ path" — extended now to its
open options.

## Verification

`trident/kimi-key.test.ts` (12) and `tests/integration/kimi-panelist-wired.open.test.ts`
(8) — the integration one asserts through the **production composer's** resolver, not a
hand-built config.

Tests that pinned the old behaviour were **inverted, not deleted**, so the reversal
stays legible: "ENV WINS over a stored key" is now "the STORE wins over an env var", and
"an operator-set env value is left exactly as they set it" is now "a pre-set env value
is OVERWRITTEN".

**Two mutants, each caught:** a cleared key leaving the stale export standing (2 tests);
a pre-set env value not being overwritten, i.e. the old behaviour restored (3 tests).

Typecheck 51/51 · lint clean.
