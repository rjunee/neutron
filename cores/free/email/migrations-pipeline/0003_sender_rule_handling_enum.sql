-- 0003_sender_rule_handling_enum.sql — constrain `sender_rules.handling`.
--
-- The column was free TEXT, and the classifier read it as "escalate, or else
-- archive". So a single typo in a rule — `esclate` — did not fail, it INVERTED:
-- the sender the owner had singled out to be told about was the one sender
-- guaranteed to be silently archived, "payment failed" included. A misspelling
-- that produces the exact opposite of the stated intent, with no error, is the
-- worst shape a validation gap can take.
--
-- `kind` next door has had `CHECK (kind IN (...))` since 0001. This is that
-- same guard, arriving late.
--
-- SQLite cannot add a CHECK to an existing column, so the table is rebuilt.
-- That is safe here precisely because `sender_rules` SHIPS EMPTY and every row
-- is owner data written at runtime: on any install that has not yet run P2.5's
-- interview or P4's importer there is nothing to copy, and where there is, the
-- copy is a straight `INSERT … SELECT` of rows that already satisfy the new
-- constraint — any that do not are surfaced by the failed migration rather than
-- silently dropped.

CREATE TABLE sender_rules_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern     TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('sender', 'domain')),
  category    TEXT,
  -- NULL = "the owner did not say what to do" — a real and common state that
  -- falls through to the category/heuristic cascade. It is NOT a third
  -- behaviour, which is why it stays nullable rather than defaulting.
  handling    TEXT CHECK (handling IS NULL OR handling IN ('escalate', 'archive')),
  protected   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

INSERT INTO sender_rules_new (id, pattern, kind, category, handling, protected, created_at)
  SELECT id, pattern, kind, category, handling, protected, created_at FROM sender_rules;

DROP TABLE sender_rules;

ALTER TABLE sender_rules_new RENAME TO sender_rules;
