-- One sentence, written once by the dispatch, saying what a retry inherited from the dead run it replaces.
ALTER TABLE code_trident_runs ADD COLUMN resume_note TEXT;
