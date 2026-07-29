# @neutron/auth — module rules

The `auth/` package owns every secret + OAuth refresh token + per-project
API key the platform stores. It generalizes the AES-256-GCM envelope
shipped by the per-instance bot token store (`token-store.ts`)
into a multi-secret store any module can use.

## Hard rules

- The encrypted envelope shape (`{ v: 1, iv_b64, ct_b64, tag_b64 }`) is
  locked. New `secrets-store.ts` MUST read envelopes written by the
  per-instance bot store unchanged — every existing bot token decrypts via
  the new SecretsStore once P1.5 lands. Forward-compatibility test in
  `__tests__/secrets-store.test.ts` and
  `tests/integration/p15-secrets-store-roundtrip.test.ts`.
- The keyfile path is `<owner_home>/.neutron-aes-key`. If a legacy
  per-instance bot keyfile already exists at that path, REUSE it. Do NOT
  overwrite. The locked test asserts a token written by the legacy
  `EncryptedBotTokenStore` decrypts via the new store after P1.5.
- File mode for any keyfile is `0600`. Never relax this.
- `SecretsStoreError` carries a typed `code` so callers can branch
  without string-matching the message.
- OAuth tokens (Max + ChatGPT) flow through the SecretsStore. The OAuth
  modules NEVER write directly to disk; they only store envelopes via
  `SecretsStore.put`.

## Persistence

- Every secret row lives in the per-project SQLite DB (`project.db`). The
  `secrets` table (migration 0009) carries (project_slug, kind, label,
  ciphertext, created_at, rotated_at?, expires_at?). The encryption key
  is on disk at `<owner_home>/.neutron-aes-key` so a DB-only leak does
  not surrender plaintext.
- `api_keys` is a thin metadata sidecar over `secrets` so listing keys
  doesn't decrypt every row.
- `signin_events` (also migration 0009) is owned by the post-signin
  bridge in `identity/api/post-signin-hook.ts` + `instance-provisioning/
  sign-in-trigger.ts` — included in the P1.5 migration so the migration
  ships as one atomic forward step.

## Testing

- Every module ships unit tests in `auth/__tests__/`.
- Mock the SecretsStore via the same options object the production
  callers use (`data_dir`, `db`). NEVER mock `crypto` — the AES roundtrip
  is the contract.
- The integration test `tests/integration/p15-secrets-store-roundtrip.
  test.ts` exercises the legacy-keyfile-reuse path end to end. That test
  is the canonical regression for the "P1.5 doesn't rot existing bot
  tokens" risk.
