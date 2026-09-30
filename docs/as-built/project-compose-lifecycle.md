## 2026-09-30 — Retire isolated project compose workers after their task

Refs #1425 and the project workspace contract in
`docs/spec-items/project-herdr-workspaces.md:17` and `:71`.

Project document and opening composition previously kept a warm `cc-compose-*`
REPL per project. Its factory supplied neither a disposable lifetime nor explicit
workspace placement. The replacement at `open/wiring/substrates.ts:387` constructs
on demand, rejects resumable session input, and gives each call a fresh toolless
worker. Herdr places it in the requested project's `Compose · project documents`
tab; the separate `cc-agent-*` conversation remains warm.

The task terminal seam in `gateway/wiring/build-llm-call-substrate.ts:1192` binds
the factory's explicit scope before provider resolution, so conversation metering
cannot redirect it. It allocates one operation ID per start and carries that same
placement through the persistent spawn path (`:1386`). The existing workspace
journal reserves worker operations before dispatch; an ambiguous placement stays
reserved across a manager restart, and retry of that operation refuses. Missing
strict workspace support refuses before an ambient layout can be sent.

Normal settlement, cancellation and worker failure use the existing disposable
driver finalizer. `runtime/adapters/claude-code/persistent/pool.ts:629` now retains
the cleanup session and configuration when its bounded termination attempt cannot
confirm death. A later confirmed exit releases them. The result stream still
settles before asynchronous disposal completes. The gateway's disposable-worker
shutdown sweep at `runtime/adapters/claude-code/persistent/pool.ts:1944` uses this
same bounded cleanup concurrently; an unconfirmed close
retains its session and configuration instead of clearing the set or unlinking
live worker files. A later confirmed shutdown retry releases them. Native child
admission, ordinary parent shutdown survival, Chat retirement authority and
historical pane migration are unchanged. The existing worker operation journal retains its
reservation/tombstone; this slice adds no automatic boot recovery for an
unconfirmed disposable-worker close. Workspace sleep and deployed acceptance
remain open on the normative item.

Pending disposable startup is enrolled before awaiting its result
(`runtime/adapters/claude-code/persistent/pool.ts:389`). Shutdown fences those
entries synchronously and waits one bounded interval. The internal disposable
spawn observer enrolls the exact child before channel readiness
(`runtime/adapters/claude-code/persistent/spawn.ts:633`), including a startup that
later fails. A fenced startup refuses retries and its original prompt, then
performs confirmed cleanup even if it returns after shutdown. An unconfirmed
late close retains the same child/configuration and workspace operation receipt.
Fresh dispatch after restart remains admitted; ordinary warm spawn handling is
unchanged.

Verification: the new consuming `open/__tests__/project-compose-lifecycle.test.ts`
drives production composition through the real persistent adapter, Herdr host and
workspace manager over a scripted RPC server and local native-channel fixture.
It checks actual pane/tab placement, empty native tools, fresh per-call replies,
warm Chat continuity, cancellation, process failure, lost close replies, retained
cleanup after refused closes and shutdown, confirmed shutdown cleanup, pending
layout and channel-readiness shutdown in both close dispositions,
missing-manager refusal, durable ambiguous operation
retry refusal, and conflicting conversation metering. The related wiring,
background isolation, disposable-worker, workspace and Herdr placement/exit suites
also pass. Root and Trident TypeScript checks and changed-file ESLint pass.

Seven deliberate mutations each produced an assertion failure: restoring warm
compose, dropping cleanup tracking before confirmed exit, and omitting explicit
compose terminal placement, restoring unconfirmed shutdown cleanup, and omitting
shutdown termination, permitting a pending startup to inject after shutdown,
and omitting the late child's cleanup enrollment. Restoring the implementation returns the focused
suite to green. No live model call or deployed lifecycle result is claimed.
