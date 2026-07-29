# AGENTS.md — runtime

This module owns the substrate dispatcher: `Substrate.start(spec) → SessionHandle` with `events: AsyncIterable<Event>`, `respondToTool` (external mode only), `cancel`, and the locked tagged-event shape per `docs/engineering-plan.md § B.P1`. Adapters live as siblings inside this dir (Claude Code adapter, GPT-5.5 adapter, future Private substrate adapter — all P1 deliverables). The shape was locked 2026-04-25 with validator-checked AsyncIterable + tagged-event semantics; do not relitigate.

It must NOT call into specific channel transports (Telegram, app socket, webhook — that's `gateway/`), own per-project DB writes (each adapter call returns events; persistence is the gateway's job), or hardcode `model_preference` lists. Multi-model rotation is internal-to-adapter via `model_preference: string[]`. `substrate_instance_id` is set on completion for multi-sub Claude Max debugging.

Cross-refs: `docs/engineering-plan.md § B.P1`.
