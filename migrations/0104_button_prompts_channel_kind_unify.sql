-- 0104_button_prompts_channel_kind_unify.sql
--
-- N6 (`[BEHAVIOR]` ChannelKind persisted-value unification) — collapse the two
-- spellings of the app-socket channel kind onto ONE vocabulary.
--
-- Background: `ChannelKind` (channels/types.ts) has always spelled the
-- app-socket channel `'app_socket'` (underscore), and it is the value persisted
-- in `topics.channel_kind`. The button vocabulary (`ChannelKindForButton`,
-- channels/button-primitive.ts) spelled the SAME concept `'app-socket'`
-- (hyphen), and every build before this migration wrote that hyphen form into
-- `button_prompts.resolution_channel_kind` (via ButtonStore.resolve /
-- persistInertUserTurn / the upload handlers). Two vocabularies for one concept
-- is the drift N6 retires. The underscore `'app_socket'` is canonical (it is
-- the base enum + the topics-column form, so it minimizes migration surface).
--
-- This migration normalizes the persisted button rows from the legacy hyphen
-- to the canonical underscore. It is a DATA migration only (no DDL): the column
-- is a plain, un-CHECKed TEXT (migration 0010), so the value swap needs no table
-- rebuild and leaves the committed schema snapshot unchanged.
--
-- Idempotent: the UPDATE is scoped to rows that still carry the legacy token, so
-- a second run matches zero rows and is a no-op. Paired in code with a dual-read
-- window (channels/button-primitive.ts:normalizeChannelKindForButton) so a row
-- written by an in-flight pre-migration process — or a legacy value arriving off
-- the wire — is still normalized to the canonical token on read.
--
-- Only 'app-socket' is rewritten. The 'telegram' and 'webhook' button tokens are
-- already canonical; 'webhook' is a LIVE synthetic marker (sweepExpired's
-- __timeout__, persistInertAgentTurn) and is deliberately preserved.
--
-- Forward-only; no down-migration (Neutron OSS contract).

UPDATE button_prompts
   SET resolution_channel_kind = 'app_socket'
 WHERE resolution_channel_kind = 'app-socket';
