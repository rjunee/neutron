---
title: Re-publish a built commit after a credential blink, without rebuilding
group: trident
status: open
priority: P1
cutover: false
legacy_ref: "SPEC.md § Phases → Steps (2026-09-12 split)"
---

> **NARROWED 2026-09-12, at the split.** Acceptance (a) LANDED — the publish-failure
> classifier exists (`PublishFailureClass`, `trident/orchestrator.ts:855`), and a
> stored reason distinguishes a credential failure from a rejected ref. But
> `PUBLISH_CREDENTIAL_CLASS` (`trident/orchestrator.ts:856`) has **zero production
> consumers**: a whole-tree search finds exactly one occurrence, its own `export`.
> It is dead code, so (c) — `publish-credential` joining the auto-retry class list —
> is declared and not wired.
>
> **What is still wanted is (b), and (c) behind it:** a publish-only resume that
> re-pushes the SAME sha without re-running Forge. The commit is already made; only
> the push failed. (a) is kept below as context, not as work.

**The push credential can vanish mid-run, and when it does a FINISHED, REVIEWED build is
thrown away** (measured 2026-08-14 overnight, runs `9bb31a2e` and `9e0f1a8b`). Both reached
`forge-done` — the work was built and reviewed — and then died at the publish rung with git's
own words: `fatal: could not read Username for 'https://github.com': No such device or
address`. That is the publisher holding NO GitHub credential at push time.
**It is intermittent, not absent.** The same publisher pushed successfully three times earlier
the same night (08:38, 08:42, and the push behind PR #262, MERGED 08:49:02Z) and could not
push at 09:04 and 09:10. So a credential that was live at 08:49 was gone by 09:04. The gateway
process carries `NEUTRON_GITHUB_CLIENT_ID` (device-flow OAuth) and no static token, so the
token is fetched per push and its expiry/refresh is the suspect. NOT MEASURED: which of expiry,
revocation or a failed refresh — do not assert one without reading the fetch path.
**The credit where due:** the reason above is READABLE ONLY because of the stderr-carrying fix
in #259. Before it, this was indistinguishable from the non-fast-forward failure it replaced —
both said `outer publisher could not push branch <b>` and nothing else.
**THE REAL COST IS THE DISCARD.** A build that is complete and reviewed should not be
destroyed by a credential blink. Verified: the commits survive on LOCAL branches
(`trident/work-board-row-state-a-card-must-no` at `a96eb95`, unpushed) — so the work exists and
nothing retries it. The run is stamped `failed`, the card reads failed, and a human must
notice. Relaunching is the WRONG remedy: it rebuilds from scratch and hits the same wall.
Acceptance:
(a) A publish that fails for a MISSING/REJECTED credential is distinguished from one that
    fails for a rejected ref, by reading the stored reason alone. Assert both, and assert the
    reason still never contains credential material (the #259 disclosure guard must hold).
(b) The built commit is NOT discarded. A publish-credential failure leaves the run in a state
    that can publish LATER without rebuilding — the commit is already made; only the push
    failed. Assert a re-publish after the credential returns produces the same sha, and does
    not re-run Forge.
(c) `publish-credential` joins the auto-retry class list in the entry above, with a backoff
    long enough to outlast a token refresh.
(d) When it is genuinely unrecoverable, the owner is told WHICH surface reconnects GitHub —
    never a shell command, per the credential doctrine.
NOTE for whoever builds this: dispatching more builds while the credential is down is waste —
every one of them will build, review, and then fail at the same rung. Whatever fixes this
should also make that state visible enough that a queue is not fed into a wall.

## Acceptance

- [ ] A publish-credential failure leaves the run in a state that can publish LATER
      without rebuilding. Assert a re-publish after the credential returns produces
      **the same sha**, and does NOT re-run Forge — a test that only proves the push
      eventually succeeds would also pass if the whole build were redone.
- [ ] `PUBLISH_CREDENTIAL_CLASS` has a production consumer. It is dead today
      (`trident/orchestrator.ts:856` is its only occurrence in the tree), so a search
      finding only its own export means this is not built.
      verify: `rg -n "PUBLISH_CREDENTIAL_CLASS" --glob '!**/*.test.ts'` names a caller
- [ ] `publish-credential` auto-retries with a backoff long enough to outlast a token
      refresh, and `publish-ref-rejected` / `publish-unknown` still NEVER auto-retry.
      Assert the negative with a mutant that broadens the class list.
- [ ] The stored reason still never contains credential material, with a positive
      control proving that assertion can fail.
- [ ] When it is genuinely unrecoverable, the owner is told WHICH surface reconnects
      GitHub — never a shell command, per the credential doctrine.
