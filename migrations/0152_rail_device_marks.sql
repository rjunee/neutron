-- Rail marks replace the per-user MAX(read receipt) query. Old receipts stay intact.
CREATE TABLE IF NOT EXISTS rail_devices (
    user_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    PRIMARY KEY (user_id, device_id)
);
CREATE TABLE IF NOT EXISTS rail_device_marks (
    topic_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    PRIMARY KEY (topic_id, device_id)
);

-- Known installations are the devices in durable chat receipts, across all
-- topics for a user. app topics are app:<user> or app:<user>:<project>.
INSERT OR IGNORE INTO rail_devices (user_id, device_id)
SELECT DISTINCT
    CASE WHEN instr(substr(topic_id, 5), ':') = 0 THEN substr(topic_id, 5)
         ELSE substr(topic_id, 5, instr(substr(topic_id, 5), ':') - 1) END,
    device_id
FROM app_chat_receipts WHERE substr(topic_id, 1, 4) = 'app:';

-- Seed every known device from the old effective per-user mark, once. Existing
-- per-device rows win, including a deliberately lower mark.
INSERT OR IGNORE INTO rail_device_marks (topic_id, device_id, seq)
SELECT m.topic_id, d.device_id,
       COALESCE((SELECT MAX(r.seq) FROM app_chat_receipts r
                 WHERE r.topic_id = m.topic_id AND r.read_at IS NOT NULL), 0)
FROM (SELECT DISTINCT topic_id FROM app_chat_messages) m
JOIN rail_devices d ON m.topic_id = 'app:' || d.user_id
    OR substr(m.topic_id, 1, length(d.user_id) + 5) = 'app:' || d.user_id || ':';

-- New topics start unread for already registered devices. This runs even when
-- clients are disconnected; a later list request cannot erase that activity.
CREATE TRIGGER rail_message_insert AFTER INSERT ON app_chat_messages BEGIN
    INSERT OR IGNORE INTO rail_device_marks (topic_id, device_id, seq)
    SELECT NEW.topic_id, device_id, 0 FROM rail_devices
    WHERE NEW.topic_id = 'app:' || user_id
       OR substr(NEW.topic_id, 1, length(user_id) + 5) = 'app:' || user_id || ':';
END;
CREATE TRIGGER rail_receipt_insert AFTER INSERT ON app_chat_receipts
WHEN NEW.read_at IS NOT NULL BEGIN
    UPDATE rail_device_marks SET seq = MAX(seq, NEW.seq)
    WHERE topic_id = NEW.topic_id AND device_id = NEW.device_id;
END;
CREATE TRIGGER rail_receipt_update AFTER UPDATE ON app_chat_receipts
WHEN NEW.read_at IS NOT NULL BEGIN
    UPDATE rail_device_marks SET seq = MAX(seq, NEW.seq)
    WHERE topic_id = NEW.topic_id AND device_id = NEW.device_id;
END;
