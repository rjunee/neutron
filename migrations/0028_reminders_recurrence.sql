-- 0028_reminders_recurrence.sql
--
-- P2 v2 S9 — extend `reminders` with an optional `recurrence` column so
-- the new `06-interest-check-in` wow action can schedule weekly /
-- monthly / occasional check-ins (per docs/plans/P2-onboarding-v2.md
-- § 5.2 / § 9.4).
--
-- The column is nullable; the existing one-shot create() path leaves it
-- NULL and behavior is unchanged. The new createRecurring() store API
-- writes one of 'weekly' | 'monthly' | 'occasional'.
--
-- Forward-only. No CHECK constraint is added: future cadence labels can
-- land without another rebuild, and the store enforces the value at
-- write time.

ALTER TABLE reminders ADD COLUMN recurrence TEXT;
