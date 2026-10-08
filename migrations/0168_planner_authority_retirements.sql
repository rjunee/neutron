-- Operator retirement permanently fences scoped planner work. Original lease
-- identity and authorization survive exact consumption and gateway restart.
CREATE TABLE IF NOT EXISTS planner_authority_retirements (
  scope_key TEXT NOT NULL,
  work_ref TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  lease_token TEXT NOT NULL UNIQUE,
  generation INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason = 'liveChild'),
  producer TEXT NOT NULL,
  authorization TEXT NOT NULL,
  completion TEXT,
  PRIMARY KEY (scope_key, work_ref),
  CHECK (length(operation_id) > 0),
  CHECK (length(lease_token) > 0),
  CHECK (length(authorization) > 0)
);
