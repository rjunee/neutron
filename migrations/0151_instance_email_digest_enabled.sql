-- Additive instance preference: NULL/missing preserves the enabled default.
ALTER TABLE instance_metadata ADD COLUMN email_digest_enabled INTEGER CHECK (email_digest_enabled IN (0, 1));
