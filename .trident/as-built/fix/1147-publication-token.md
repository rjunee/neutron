## 2026-09-17 — Repair publication-token CI fixtures

### Changes and decisions

This follow-up fixes the three CI failures supplied in the lane brief. All were test defects caused by deliberate changes already present on the branch: PR observation now requests and validates a string body (`trident/production-host-effects.ts:189,201`), and migration 154 installs the publication token (`migrations/0154_trident_publication_token.sql:1`, introduced by commit `c3dc9466`).

The composition fixture now supplies an empty PR body (`trident/project-build-host.test.ts:309-310`), allowing its existing panel assertion to exercise the intended composition (`:337`). Both live-ledger repair tests now include 154 in their exact applied-migration lists (`migrations/__tests__/live-ledger-125-repair.test.ts:93,178`). They additionally assert the installed token column (`:99,181`). Exact equality stays in place because these fixtures deliberately apply the full migration tree (`:89,163-167`); the expected inventory should include the new migration, while a missing or extra applied migration should still fail.

### Reproduction and mutation table

Initial isolated reproduction: composition file 28 pass / 1 fail, reporting unknown PR identity before reaching the panel; migration file 2 pass / 2 fail, reporting unexpected applied ordinal 154. No assertions were loosened or removed.

| Property | Mutation, with landing line printed before execution | RED | Restored GREEN |
|---|---|---|---|
| Composition fixture supplies readable PR evidence | Remove `body: ''` at `trident/project-build-host.test.ts:310` | Focused composition test: 0 pass / 1 fail; panel calls zero | Composition file: 29 pass / 0 fail |
| Both repaired databases install the actual token column | Rename SQL column to `publication_token_mutated` at `migrations/0154_trident_publication_token.sql:1` | SQL executes and exact migration inventories pass; both column assertions fail at `migrations/__tests__/live-ledger-125-repair.test.ts:99,181`; file 2 pass / 2 fail | Migration file: 4 pass / 0 fail |
| Existing reconciliation rejects a foreign PR | Invert `!pr.body.includes` at `trident/production-host-effects.ts:407` | Existing foreign-token test receives `allow` instead of `blocked`, 0 pass / 1 fail (`trident/production-host-effects.test.ts:282`) | Foreign-during-push, crash recovery, and foreign-token tests: 3 pass / 0 fail |

All mutations executed valid code and returned incorrect observable results. All were restored. This follow-up adds no production guard, invariant, or outcome vocabulary.

### Citation corrections and branch evidence

The filed brief describes the original implementation. Its creation/persistence range `trident/production-host-effects.ts:381-396` maps to current `:388-413`; the old refusal at `:392-393` maps to current recovery comparison/refusal at `:405-408`; the final store write at `:396` is now `:413`. The original historical record was already superseded by the branch's publication-token change; this follow-up does not rewrite it.

Before editing, `git grep -n -E 'publicationToken|Discovered PR has no publication provenance|async function publishChecked' origin/main -- trident/production-host-effects.ts` found the old refusal at `:393` and the positive-control function at `:363`. This probes the supplied local landing ref, not a freshly fetched ref. The three supplied failing test names were enumerated by one whole-tree `rg` search and mapped to the two test files above.

### Verification and limits

`bun test trident/project-build-host.test.ts migrations/__tests__/live-ledger-125-repair.test.ts trident/production-host-effects.test.ts`: 109 pass, 0 fail, 511 assertions. The two changed files also passed individually. `bash scripts/ci/lint.sh` passed. The repository typecheck gate, `bash scripts/ci/typecheck-all.sh`, passed all 51 configurations. The leak gate exited 3 with zero findings in runnable rules; its file and commit-message PII checks could not run because the private denylist was unavailable, so this is an incomplete result. The focused restored provenance checks passed after the final mutation.

Deliberately unchanged: production implementation, migration SQL, existing publication guards, product decisions, and `SPEC.md`. No full-suite launcher, directory-wide test sweep, network operation, push, PR creation, merge, or history rewrite was performed. Hosted PR creation and a real external crash could not be verified offline. Remote CI status and freshness of the supplied landing ref could not be verified without network access.

### Build-round mutation evidence, folded in from the second record

`AGENTS.md:28` requires one as-built record per change; this branch had grown two for the
same change, so the other is removed and its unique evidence kept here. Line numbers are
the ones current when each mutation ran.

### Mutation table
| Guard | Compiling mutation and printed line | RED result | Restored GREEN |
|---|---|---|---|
| Token shape, `trident/production-host-effects.ts:19` | Replaced the UUID expression with `/^.*$/`; printed line 19 | malformed-intent test received `allow` instead of `unknown` | focused recovery/refusal set: 5 pass, 0 fail |
| Pre-create durability, `trident/production-host-effects.ts:390` | Inverted `!await store.update` to `await store.update`; printed line 390 | failed-persistence test received `allow` instead of `unknown` | focused recovery/refusal set: 5 pass, 0 fail |
| Exact PR proof, `trident/production-host-effects.ts:406-408` | Inverted `!pr.body.includes` to `pr.body.includes`; printed lines 403-410 | foreign PR received `allow` instead of `blocked` | recovery plus foreign test: 2 pass, 0 fail |
| Readable body evidence, `trident/production-host-effects.ts:199-202` | Removed the string-body clause; printed lines 196-204 | malformed observation became `known` instead of `unknown` | focused recovery/refusal set: 5 pass, 0 fail |

**These prove the guards read their inputs. They do NOT establish that the body proof means
what it claims** — see the replay finding below, which no mutation in this table could have
caught, because every one of them varies the guard rather than the evidence it trusts.

### BLOCKING: the proof is replayable — this branch is not mergeable as it stands

An adversarial review reproduced it: a foreign PR on the same branch and head whose body
carries a **copied** `<!-- trident-publication:<token> -->` is adopted as this run's
provenance — expected `blocked`, received `allow`.

The marker is published in a public PR body, so it is not evidence of who created the PR.
Anything able to put that string in another same-repo PR inherits the provenance. This
narrows the #1144 door from "any discovered PR" to "any discovered PR carrying a copyable
string"; it does not close it.

Scope, stated so the finding is not over-read: `readPr` already requires
`isCrossRepository === false`, so a fork PR cannot reach this path. The exposure is
same-repo PRs, which need write access — the accidental-adoption class, not the open
internet.

The mutation table above could not have caught this. Every entry inverts a guard and
watches it go red, which proves the guard reads its input; none asks whether the input
means what the guard assumes. That is the "instrument narrower than its subject" failure,
and it is the second time this class has appeared on this line of work.

Two acceptable resolutions, neither of which is "ship it and file a follow-up":

1. A non-replayable ownership proof — something a second party cannot copy from public
   output.
2. Close #1147 as by-design. The conservative permanent refusal already on `main` is safe,
   and the issue itself argued that: *"That refusal is the conservative direction … so it is
   not a blocker on this branch."* An honest refusal beats a weak proof.
