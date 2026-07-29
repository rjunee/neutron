-- 0071_inbound_message_author.sql
--
-- 2026-06-14 — Connect FEATURES B1 (connect-spec §4.4). Multi-author attribution:
-- every inbound message carries a uniform `author` envelope (owner = author #0;
-- each collaborator = a stable author id + display name). The author is stamped
-- ONCE, server-side, at the connect ingress (§4.2) and persisted here as ONE
-- pair of columns on the per-message audit row — read by the transcript,
-- scribe/entity-extraction, and Core-activity layers (§4.3).
--
--   author_id      stable, uniform across owner + every collaborator
--                  (the member's collision-free local_slug, or 'owner').
--   author_display the human label rendered in the transcript + roster.
--
-- Nullable: pre-B1 rows (and any non-connect audit write) carry NULL. New
-- connect turns always stamp both. Forward-only; STRICT table ADD COLUMN with a
-- valid STRICT type (TEXT). Snapshot regen required.

ALTER TABLE inbound_messages ADD COLUMN author_id TEXT;
ALTER TABLE inbound_messages ADD COLUMN author_display TEXT;
