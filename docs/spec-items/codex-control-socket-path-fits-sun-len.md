---
title: Keep Codex control sockets within Linux sun_path
group: trident
status: done
priority: P2
cutover: false
---

Issue #637. A `CODEX_HOME` that a daemon will derive an app-server control socket
from must produce a pathname that fits Linux `sockaddr_un.sun_path`, or be refused
before the Codex CLI is invoked. Per-project directory keys have fixed width
regardless of project identifier length. The complete pathname is measured in UTF-8
bytes; it is never silently truncated.

## Acceptance

- [x] The bound is derived from Linux's 108-byte `sun_path` — 107 pathname bytes
      after reserving the terminating NUL — and is MEASURED against the subject:
      codex-cli 0.154.0 connects at 107 and reports `path must be shorter than
      SUN_LEN` at 108. Verify: `trident/codex-auth.test.ts`, the test named "the
      bound turns between 107 and 108 bytes".
- [x] Both directions on the same call: a 107-byte composed pathname is accepted
      and a 108-byte one is refused. Verify: `trident/codex-auth.test.ts`.
- [x] A 128-character realistic project identifier composes a bounded pathname
      and binds on an AF_UNIX-capable runner. The bind is corroboration only —
      `node:net` and `Bun.listen` bind up to 109 bytes and so cannot witness the
      boundary; the byte count is the guard. A restricted runner may accept
      `EPERM` only after a known-short socket receives the same refusal. Verify:
      `trident/codex-auth.test.ts`.
- [x] A parent path whose complete socket pathname exceeds 107 bytes throws
      `CodexControlSocketPathError` with actual and maximum byte counts; nothing
      is returned, so no prefix can be mistaken for a usable path. Verify:
      `trident/codex-auth.test.ts`.
- [x] `resolveCodexHome` and `codexProjectHome` are TOTAL over an over-long home —
      asserted positively, so re-adding the refusal to a credential resolver reds.
      Verify: `trident/codex-auth.test.ts`.
- [x] The bound guard is mutation-checked by lowering the bound, with the landed
      line and red/restored-green results recorded in this change's as-built.

## Decision and continuous enforcement

Project identifiers are represented by the first 128 bits of SHA-256, encoded as
22 base64url characters. This makes the variable segment fixed-width and retains
128 bits of collision resistance, at the cost of losing a human-readable project
directory during debugging. That half is unconditional: it costs nothing and is
what actually buys the headroom (a UUID-shaped id goes from 114 bytes to 93).

Hashing alone cannot bound an arbitrarily long parent path, so the composed socket
pathname is checked by `assertCodexControlSocketPath`. That gate is deliberately
NOT wired into `resolveCodexHome` or `codexProjectHome`. A `CODEX_HOME` is used for
two unrelated things — holding `auth.json` (every caller in this tree) and deriving
a daemon control socket (no caller in this tree; SPEC.md records that
`codex app-server daemon start` refuses on this install for want of a managed
standalone distribution). Only the second needs a bindable socket. Enforcing at
directory resolution charged the first for the second: a 26-byte owner home — the
`resolveNeutronHome` default shape — pushed the composed project socket to 109
bytes and made `codexProjectHome` throw, which is the one call behind `connect`,
`status`, `refreshSeatLiveness` and `resolveActiveCodexHome` for a project-scoped
seat. Refusing is better than a silent failure only when the thing was going to be
attempted.

The new error joins the existing thrown configuration-error vocabulary. Without a
more specific boundary mapping it remains a server failure rather than becoming a
successful credential result; its stable `codex_control_socket_path_too_long` code
and message preserve the reason for logs and direct callers.
