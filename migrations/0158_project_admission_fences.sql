CREATE TABLE IF NOT EXISTS project_admission_fences (
  scope_key TEXT PRIMARY KEY,
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  phase TEXT NOT NULL CHECK (phase IN ('open', 'draining', 'quiesced', 'replacing', 'attesting')),
  maintenance_token TEXT,
  CHECK ((phase = 'open' AND maintenance_token IS NULL) OR
         (phase <> 'open' AND maintenance_token IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS project_admission_leases (
  token TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL REFERENCES project_admission_fences(scope_key),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  reason TEXT NOT NULL CHECK (reason IN ('conversation', 'queuedDispatch', 'build', 'approval', 'liveChild')),
  producer TEXT NOT NULL,
  work_ref TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS project_admission_leases_scope ON project_admission_leases(scope_key);
