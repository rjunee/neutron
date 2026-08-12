-- 0002_account_settings.sql — PER-ACCOUNT enablement for the email pipeline.
--
-- The owner connects mailboxes for many reasons; wanting the agent to read one
-- of them is a separate decision from having connected it. Before this table
-- the pipeline processed EVERY connected account, so connecting a mailbox for
-- an unrelated Core silently enrolled its entire history in the backlog sweep
-- and its new mail in escalation-to-chat.
--
-- ── OPT-IN, NOT OPT-OUT ──────────────────────────────────────────────────────
-- Absence of a row means DISABLED. The two wrong defaults are not symmetric:
-- defaulting ON means a mailbox the owner never considered starts posting to
-- their chat, which cannot be undone once posted; defaulting OFF means a
-- mailbox they meant to enable stays quiet until they flip it, which costs one
-- switch. So the table is an ALLOW-LIST and the poller fails closed against it.
--
-- OWNER DECISION, 2026-08-12. The first cut of the poller contradicted this
-- header: it read "no rows at all" as permission to poll every connected
-- mailbox, so the contract stated opt-in while the code shipped opt-out. The
-- owner settled it in favour of the contract. The cost is accepted and named:
-- a FRESH INSTALL POLLS NOTHING until a mailbox is enabled, and the poller
-- logs that on every tick so an opted-out pipeline can never be mistaken for a
-- broken one.
--
-- ── WHY account_id AND NOT THE ADDRESS ───────────────────────────────────────
-- `account_id` is the same stable id the multi-account fan-out already stamps
-- on every message row and the same one `emails.account_id` keys on. Keying the
-- setting on the address instead would put owner PII in a settings table AND
-- break the moment an address is re-pointed at a different grant. The address
-- is stored ONLY as a nullable label for display, and is never the identity.
--
-- No row is seeded here. Every account is owner data and lands at runtime.

CREATE TABLE IF NOT EXISTS account_settings (
  account_id   TEXT PRIMARY KEY,
  -- 1 = the pipeline polls, classifies, escalates and labels this mailbox.
  -- 0 = it is invisible to the pipeline: not listed, not swept, not mutated.
  enabled      INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  -- Display label only. NULL when the fan-out could not report an address.
  account_email TEXT,
  -- When the owner last changed this. `enabled_at` is load-bearing: an account
  -- turned on LATER must have its backlog swept from the moment it was turned
  -- on, not from the instance's original go-live, or its entire back-catalogue
  -- reads as new mail and escalates.
  enabled_at   INTEGER,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_account_settings_enabled
  ON account_settings (enabled);
