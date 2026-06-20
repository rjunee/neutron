-- 0036_core_installations_install_state.sql
--
-- Adds `install_state` to `core_installations` so the runtime can
-- record post-install lifecycle failures (OAuth grant revoked,
-- dependency disconnected) without re-running the install. Default
-- 'install_ok' so existing rows preserve their semantic.
--
-- Possible values:
--   - install_ok                          — Core is live + usable
--   - install_failed_runtime              — refresh-token exchange returned
--                                            invalid_grant; user must reconnect
--   - install_failed_dependency_missing   — user explicitly disconnected;
--                                            Core is no longer usable
--
-- The /api/cores HTTP surface reads this column for installed Cores so
-- the Expo client can render the right "Reconnect Google" nudge per
-- state. The boot-time install lifecycle still writes 'install_ok' on
-- every successful install (no behavior change for green paths).
--
-- Cross-refs:
--   docs/plans/cores-oauth-secret-resolution-sprint-brief.md § 5.2

ALTER TABLE core_installations
    ADD COLUMN install_state TEXT NOT NULL DEFAULT 'install_ok';

CREATE INDEX core_installations_install_state
    ON core_installations(project_slug, install_state);
