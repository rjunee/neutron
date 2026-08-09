# A Kimi key entered in Settings now turns the K3 reviewer on

**Landed:** 2026-08-09 · **Surface:** `trident/kimi-key.ts`, `open/composer.ts`

## The gap

The K3 cross-model reviewer only ever read `process.env.KIMI_API_KEY`. There is no
supported way to set a gateway env var from inside the product, so **a self-hoster
could not enable the second model family at all** — it was reachable only by
whoever could edit the service unit. The owner asked for the key to be enterable in
Open's settings before cutover (SPEC Decisions Log 2026-08-07).

Settings already stored arbitrary per-service credentials, and the store accepts
any lowercase service id, so a key could be *filed* under `kimi` today. **Nothing
read it.** That is the recurring shape: the storage exists, the reader does not.

## What changed

`resolveKimiApiKey(env, lookup)` — **env first, store second**. An install that
already exports the key is bit-for-bit unchanged; the store is consulted only when
the env value is absent, empty, or whitespace. An empty env var is the most common
way a key is "set" and useless, and letting it win would make a good stored key
unreachable while looking like a store bug. A throwing store read degrades to
not-configured rather than taking down a launch.

`ensureKimiKeyExported(env, lookup)` also **writes a stored key into the
environment**, and that side effect is the point rather than a convenience.
`trident/kimi-review-cli.ts` runs in its own process and reads `KIMI_API_KEY` from
ITS env — the indirection that keeps the key out of prompt text, logs and chat.
Reporting `configured: true` for a key the child cannot see would be strictly worse
than being unconfigured: a deferred cross-model reviewer BLOCKS the verdict, so
every review would return REQUEST_CHANGES for a reason the owner cannot see.

The composer calls it per launch, so a key entered in settings takes effect on the
next run rather than the next restart — the same rule the GitHub credential
follows. Resolution is global-scope: a Kimi subscription is one account for the
instance, and this resolver is handed no run to scope by.

The settings placeholder now reads `e.g. openai, github, kimi`, which is the only
thing that makes the service id discoverable in an otherwise free-text field.

## Coverage

`trident/kimi-key.test.ts` (12) pins the precedence and the export. The extended
`tests/integration/kimi-panelist-wired.open.test.ts` (8) asserts it through the
REAL composer, including that the stored key reaches `process.env`.

Mutants killed at both levels: consulting the store before env reds 2 unit tests;
dropping the export reds 3 unit tests AND the integration test that watches the
production composer.

`@neutronai/project-credentials` and `@neutronai/trident` were added to the root
`dependencies` — the integration tests resolve against that list, and without it
the new imports fail to resolve at all.
