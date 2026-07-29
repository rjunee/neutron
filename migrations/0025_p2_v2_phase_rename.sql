-- 0025_p2_v2_phase_rename.sql
--
-- P2 v2 — rename onboarding_state.phase values for in-flight rows so the
-- v2 phase chain works correctly. v1 rows at phase=archetype_picked are
-- semantically equivalent to v2 personality_offered; same for the other
-- renamed phases.
--
-- See docs/plans/P2-onboarding-v2.md § 2.8 (phase rewrite + the v1→v2
-- mapping table) and § 9.6 (migration spec).
--
-- The spec § 9.6 originally numbered this file as `0019_p2_v2_phase_rename.sql`.
-- That prefix conflicted with the already-shipped 0019_p2_sean_ellis_prompt_link
-- + 0020_button_prompts_kind migrations, so Forge renumbered both v2 migrations
-- to the next free slots — 0025 here + 0006 in the registry tree (the user-
-- fields migration moved out of `migrations/` since it targets the registry's
-- instance table, not this per-project DB). This file's body is unchanged from the spec's intent.
--
-- This migration is additive on schema (no columns added/removed). Rows at
-- terminal phases (completed, failed) are untouched. The runner wraps the
-- body in BEGIN/COMMIT for atomicity. Idempotent at the runner level (the
-- `_migrations` table records this version; re-runs are skipped); the SQL
-- body itself is also re-runnable — every UPDATE matches zero rows once
-- the rename has been applied.

UPDATE onboarding_state SET phase = 'ai_substrate_offered'    WHERE phase = 'import_offered';
UPDATE onboarding_state SET phase = 'personality_offered'     WHERE phase = 'archetype_picked';
UPDATE onboarding_state SET phase = 'agent_name_chosen'       WHERE phase = 'name_chosen';
UPDATE onboarding_state SET phase = 'work_interview_gap_fill' WHERE phase IN ('profile_pic_generating', 'time_style_picked', 'work_pattern_captured', 'rituals_captured');
