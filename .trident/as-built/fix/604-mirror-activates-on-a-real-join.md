## 2026-09-14 — Issue 604 activation investigation: blocked on the collaborator boundary

### Outcome

Investigation only; issue 604 is not fixed. No runtime code, tests, memory rows,
or migration were changed. The instruction to report an undefined join boundary
applies: the host handshake is concrete, but a browser acceptance is not yet a
connection to the collaborator's own memory instance.

Two product decisions are needed:

1. How should a browser guest connect the accepted invitation to their own
   running instance? The present bootstrap supplies no acceptance callback
   (`landing/connect-accept.ts:242`); successful acceptance displays next steps
   and calls the optional callback (`landing/connect-accept.ts:195`). Choosing
   automatic pairing, a manual import, or an instance-initiated acceptance flow
   changes the user-facing join contract.
2. Should historical unscoped memories remain owner-private until explicitly
   assigned to projects? `MemoryStore.add` permits content with no metadata
   (`gbrain-memory/memory-store.ts:38`), and the configured source defaults to
   one instance-wide value (`gateway/wiring/build-gbrain-memory.ts:528`). There
   is no safe inference from that contract to a legacy row's sharing authority.
   Proposed policy for approval: preserve those rows and exclude them from
   export; do not guess their project or distribute them to every project.

### Corrected reachability evidence

The filed claim that the adapter hook is the sole mount is stale.
`runtime/platform-adapter-local.ts:144` explains its omission, while
`open/composer.ts:6572` constructs `connect_api` directly with
`buildConnectNodeWiring`. That builder mounts guest authentication at
`open/wiring/connect-node.ts:155`. Trusted acceptance is deliberately excluded
because this node lacks the corresponding trusted issuer
(`open/wiring/connect-node.ts:22`). An adapter-hook change would not fix this.

Enumerated TypeScript construction references in this working tree using:

```sh
rg -n 'buildSharedProjectsResolver\(|buildConnectNodeWiring\(|mirrorMemoryOnJoin:|importSharedProjectMemoryOnJoin\(' --glob '*.ts' --glob '!**/__tests__/**' --glob '!**/*.test.ts' .
```

The same invocation found the known production positive control
`open/composer.ts:6572`. Its other matches were the node declaration
(`open/wiring/connect-node.ts:141`), the discovery resolver declaration
(`gateway/projects/shared-projects-resolver.ts:133`), the importer declaration
(`connect/shared-project-memory-mirror.ts:404`), and optional forwarding at
`connect/guest-auth-handler.ts:110` and `connect/trusted-accept-handler.ts:163`.
Thus this enumeration found no production construction of the suggested
resolver and no production importer invocation. Construction of the actual
project surface confirms the missing discovery dependency
(`open/composer.ts:4997`). This is a working-tree content finding, not a claim
about a freshly fetched remote ref; no network was used.

The existing graph source ignores its project argument
(`connect/shared-project-memory-mirror.ts:327`) and exports the client-wide page
list (`connect/shared-project-memory-mirror.ts:281`). Adding transport before
partitioning would expose cross-project data. Host-side acceptance cannot choose
the destination client: the existing seam documents that distinction at
`connect/member-join.ts:105`.

### Runtime observations and limits

Attempted the existing production served test file with:

```sh
bun test open/__tests__/open-connect-served.test.ts --test-name-pattern 'guest|handshake'
```

Result: 0 passed, 5 failed, 12 filtered. All five failed while creating the
listener at `open/__tests__/open-connect-served.test.ts:136`, with EADDRINUSE for
port 0. This does not measure join behavior.

A temporary socket-free probe then seeded a disposable database, invoked
`buildOpenGraphComposer` followed by `composeProductionGraph`, and called the
resulting `graph.fetch` with actual Request objects. It used the owner invite
route and then guest authentication, without constructing accept handlers or
supplying a mirror seam. Observed: invite 200; acceptance 200 with collaborator
role; replay 409; one connected-member row; mirror-ledger count zero both before
and after. This exercises the real construction at `open/composer.ts:6572` and
handler at `open/wiring/connect-node.ts:155`. It establishes the host join is
reachable and observes the unchanged host ledger; it does not establish a
remote import target or claim to instrument remote memory writes. The temporary
probe required interruption after printing results because a background timer
remained alive after graph cleanup; it is not reported as a passing test.

### Mutation table

| Guard | Mutation | Red | Restored green |
| --- | --- | --- | --- |
| None added | Not applicable | Not claimed | Not claimed |

There is no new error value, invariant, or enforcement mechanism. Activation,
project authorization, and import replay still require executable guards when
the product boundary is settled. Existing leaf tests cannot prove production
activation; do not interpret their results as completion of this issue.

### Deliberately not done

No adapter hook was added, no second join path was invented, and no cross-project
snapshot was exported. Historical memories remain untouched. No migration was
attempted or certified on a copy: its attribution policy must be settled first,
then checked on a populated copy for preserved rows, duplicates, links, and
idempotent reruns. No spec decision was changed. This record uses the lane's
explicit staging path rather than the usual docs/as-built destination. No push,
PR creation, or merge is authorized for this lane.

### Local checks

- `bash scripts/ci/typecheck-all.sh`: passed all 51 configurations. Used the
  repository matrix because the root package has no typecheck script.
- `bash scripts/ci/lint.sh`: passed.
- `bun test connect/__tests__/shared-project-memory-mirror.test.ts`: 13 passed,
  0 failed. No test files were changed and the full suite was not run.
- Record shape: exactly one second-level heading; explicit forbidden-token and
  worktree-path checks passed. These limited checks are not a full leak-gate
  certification.
- `git diff --check`: passed.
