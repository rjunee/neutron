# AGENTS.md — prompts

This module holds lifted-and-parameterized copies of Nova's prompt library: Atlas, Argus, Sentinel, Forge, Scribe, reminder-agent-base, topic-agent-base. Hardcoded paths (internal design notes, internal design notes) are replaced with template variables (`{{OWNER_HOME}}/entities/`, `{{OWNER_HOME}}/Projects/`; `{{OWNER_HOME}}` is the only home token — resolved via `template.ts`). The lift happens in Sprint 2 — P0 ships only the empty dir.

It must NOT change agent behavior vs Nova (this is a lift, not a rewrite — observable behavior is the green-gate via the behavioral-spec suite at M1 cutover). Cross-instance safety: every prompt parameterizes its owner-home path; no prompt hardcodes an owner's data dir.

Cross-refs: `docs/engineering-plan.md § B.P0`, Nova `prompts/`, `docs/plans/P0-system-user-data-separation.md § 1.2`.
