## Issue #637 — bound Codex app-server control socket paths

### What changed

Two halves, deliberately scoped differently.

**The project key is fixed-width, unconditionally.** The base resolver appended the
sanitized project identifier directly beneath the global Codex directory, so the
derived socket pathname grew with the identifier. Every non-empty project id now
maps to the first 128 bits of SHA-256, encoded as a fixed 22-character base64url
key (`trident/codex-auth.ts:265-277`). This is the half that buys the headroom: a
UUID-shaped id goes from 114 bytes of socket pathname to 93.

**The bound is enforced at the socket, not at the directory.**
`assertCodexControlSocketPath` (`trident/codex-auth.ts:98-102`) measures the
complete composed pathname in UTF-8 bytes and throws
`CodexControlSocketPathError` above 107 — it never truncates and never returns a
shortened path. It is the gate a caller about to start `codex app-server` passes
through. `resolveCodexHome` and `codexProjectHome` are TOTAL
(`trident/codex-auth.ts:250-252`, `trident/codex-auth.ts:265-277`).

### The measurements, taken against the subject

Run here, not carried over from the record:

- The daemon's socket pathname is `$CODEX_HOME/app-server-control/app-server-control.sock`,
  reproduced against codex-cli 0.154.0. That is exactly what
  `CODEX_CONTROL_SOCKET_PARTS` composes (`trident/codex-auth.ts:57-62`).
- **The boundary is 107/108.** With CODEX_HOMEs sized so the derived pathname landed
  on each side: 107 bytes connects, 108 bytes answers `path must be shorter than
  SUN_LEN`. A raw libc `AF_UNIX` bind agrees exactly (107 binds, 108 ENAMETOOLONG).
  So `CODEX_CONTROL_SOCKET_PATH_MAX_BYTES = 107` is measured, not asserted.
- **A runtime bind from this suite cannot witness that boundary.** `node:net` and
  `Bun.listen` both bind pathnames up to 109 bytes on this kernel — a WIDER
  instrument than Codex. The existing bind case is therefore corroboration; the
  byte count is the guard, and the boundary is pinned separately.
- **The issue's "it exits 0" no longer holds at codex-cli 0.154.0.** Measured
  without a pipe (a pipe reports the last command's status, not the CLI's):
  `codex app-server daemon version` exits **1** on both a missing socket and the
  `SUN_LEN` refusal. The observation in the issue was taken at 0.149.1. This does
  not change this half of the fix; it is recorded because the OTHER half of #637 —
  "any wrapper must not treat exit 0 as the daemon answered" — rests on it and may
  now be moot. Follow-up, not addressed here.

### Why the refusal is NOT at the credential resolvers

A first cut asserted the bound inside `resolveCodexHome` and `codexProjectHome`.
Measured: a 26-byte owner home — `<home>/neutron`, the `resolveNeutronHome`
default shape — composes a 109-byte project socket pathname, so `codexProjectHome`
threw. That is the single call behind `connect`, `status`, `refreshSeatLiveness`
and `resolveActiveCodexHome` for a PROJECT-scoped seat
(`trident/codex-credential.ts:386`, `:463`, `:516`, `:743`). A project-scoped Codex
credential that works today would have stopped working — on a box that binds no
control socket at all, since `SPEC.md` records that `codex app-server daemon start`
refuses on this install for want of a managed standalone distribution.

A `CODEX_HOME` serves two unrelated purposes: holding `auth.json` (every caller in
this tree) and deriving a daemon control socket (no caller in this tree). Only the
second needs a bindable socket. Refusing a configuration is better than a silent
failure only when the thing was going to be attempted. The decision is asserted
POSITIVELY in the suite, so re-adding the throw to either resolver reds.

### Cost, named

The project directory is no longer human-readable. Reading `projects/<22-char-key>`
during debugging no longer tells you which project it belongs to; the mapping is
one-way. That is a real loss, accepted because the segment's size then does not
depend on the identifier.

### Tests and mutation evidence

| # | Mutation | Landed line | Mutated | Restored |
|---|---|---|---|---|
| 1 | bound 107 → 100 (too strict) | `trident/codex-auth.ts:53` | RED 48/2 | GREEN 50/0 |
| 2 | bound 107 → 1000 (too lax) | `trident/codex-auth.ts:53` | RED 48/2 | GREEN 50/0 |
| 3 | gate never refuses (`if (false)`) | `trident/codex-auth.ts:100` | RED 47/3 | GREEN 50/0 |
| 4 | measure characters, not UTF-8 bytes | `trident/codex-auth.ts:99` | RED 49/1 | GREEN 50/0 |
| 5 | project key 128 → 64 bits | `trident/codex-auth.ts:55` | RED 48/2 | GREEN 50/0 |
| 6 | no hashing — raw id as segment (the defect) | `trident/codex-auth.ts:276` | RED 48/2 | GREEN 50/0 |
| 7 | re-add refusal to `codexProjectHome` | `trident/codex-auth.ts:276` | RED 49/1 | GREEN 50/0 |
| 8 | re-add refusal to `resolveCodexHome` | `trident/codex-auth.ts:251` | RED 49/1 | GREEN 50/0 |

Each patch was applied with an exact anchor asserted to occur exactly once, so a
silent no-match could not be read as a weak test. Suite:
`bun test trident/codex-auth.test.ts trident/codex-credential.test.ts`.

Both directions are covered on the same call: 107 bytes accepted, 108 refused
(`trident/codex-auth.test.ts`, "the bound turns between 107 and 108 bytes"). The
over-bound case also asserts that NOTHING is returned, so a truncating
implementation cannot pass by handing back a prefix.

### Deliberately not done

No truncation anywhere, no fallback path, no feature flag, no change to the kernel
limit, and no human-readable directory retained as an alternative. The transport
investigation the issue excludes (proxy / WebSocket) was not reopened. The second
half of #637 — a wrapper that must not read exit 0 as success — is not addressed,
and the measurement above suggests it needs re-deriving against the current CLI
before it is worth doing. Statements in already-merged records were left alone.
