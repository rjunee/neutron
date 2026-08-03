-- 0113_cores_oauth_broker_pending.sql
--
-- The BROKER side of the Cores Google-OAuth flow: `state` → which instance the
-- callback belongs to.
--
-- WHY A BROKER EXISTS AT ALL. Google will only redirect to a redirect_uri that
-- was pre-registered on the OAuth client. A deployment that serves many
-- instances cannot pre-register one URI per instance, so all of them share a
-- single registered URI and something at that URI has to work out which
-- instance a given callback belongs to. `state` is that handle, and this table
-- is where the mapping lives between the instance saying "I am about to send a
-- user to Google with this state" and Google coming back with it minutes later.
--
-- WHY IT IS A SEPARATE TABLE FROM `cores_oauth_pending`. That table is the
-- INSTANCE's half: it holds the PKCE `code_verifier`, the requested labels and
-- the redirect_uri, i.e. everything needed to redeem the code — and none of it
-- belongs to the broker, which never redeems anything. Keeping the two apart is
-- what lets the same broker code run REMOTELY (a central identity host with no
-- instance tables at all) and CO-LOCATED (an Open self-host that is its own
-- broker) without either role reaching into the other's state. One flow, two
-- deployments, per SPEC § Decisions Log 2026-08-02.
--
-- THE BROKER HOLDS NO OAUTH SECRET. It stores a routing row and relays
-- `{code, state}` onward over an HMAC-signed request; the CLIENT SECRET stays on
-- the instance, inside `OAuthTokenManager`, which performs the exchange. So a
-- compromised broker leaks routing metadata and replay-window signatures — never
-- a credential that can mint tokens. That property is why the same central
-- broker can serve many instances without ever holding their secrets.
--
-- `dispatch_url` is supplied by the instance at register time and is the exact
-- URL the code is relayed back to. It is stored rather than derived so the
-- broker never has to know an instance's URL scheme.
--
-- Rows are SINGLE-USE and short-lived: the callback consumes the row, and
-- anything past `expires_at` is swept. A replayed `state` therefore finds
-- nothing, which is the first of the two defences (the instance's own pending
-- row is single-use too, and the relay carries a ±5 min signed timestamp).
--
-- Forward-only; no down-migration (Neutron OSS contract).

CREATE TABLE IF NOT EXISTS cores_oauth_broker_pending (
  -- The opaque state handle minted by the instance; also the join key Google
  -- echoes back on the callback.
  state         TEXT    NOT NULL PRIMARY KEY,
  -- Which instance registered it. Checked against the relay target so a state
  -- minted for one instance can never be dispatched to another.
  project_slug  TEXT    NOT NULL,
  -- Absolute URL the authorization code is relayed to (the instance's
  -- `/api/cores/oauth/google/ingest`).
  dispatch_url  TEXT    NOT NULL,
  -- Epoch ms. Past this the row is dead even if never consumed.
  expires_at    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
) STRICT;

-- The sweep reads by expiry; the callback reads by primary key.
CREATE INDEX IF NOT EXISTS idx_cores_oauth_broker_pending_expires
  ON cores_oauth_broker_pending (expires_at);
