-- 0024_pending_redirects.sql
--
-- 2026-05-11 — bug fix from an M2 walkthrough (e.g. instance t-example1,
-- url_slug=acme, box 203.0.113.10). The slug-picker's "redirect
-- emit returned delivered=false → skip systemctl restart" branch
-- (gateway/http/chat-bridge.ts) correctly detected a WS-closed-during-
-- rename condition and held off the restart so the operator could
-- retry — but the user-facing redirect was already lost. The comment
-- referenced a "reconciler can retry" that does not exist; the user
-- sits on chat.shared forever waiting for a navigation that never
-- arrives, even though the rename succeeded server-side and the
-- renamed instance's chat URL (e.g. acme.example.test/chat) is live.
--
-- This migration persists the redirect at WS-closed time so the next
-- WS connect from the same topic_id (chat.shared dispatcher OR the
-- new instance subdomain) emits the RedirectOutbound envelope BEFORE
-- accepting the first inbound user_message. After delivery the row is
-- deleted; the 15-min TTL covers users who abandon the flow.
--
-- Storage shape:
--   - topic_id is the PK so a second WS-closed event for the same user
--     overwrites the prior row (last-write-wins is the right model for
--     a queued redirect — only the most recent rename target matters).
--   - new_slug + target_url are denormalised for read efficiency; the
--     downstream emit just renders the envelope without dipping back
--     into the registry.
--   - new_start_token is persisted so the FE has a fresh JWT bound to
--     the NEW slug; without it the reconnect would have to dip into
--     the slug-history shim, which is slower and adds a failure mode.
--   - expires_at_ms gates delivery so a stale pending redirect never
--     fires after the user-abandonment window elapses.
--
-- Forward-only. STRICT for column-type discipline.

CREATE TABLE IF NOT EXISTS pending_redirects (
    topic_id TEXT PRIMARY KEY NOT NULL,
    new_slug TEXT NOT NULL,
    target_url TEXT NOT NULL,
    new_start_token TEXT NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL
) STRICT;

-- Index on expires_at_ms so the pruner's
-- `DELETE WHERE expires_at_ms < ?` is fast even if the table accumulates
-- many short-lived rows during a high-traffic onboarding window. Same
-- shape as `signup_consumed_start_tokens_expires` (0022).
CREATE INDEX IF NOT EXISTS pending_redirects_expires
    ON pending_redirects (expires_at_ms);
