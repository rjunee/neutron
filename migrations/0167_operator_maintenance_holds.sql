-- An operator hold is admission exclusion, never evidence of work completion.
-- Enforce it at the database boundary so an older running gateway's recurring
-- maintenance recovery cannot abandon the fence behind the operator.
CREATE TABLE IF NOT EXISTS project_operator_maintenance_holds (
  operation_id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL UNIQUE REFERENCES project_admission_fences(scope_key),
  generation INTEGER NOT NULL,
  maintenance_token TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TRIGGER IF NOT EXISTS project_operator_maintenance_fence_guard
BEFORE UPDATE ON project_admission_fences
WHEN EXISTS (
  SELECT 1 FROM project_operator_maintenance_holds h
  WHERE h.scope_key = OLD.scope_key AND h.generation = OLD.generation
    AND h.maintenance_token = OLD.maintenance_token
)
AND (NEW.scope_key IS NOT OLD.scope_key OR NEW.generation IS NOT OLD.generation
  OR NEW.phase IS NOT OLD.phase OR NEW.maintenance_token IS NOT OLD.maintenance_token)
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER IF NOT EXISTS project_operator_maintenance_delete_guard
BEFORE DELETE ON project_admission_fences
WHEN EXISTS (SELECT 1 FROM project_operator_maintenance_holds h WHERE h.scope_key = OLD.scope_key)
BEGIN
  SELECT RAISE(IGNORE);
END;
