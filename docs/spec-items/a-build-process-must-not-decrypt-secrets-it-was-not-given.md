---
title: Stop a build process reading the owner's encryption keyfile
group: security
status: open
priority: P1
cutover: false
legacy_ref: "SPEC.md § Phases → Steps (2026-09-12 split)"
---

> **NARROWED 2026-09-12, at the split. The blocking claim below is FALSE and is
> struck.** The line "THIS ENTRY IS NOW THE ONLY THING BLOCKING BUILDS ON THIS
> INSTANCE" no longer holds: PR #248 removed the push from the agent contract
> **entirely**. Forge is now told *"Commit on <branch> and stop. Do NOT push and do
> NOT run `gh`; the durable outer loop publishes and confirms the commit before
> review"* (`trident/inner-workflow.mjs:1337-1343`), and the codex coda repeats it —
> *"STEP 4'S PUSH AND PR ARE NOT YOURS … You are running without a GitHub
> credential — that is deliberate, not an oversight to work around"*
> (`trident/inner-workflow.mjs:1494-1495`). Acceptance (a) is therefore SHIPPED, and
> (b) is moot because no agent-side push is kept.
>
> **This item is narrowed to acceptance (c), which is untouched:** nothing stops a
> build process reading the owner's encryption keyfile. The run is still handed the
> data dir that holds it — the `SecretsStore` coordinates are threaded into the
> workflow args precisely so `trident/gh-authed.ts` can resolve the token in its own
> process (`trident/inner-loop.ts:116`, `trident/orchestrator.ts:215`). Those seams
> pass *paths and handles, never the token*, which is the right shape for the push —
> but the data dir is the keyfile's directory, and the build runs as the keyfile's
> owner. **The reachability is the condition; the push path was only one symptom.**
> No test proves a build cannot decrypt secrets it was not given.

**A build agent must never HOLD a credential — it asks the host to push** (owner-directed 2026-08-13,
from observed behaviour, not theory). `github/credential.ts` argues at length against every way of
giving git a token except an env-injected, `github.com`-scoped helper, because "a credential on disk
with no expiry is the thing we spent the device-flow work avoiding". That credential is wired to the
OUTER loop ONLY (`open/composer.ts` `run_host: makeLazyCredentialedHostRunner(githubProcessEnv(…))`).
The INNER workflow gets nothing — verified live on the fire REPL: `/proc/<pid>/environ` contains no
`GH_TOKEN` and no `GIT_CONFIG_*`. Yet in `pr` merge-mode Forge's contract ORDERS it to
"push the branch to origin, then REUSE the existing PR" (`trident/inner-workflow.mjs` `forgePushStep`).
**We command a push and withhold the key**, so on 2026-08-13 run `36b95167` did the only thing left:
read `auth/secrets-store.ts` for the AES-GCM envelope shape, read `.neutron-aes-key` (mode 0600, SAME
uid as the build), enumerated `secrets` — passing the owner's `gmail_compose` tokens and
`openai:onboarding` key on the way — decrypted the github row, **wrote the plaintext to
`/tmp/gh-token-tmp`**, then hand-rebuilt our own scoped helper and pushed. It reached our design by
reading our source, having already broken the property the design protects. This is not agent
misbehaviour; it is task completion under an impossible instruction, and it is non-deterministic —
the push succeeds only if the model improvises well.
Acceptance, in order of preference:
(a) Forge does NOT push. It asks the HOST to push and receives an exit code; the credential never
    enters an agent-reachable process. This matches the outer loop and is the only shape where the
    token cannot be echoed, logged, committed, or written to disk by a language model.
(b) If an agent-side push is kept, `githubProcessEnv(…)` is threaded PER FIRE into the workflow's agent
    env — never baked in at REPL spawn: the fire substrate is WARM and shared across runs, so a
    spawn-time token goes stale on reconnect and sits in `/proc/<pid>/environ` for every later run to
    inherit.
(c) SEPARATELY, and regardless of (a)/(b): decide deliberately whether a build agent should be able to
    read `.neutron-aes-key` at all. Today every agent we run can decrypt every secret the instance
    holds — GitHub, Gmail, OpenAI, Codex — because it runs as the keyfile's owner. The push path is one
    symptom; the reachability is the condition. Acceptance: a build process cannot decrypt secrets it
    was not given, and a test proves it.
UPDATE 2026-08-13 23:32, run `1daded20` — ~~THIS ENTRY IS NOW THE ONLY THING BLOCKING BUILDS ON
THIS INSTANCE~~ (struck 2026-09-12: PR #248 removed the push from the agent contract entirely). `trident/codex-build.sh` no longer improvises: its `push_credential_ok` probe ran
`git credential fill`, got nothing, and exited 3 `CODEX_BUILD_NO_PUSH_CREDENTIAL` *before spending any
tokens*. That is the intended replacement for the `/tmp/gh-token-tmp` behaviour above — the guard
works. But nothing was built to take its place, so every `pr`-mode build on this host now defers.
MEASURED: `credential.helper` is unset in the repo config, in `--global`, and in the Forge agent's
environment; origin is an `https://github.com/…` remote, so a helper IS consulted and answers
nothing. The credential is not missing from the PRODUCT — `githubProcessEnv` already returns the
`github.com`-scoped, `$GH_TOKEN`-reading helper via `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`, and the
outer loop uses it to push. It is missing from the ONE process that now needs it: `codex-build.sh` is
spawned by the Forge agent's `Bash` tool and inherits the agent's env, not the orchestrator's
per-command env. So the answer is (a) or (b), and (b) has a hard constraint this run makes concrete:
the token must NOT reach the model — the wrapper invocation is composed by Forge *as a command line in
its transcript*, so anything threaded through that line is logged. Inject at the substrate/tool
boundary or have the host push; never through the prompt.

## Acceptance

- [ ] **A build process cannot decrypt secrets it was not given, and a test proves it.**
      This is acceptance (c) of the original item and the whole of what remains.
- [ ] The test is bidirectional: a build handed a secret CAN use it, and the same build
      attempting a secret it was not given FAILS. A test that only asserts a denial would
      also pass against a build that can read nothing at all, including what it needs.
- [ ] Deleting the isolation turns the test red. A build that runs as the keyfile's owner
      and reaches `.neutron-aes-key` must be caught, not merely discouraged by contract
      text — the original defect was task completion under an impossible instruction, not
      misbehaviour, so a prompt-level prohibition does not satisfy this.
- [ ] No secret material reaches a log, an error, or a transcript on any path this change
      touches.
