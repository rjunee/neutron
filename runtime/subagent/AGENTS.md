# AGENTS.md — runtime/subagent

This module owns substrate-agnostic subagent dispatch — `registry.ts` (in-memory record of running children with status + delegation claims), `spawn.ts` (validates `MAX_SPAWN_DEPTH=1` + `MAX_CHILDREN_PER_AGENT=5` + `MAX_CONCURRENT_SUBAGENTS=8` + signed-delegation-token instance/depth/scope claims), `control.ts` (idempotent cancel, status, wait), `announce.ts` (formats completion summary as Markdown the parent splices into its conversation context), `lifecycle.ts` (watchdog tick that reaps stale-running, pid-gone, and past-cleanup_after records). Lifted from OpenClaw's `subagent-*.ts` family, hardened with Hermes-style signed delegation.

It must NOT inherit OpenClaw's "no signed delegation" anti-pattern (per internal design notes § 7); every nested spawn requires a signed delegation token whose `instance` claim matches the requested instance_key and whose `depth` claim authorizes the spawn depth. Caps are baked-in constants, not configurable per-call — operator overrides go through a future `gateway/policy.ts` (S4) layer that would then construct the inputs to `spawnSubagent`.

The registry is in-memory at S3; S4 wires it to a SQLite-backed table so the lifecycle watchdog can survive a gateway restart and reap orphaned children. The substrate-agnostic property comes from `spawnSubagent` returning a `SubagentRecord` and the caller composing whichever `Substrate.start(spec)` they want — the registry doesn't know about Anthropic, OpenAI, or Codex.

Cross-refs: internal design notes, internal design notes.
