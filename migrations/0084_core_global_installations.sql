-- 0084_core_global_installations.sql
--
-- WAVE 3 PR-2 — Cores install-SCOPE: the GLOBAL scope.
--
-- BACKGROUND: `core_installations` (0021) is keyed `(project_slug, core_slug)`
-- — a Core installs into exactly one project and every read path threads a
-- project_slug. WAVE 3 adds a second install scope: a Core can install
-- GLOBALLY, meaning its tabs surface in the global app shell (`GET
-- /api/app/tabs`) AND in every project. (Per-project installs continue to
-- live in `core_installations`; this table is purely additive.)
--
-- WHY A SIBLING TABLE (not a `scope` column on core_installations): every
-- existing per-project query assumes a project_slug. A sentinel
-- `project_slug='*'` would pollute those read paths; a dedicated table keeps
-- per-project queries byte-identical and makes "installed globally" a clean
-- UNION in the tab resolver. (See docs/plans/wave3-tabbed-interface-build-plan.md
-- § 3.2 — the scope-column alternative was rejected for blast radius.)
--
-- SHAPE: global installs are project-agnostic, so there is no `data_layout` /
-- `sidecar_db_path` (those describe a Core's per-project data namespace). The
-- table records identity (core_slug PK), package coordinates, the manifest
-- capabilities snapshot, an `install_state` mirroring 0036's per-project
-- column, and the install / uninstall lifecycle timestamps. Uninstall is a
-- TOMBSTONE (`uninstalled_at` set), matching `core_installations` so a
-- re-install reuses the PK via UPSERT.
--
-- Cross-refs:
--   docs/plans/wave3-tabbed-interface-build-plan.md § 3.1-3.2 (PR-2)
--   migrations/0021_p3_cores_runtime.sql (per-project core_installations)
--   migrations/0036_core_installations_install_state.sql (install_state)

CREATE TABLE core_global_installations (
    core_slug                   TEXT NOT NULL,
    package_name                TEXT NOT NULL,
    package_version             TEXT NOT NULL,
    manifest_capabilities_json  TEXT NOT NULL,
    install_state               TEXT NOT NULL DEFAULT 'install_ok',
    installed_at                INTEGER NOT NULL,
    uninstalled_at              INTEGER,
    PRIMARY KEY (core_slug)
) STRICT;

CREATE INDEX core_global_installations_install_state
    ON core_global_installations (install_state);
