-- 0114_instance_scope_ledger.sql
--
-- ISSUES #451 — the singleton record of WHICH scope key this database's rows
-- are currently written under.
--
-- THE DEFECT THIS EXISTS TO CLOSE. An instance has a frozen handle and a
-- RENAMEABLE `url_slug`. Almost every table in this database is scoped by that
-- renameable slug (`project_slug`, and two spellings of it). The gateway
-- resolves the slug once at boot (`resolveOwnerSlugFromConfig`) and every store
-- reads and writes under THAT value — so the instant the owner renames, every
-- row written before the rename is stranded under the OLD key while the running
-- process asks for the NEW one. The most damaging miss is `onboarding_state`:
-- `isOnboardingActive` fail-closes on a miss (`st === null → true`), so an owner
-- whose row says `phase = 'completed'` is treated as though he never finished
-- onboarding. The bundled-ritual boot sweep then defers forever and every
-- ordinary message keeps running through the onboarding-answer extractor.
--
-- WHY A LEDGER AND NOT A DERIVED CHECK. The fix is to migrate stranded rows
-- FORWARD onto the boot-resolved slug (the boot value is load-bearing for AUTH
-- equality — the session cookie is compared to it — so it cannot move). To do
-- that idempotently, boot has to answer "which key is this database already
-- scoped to?" in one read, without scanning. That answer is not derivable from
-- the data: an empty install and a correctly-scoped install look identical, and
-- a partial scan can't distinguish a stale key from a legitimately foreign one.
-- So it is RECORDED, in the same transaction as the re-key, which is what makes
-- the reconciler crash-safe (a crash rolls the ledger back with the moves) and
-- a no-op on every subsequent boot (one SELECT, no writes).
--
-- WHY NOT REUSE `instance_metadata`. Its primary key IS `instance_slug` — i.e.
-- it carries the very disease this table diagnoses, and a renamed instance
-- cannot read its own metadata row back to find out what it used to be called.
-- The ledger is deliberately a SINGLETON (`CHECK (id = 1)`): one database, one
-- scope key, structurally unable to grow a second row.
--
-- `updated_at` is unix-ms and exists for forensics — it is the timestamp of the
-- last reconciliation, i.e. when this database was (re)scoped.
--
-- Forward-only; no down-migration (Neutron OSS contract).

CREATE TABLE IF NOT EXISTS instance_scope_ledger (
  -- Singleton. The CHECK is the whole point: a second row is a bug, not a state.
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  -- The scope key every slug-scoped row in this database is written under.
  project_slug TEXT    NOT NULL,
  -- unix-ms of the last reconciliation.
  updated_at   INTEGER NOT NULL
) STRICT;
