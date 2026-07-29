-- 0021_p3_cores_runtime.sql
--
-- Sprint 31 — P3 Cores runtime. The runtime layer that consumes the Sprint 24
-- @neutron/cores-sdk SDK. This migration lands the two persistence tables the
-- runtime owns:
--
--   - secret_audit_log         — every Core-attributed secret op + tool-call
--                                 capability check (per § D.10.5). The
--                                 platform SecretsStore itself is unchanged;
--                                 audit writes happen at the Cores-runtime
--                                 composition seam, so direct platform
--                                 callers (max OAuth, paste tokens, etc.)
--                                 keep their non-audited path.
--
--   - core_installations       — the per-instance per-Core install record:
--                                 (project_slug, core_slug, package_version,
--                                  data_layout, sidecar_db_path,
--                                  manifest_capabilities_json, lifecycle
--                                  timestamps). Single source of truth for
--                                  "is core_X installed for project_Y, what
--                                  version, what data layout".
--
-- Cross-refs:
--   docs/plans/2026-05-08-sprint-31-cores-runtime.md
--   docs/engineering-plan.md § B.P3 (Cores runtime)
--   docs/engineering-plan.md § D.10.4 (capability-gated secrets)
--   docs/engineering-plan.md § D.10.5 (secret_audit_log shape)
--   docs/engineering-plan.md § A.3 (per-Core data layout)
--
-- The original Sprint 31 prompt named "migration 0025"; the next free
-- monotonic slot at branch time was 0021 (no migrations 0021-0024 reserved
-- by the in-flight sprints 22/23/27/28). The runner's lexicographic ordering
-- is the contract — gaps are not allowed — so 0021 is correct.

CREATE TABLE secret_audit_log (
    id              TEXT PRIMARY KEY NOT NULL,
    ts              INTEGER NOT NULL,                              -- unix-ms
    project_slug     TEXT NOT NULL,
    core_slug       TEXT NOT NULL,                                 -- the calling Core
    op              TEXT NOT NULL CHECK (op IN (
                        'get',
                        'put',
                        'rotate',
                        'list',
                        'delete',
                        'tool_call'                                -- capability-gate denials on tool dispatch
                    )),
    kind            TEXT NOT NULL,                                 -- secret kind ('byo_api_key', 'oauth_token', ...) OR 'tool' for tool-call rows
    label           TEXT NOT NULL,                                 -- secret label OR tool name for op='tool_call'
    outcome         TEXT NOT NULL CHECK (outcome IN (
                        'ok',
                        'capability_denied',
                        'not_found',
                        'error'
                    )),
    error           TEXT                                            -- nullable; populated on outcome != 'ok'
) STRICT;

-- Most reads are instance + core + time-windowed (admin UI shows the audit tail
-- for one Core in one instance). Lead with (project_slug, core_slug, ts) so that
-- WHERE clause is fully index-served. Sort the secondary lookup on outcomes by
-- partial index so we can grep capability denials cheaply for Argus.
CREATE INDEX secret_audit_log_project_core
    ON secret_audit_log (project_slug, core_slug, ts);

CREATE INDEX secret_audit_log_outcome
    ON secret_audit_log (outcome)
    WHERE outcome != 'ok';

CREATE TABLE core_installations (
    project_slug                 TEXT NOT NULL,
    core_slug                   TEXT NOT NULL,                     -- stable per-Core id (npm package name slugified)
    package_name                TEXT NOT NULL,                     -- raw npm package name ("@neutron/dtc-analytics")
    package_version             TEXT NOT NULL,                     -- semver tag at install time
    manifest_capabilities_json  TEXT NOT NULL,                     -- JSON array of capability strings declared at install/upgrade
    data_layout                 TEXT NOT NULL CHECK (data_layout IN ('tables', 'sidecar')),
    sidecar_db_path             TEXT,                               -- absolute path; non-null only when data_layout='sidecar'
    installed_at                INTEGER NOT NULL,                  -- unix-ms
    configured_at               INTEGER,
    started_at                  INTEGER,
    stopped_at                  INTEGER,
    uninstalled_at              INTEGER,                            -- soft-delete marker; NULL for live installs
    PRIMARY KEY (project_slug, core_slug)
) STRICT;

CREATE INDEX core_installations_project
    ON core_installations (project_slug);
