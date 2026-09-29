-- Recovery admission can refuse before a replacement run exists. Keep its
-- explanation on the card without changing source evidence or task spend.
ALTER TABLE work_board_items ADD COLUMN recovery_refusal TEXT;
