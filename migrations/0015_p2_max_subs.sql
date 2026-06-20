-- 0015_p2_max_subs.sql
--
-- P2 S4 — multi-sub Anthropic Max OAuth registry. SCHEMA-RESERVED-ONLY.
--
-- Per docs/plans/P2-onboarding.md § 2.4 (`Locked 2026-04-29` fallback).
-- Sprint-1's research spike on Anthropic Max OAuth multi-sub semantics
-- has NOT landed; without confirmed token shape (refresh strategy,
-- per-sub vs per-org scoping, device-code flow contour, rate-limit
-- attribution at the org boundary) we cannot commit a real schema.
--
-- This migration ships an explicit placeholder that:
--
--   1. Reserves the migration version slot (0015) so the post-research
--      follow-up sprint can add the real schema as 0016+ without
--      version-number juggling.
--
--   2. Creates `max_subs_unimplemented` — a sentinel table that the
--      multi-sub stub modules (auth/max-oauth-multi-sub.ts +
--      onboarding/multi-sub/{rotator,ui-flow}.ts) DO NOT touch. Every
--      method on those classes throws `MultiSubNotImplementedError`.
--      Inserting into this table is forbidden by the CHECK constraint
--      below (which can never be satisfied) so a stray INSERT fails
--      loudly rather than silently corrupting state.
--
-- The follow-up sprint, once research lands, will:
--   - DROP TABLE max_subs_unimplemented;
--   - CREATE TABLE max_subs (...) STRICT — actual schema TBD.
--
-- Forward-only. STRICT typing. The placeholder column shape is
-- intentionally trivial — there is nothing meaningful to record yet.

CREATE TABLE IF NOT EXISTS max_subs_unimplemented (
    id TEXT PRIMARY KEY NOT NULL,
    -- The CHECK below can never be true (`1 = 0`), so any INSERT
    -- against this table fails. Defense-in-depth: even if a buggy
    -- caller bypasses the MultiSubNotImplementedError-throwing
    -- classes and writes raw SQL, the row never lands.
    placeholder TEXT NOT NULL CHECK (1 = 0)
) STRICT;
