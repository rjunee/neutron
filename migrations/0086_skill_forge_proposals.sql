-- 0086_skill_forge_proposals.sql
--
-- Skill Forge — auto-skillify (WAVE 4).
--
-- The durable gate for turning a completed multi-step workflow into a saved,
-- re-invokable skill. Skill Forge AUDITS completed work and, when a workflow
-- looks skill-worthy, composes a PROPOSAL to the user (name + triggers + what
-- it does + artifacts). The proposal is NEVER auto-approved: it is the gate.
--
--   pending  → the proposal was surfaced; nothing has been written to disk.
--   approved → the user accepted (optionally after edits); the distilled
--              skill markdown was written under
--              `<owner_data_dir>/skills/conventions/<slug>.md` (recorded in
--              `skill_path`) and is now agent-discoverable + session-durable.
--   declined → the user said no; NOTHING was created.
--
-- `workflow_signature` is a stable hash of the completed workflow's normalized
-- steps. It is the dedupe key: Skill Forge proposes a given workflow at most
-- once while a prior proposal for the same signature is still pending or
-- approved — so a workflow the user runs repeatedly does not re-nag, and an
-- approved skill is never re-proposed. (A declined proposal does NOT block a
-- future re-proposal — the user may change their mind on a later run.)
--
-- `workflow_json` snapshots the distilled workflow record so APPROVE can
-- distill the skill body without the original in-memory run — the gate
-- survives a gateway restart. `triggers_json` / `artifacts_json` are JSON
-- string[] mirrors carried for cheap rendering of the proposal message.
--
-- Runtime truth, instance-scoped, written only by the Skill Forge runtime.
-- Forward-only; no down-migration (Neutron OSS contract, matches 0080/0084).

CREATE TABLE skill_forge_proposals (
    -- Opaque proposal id (uuid v4).
    id                 TEXT PRIMARY KEY NOT NULL,
    -- Stable hash of the source workflow's normalized steps (dedupe key).
    workflow_signature TEXT NOT NULL,
    -- The project the workflow ran in (audit + scoping).
    project_slug       TEXT NOT NULL,
    -- The topic the proposal message was surfaced in (audit).
    topic_id           TEXT,
    -- Distilled skill identity. `proposed_name` is the kebab-case slug used
    -- for both the skill name and the `conventions/<slug>.md` filename.
    proposed_name      TEXT NOT NULL,
    -- JSON string[] of trigger phrases ("ALWAYS use when…").
    triggers_json      TEXT NOT NULL,
    -- One-paragraph summary of what the skill does.
    what_it_does       TEXT NOT NULL,
    -- JSON string[] describing the artifacts the workflow produced/touched.
    artifacts_json     TEXT NOT NULL,
    -- Snapshot of the full CompletedWorkflow record (JSON) for re-distillation.
    workflow_json      TEXT NOT NULL,
    -- pending | approved | declined.
    status             TEXT NOT NULL DEFAULT 'pending',
    -- Absolute path of the registered skill markdown once approved; NULL else.
    skill_path         TEXT,
    -- Epoch ms.
    created_at         INTEGER NOT NULL,
    -- Epoch ms the proposal was approved/declined; NULL while pending.
    decided_at         INTEGER
) STRICT;

CREATE INDEX skill_forge_proposals_status
    ON skill_forge_proposals (status);

CREATE INDEX skill_forge_proposals_signature
    ON skill_forge_proposals (workflow_signature);
