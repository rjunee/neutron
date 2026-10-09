-- Shared by admission and salvage. A crashed operation stays reserved: time
-- passing is not evidence that an outstanding Git command has stopped.
CREATE TABLE IF NOT EXISTS code_trident_branch_reservations (
  repo_path TEXT NOT NULL,
  branch TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('admission', 'salvage')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (repo_path, branch)
);
