## 2026-09-19 — Fresh Codex owner bootstrap with a sealed native binding

The locked project REPL design requires one long-lived conversation across owner
surfaces (`docs/plans/harness-orchestrator-pivot-2026-09-11.md:87`). The existing
broker required a thread before construction, while native Codex 0.154.0 creates
the blank owner thread from its TUI and creates the rollout only after the first
real turn. This change adds a bounded, unintegrated fresh-owner factory.

`project-control-bootstrap.ts:78` claims a durable generation in the canonical,
private Codex home before launching the app-server. The namespace lock is
independent of the requested control socket, so another socket cannot create a
second owner. Existing sealed or uncertain ownership refuses fresh creation
(`:126`); restart and reattachment are deliberately separate work.

The factory owns one stdio app-server and one PTY running the unmodified native
TUI (`:127`, `:254`). The TUI authenticates to a loopback WebSocket with a random
bearer held only by its launch environment. Native 0.154.0 rejects bearer auth
with Unix remotes, so there is no Unix-auth fallback. Admission rejects a missing
or foreign bearer, browser Origin, incorrect path, or second client
(`project-control-bootstrap-validation.ts:35`). A hostile process with the same
UID and environment-read/ptrace access remains outside this boundary; this is
not OS process isolation or native cryptographic attestation.

The first thread/start is durably recorded before forwarding
(`project-control-bootstrap.ts:220`). Its native response must agree with the
thread/started event on thread, session, source, originator, provider, working
directory, rollout path and environments. The validator rejects foreign paths,
symlink ancestors, prior turns and forked/parented threads
(`project-control-bootstrap-validation.ts:10`). The factory learns the pane
from its owned PTY process and the credential namespace from its canonical
launch home; account/read evidence is hashed, not persisted as account PII or
credential contents (`project-control-bootstrap.ts:153`). The account digest
does not prove a token's value or isolate a same-UID credential writer.

The existing broker takes over all subsequent requests before the factory
returns. The frozen binding records both generations and a random revision,
plus native metadata; journal sealing commits it durably before exposing an
opaque WeakMap-backed handle (`project-control-bootstrap.ts:178`). Plain objects
and spread copies cannot mint authority. The journal refuses replacement or a
missing attestation row (`project-control-broker-journal.ts:90`).

Validation: the consuming native smoke uses a disposable home and local fake
provider. It proves zero provider calls and no rollout before the first real
multiline gateway turn; that reply renders in the native TUI, and a subsequent
real PTY-entered turn reaches the same conversation. Foreign thread, cwd and
environment requests, stale epoch, forged handle, second namespace owner,
alternate socket, closed handle and prior-owner recreation controls refuse
(`project-control-bootstrap.smoke.ts:52`). An optional observer module argument
replayed the actual first-turn rollout through the separately authored deferred
observer, using exact native metadata and receipt (`:71`); it completed without
changing that observer.

The dedicated native authentication probe also passed with missing/wrong-token
HTTP refusal controls. The broker/bootstrap test set passed 29 tests. Mutation
checks removed bearer comparison (the unauthorized control failed) and changed
admission to reject every client (the consuming native smoke failed with 403).
Both mutations were restored; the native smokes and root/Trident TypeScript
checks passed afterward.

This does not wire Open composition, project lifecycle, Herdr, deployment,
approval transfer, restart reconciliation or model switching. Native ancillary
title-generation thread creation is refused after binding by the existing
broker classification. The factory adds one owner-creation path; it neither
seeds a fake conversation nor falls back to codex exec.
