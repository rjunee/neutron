# Encrypted vault backup and recovery

The canonical vault history remains `<project>/.project-backup/`. The remote
transport exports all of its refs (including archived legacy histories) as a complete Git bundle and encrypts it
with AES-256-GCM before adding any object to the remote Git repository. Each
project has one opaque, keyed directory containing a manifest and numbered
ciphertext chunks. The remote's Git history retains earlier
encrypted exports. Filenames, commit messages and historical content inside the
vault bundle are encrypted; ciphertext sizes and upload timing are visible.

Provision one private GitHub repository with an initialized `main` branch and
HTTPS push access through an authenticated GitHub CLI. Record the repository's
numeric ID as well as its `owner/name`. Git uses a per-command credential helper
scoped to `https://github.com`; global and system Git configuration are ignored,
ambient credential helpers are reset, and HTTP redirects are refused. Credential
bytes are never written into the remote URL, command arguments or Git config.
Each push and restore checks the private repository identity through GitHub's
API; unavailability refuses the operation. A repository replacement, rename,
privacy change or missing key must be resolved explicitly.

Create a new 32-byte recovery key with:

```sh
bun scripts/vault-backup.ts keygen /secure/location/vault-recovery.key
```

The command creates an owner-only file and refuses to overwrite an existing key.
Keep the key outside every vault. Transfer a recovery copy to owner-controlled
storage off the host using a secure channel; do not paste it into chat, logs,
source control or the backup repository. Losing every copy makes encrypted
backups unrecoverable. The application cannot independently verify physical
off-host custody: `recoveryConfirmed` is an explicit operator attestation.

Create `<owner-home>/.vault-backup/config.json` after securing the recovery copy:

```json
{
  "version": 1,
  "repository": "example/private-vault-archive",
  "repositoryId": 123456,
  "keyFile": "/secure/location/vault-recovery.key",
  "recoveryConfirmed": true
}
```

There is no default destination. Omitted configuration leaves local history
available. Invalid configuration refuses remote backup. Keys must be regular,
non-symlink files, exactly 32 bytes, owned by the process user and inaccessible
to group and others. GitHub CLI authentication is independent of the encryption
key and must be provisioned again on a replacement host.

Run an export after the project store has taken a safe snapshot:

```sh
bun scripts/vault-backup.ts push OWNER_HOME PROJECT_ID PROJECT_DIR
```

The transport does not snapshot working files. It reads only the canonical
history, so the store's exclusions and SQLite snapshot rules remain responsible
for what enters that history. Each export uses a fresh remote clone and a normal
fast-forward push. Concurrent pushes may refuse and need another scheduled
attempt; they never force-push or overwrite another project's changes.
Ciphertext chunks are at most 32 MiB each, keeping every uploaded object below
GitHub's individual-file limit. The bundle may be up to 1 GiB; larger bundles
refuse explicitly before upload. Processing keeps at most one chunk of plaintext
and ciphertext in memory. The format version, complete byte count, chunk count,
and chunk size are authenticated alongside the repository and project identity.
Restore rejects missing, additional, resized, reordered or corrupted chunks;
no decrypted bundle is passed to Git before its final authentication succeeds.
The latest export is fetched with a shallow clone; each exported bundle itself
still includes all canonical and archived history refs.
Temporary plaintext bundles are kept inside mode-0700 scratch directories and
removed after the operation; process termination can leave scratch directories
for host cleanup. Storage encryption remains the host operator's responsibility.

On a fresh host, provision the recovery key with mode 0600 and recreate the
configuration with the same numeric repository ID and exact project ID. Restore
to a **new, nonexistent directory**, whose parent already exists:

```sh
bun scripts/vault-backup.ts restore OWNER_HOME PROJECT_ID NEW_DESTINATION
```

Restore clones the remote afresh, authenticates the complete encrypted bundle
before using its plaintext, checks Git object integrity, restores the full
history and archived refs into `.project-backup/`, and checks out `main`. Existing
destinations are refused. Nested code repositories and credentials excluded by
the snapshot policy must be restored separately. Verify representative files
and SQLite integrity before directing the application at the recovered vault.

The authentication tag detects changes and cross-project substitution. It does
not prove freshness against a server replaying a previously valid backup; retain
successful snapshot receipts separately if rollback detection is required.
The local fixture drill is `bun test gateway/__tests__/project-backup-remote.test.ts`.
A live drill must additionally restore from the real private remote using the
off-host recovery copy; local fixture success does not establish that custody.
