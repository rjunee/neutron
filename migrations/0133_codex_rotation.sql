-- 0133 — Codex multi-account rotation state.
--
-- The owner may connect more than one ChatGPT subscription seat. The encrypted
-- bundles keep living in `project_credentials` (service `codex` for the original
-- seat, `codex-acct-<slot>` for the others); these two tables hold only the
-- ROTATION bookkeeping — which seats exist, their round-robin order, whether one
-- is cooling off, and which seat the next run should use.
--
-- Every timestamp is epoch MILLISECONDS. The CLI reports `resets_at` in SECONDS,
-- so the conversion happens once at the parse boundary and nothing downstream has
-- to remember which unit it is holding.
--
-- Forward-only, `IF NOT EXISTS` so a hand-recovered instance is cheap to repair.

CREATE TABLE IF NOT EXISTS codex_rotation_slots (
  owner_slug          TEXT    NOT NULL,
  slot                TEXT    NOT NULL,
  -- Round-robin order. Ties are broken by slot name in the selector, so a
  -- duplicated position degrades to a deterministic order rather than a random one.
  position            INTEGER NOT NULL DEFAULT 0,
  -- Optional owner-facing name; the slot id is the fallback label.
  label               TEXT,
  -- Epoch ms after which the slot is eligible again. NULL = eligible now.
  -- Note `cooling_reason = 'unauthorized'` outranks this: a revoked refresh token
  -- does not heal on a timer, so that state stays ineligible until reconnected.
  cooling_until       INTEGER,
  -- 'short-window' | 'long-window' | 'rate-limited' | 'unauthorized' | 'manual'
  cooling_reason      TEXT,
  -- Last harvested usage, retained for the status surface. `window_minutes` is
  -- stored per sample because the window length has changed regime before
  -- (300 minutes became 10080) and a stored reading is meaningless without it.
  last_used_percent   REAL,
  last_window_minutes INTEGER,
  last_resets_at      INTEGER,
  last_plan_type      TEXT,
  last_run_at         INTEGER,
  PRIMARY KEY (owner_slug, slot)
);

-- Which slot the next run uses. One row per owner; the pointer IS the rotation,
-- because a seat's credential bundle must never be copied between directories.
CREATE TABLE IF NOT EXISTS codex_rotation_active (
  owner_slug  TEXT PRIMARY KEY,
  active_slot TEXT    NOT NULL,
  updated_at  INTEGER
);
