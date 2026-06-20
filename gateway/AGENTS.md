# AGENTS.md — gateway

This module owns the modular per-instance gateway: HTTP routes, Telegram webhook intake, channel-binding fan-out, button-callback dispatch, and the in-process orphan-adoption logic that ports Nova's `rediscoverLiveTopicPanes` per `docs/engineering-plan.md § B.P1`. Implementation lands in P1; P0 ships only the empty-but-correct skeleton.

It must NOT contain the substrate dispatcher (lives in `runtime/`), MCP server scaffolding (`mcp/`), reminder engine (`reminders/`), or any per-instance flat files at the gateway root — all per-instance state goes through the project database file. No `topic-map.json`, no `running-agents.jsonl`, no `pending-*.json` button queues at any global path.

Cross-refs: `docs/engineering-plan.md § B.P1`.
