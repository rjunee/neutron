-- 0101_app_chat_receipt_reaction_msg_index.sql
--
-- Widen the app-chat receipt + reaction resume-replay indexes from
-- `(topic_id, seq)` to `(topic_id, seq, message_id)`.
--
-- BACKGROUND: the resume replay for per-message state (receipts, reactions)
-- pages by DISTINCT MESSAGE. Each page is found with
--
--   SELECT DISTINCT seq, message_id FROM <t>
--    WHERE topic_id = ? AND (seq > ? OR (seq = ? AND message_id > ?))
--    ORDER BY seq ASC, message_id ASC
--    LIMIT ? + 1
--
-- (the `+1` proves whether a further page exists), and the page's rows are then
-- range-scanned up to that `(seq, message_id)` boundary. The page boundary is
-- the COMPOSITE `(seq, message_id)`, not raw `seq`: a receipt/reaction row
-- stores the caller-supplied `topic_id` while its `seq` is resolved from the
-- globally-keyed message log, so two DISTINCT messages can collide on one `seq`
-- under a single topic query — a raw-seq boundary would miscount the collision.
--
-- WHY THE WIDER INDEX: with only `(topic_id, seq)`, the `DISTINCT seq,
-- message_id ... ORDER BY seq, message_id` probe forces SQLite to `USE TEMP
-- B-TREE FOR DISTINCT` — it may scan and materialize the ENTIRE qualifying
-- backlog into a sorter before applying `LIMIT`, defeating the bounded-memory
-- guarantee the paging exists to provide. Extending the index to
-- `(topic_id, seq, message_id)` makes the DISTINCT + ORDER BY fully
-- index-ordered: the probe becomes a COVERING-INDEX search that early-terminates
-- at `LIMIT`, and the boundary range scan is index-driven too. The old
-- `(topic_id, seq)` index is a strict prefix of the new one, so every query it
-- served (`WHERE topic_id = ? AND seq ...`) is served identically — it is
-- dropped to avoid redundant write amplification.
--
-- Forward-only; no down-migration (Neutron OSS contract).

DROP INDEX IF EXISTS idx_app_chat_receipts_topic_seq;
CREATE INDEX IF NOT EXISTS idx_app_chat_receipts_topic_seq_msg
    ON app_chat_receipts (topic_id, seq, message_id);

DROP INDEX IF EXISTS idx_app_chat_reactions_topic_seq;
CREATE INDEX IF NOT EXISTS idx_app_chat_reactions_topic_seq_msg
    ON app_chat_reactions (topic_id, seq, message_id);
