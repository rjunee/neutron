# Migrating existing Codex project credential directories

An existing unmarked project directory is refused until its project identity is
confirmed explicitly. This is an upgrade step: affected project overrides cannot
run during the interval. Global subscriptions are unaffected. New directories
record their project id when created (`trident/codex-project-owner.ts:32`).

Do this before resuming project work after upgrading:

1. Stop Neutron and any Codex processes using these directories. Keep them stopped
   throughout migration, so no credential refresh or directory replacement races it.
2. Back up the Codex home, preserving permissions. Rehearse on this copy first.
   Never run Codex against the copy: two live refresh-token copies can revoke each
   other. The automated copy rehearsal is `trident/codex-credential.test.ts:590`.
3. Establish the **exact project id independently** from project setup records and
   the operator's knowledge of which project was connected. The hashed directory
   name alone is insufficient. A ChatGPT account id identifies a subscription,
   not a project. If the identity is ambiguous, leave the directory untouched and
   reconnect with a fresh login into a new verified directory after moving the
   ambiguous directory aside while stopped. Do not guess or relabel a mismatch.
4. Set `migration_codex_home` to the copy's global Codex home and
   `migration_project_id` to that confirmed project id. From the repository run:

   ```sh
   bun -e 'import { migrateCodexProjectOwner } from "./trident/codex-project-owner.ts"; console.log(migrateCodexProjectOwner(process.argv[1], process.argv[2]))' "$migration_codex_home" "$migration_project_id"
   ```

   The result is `{ changed: true }` for a new marker, `{ changed: false }` for
   the same existing owner, or a refusal for a different or unreadable owner
   (`trident/codex-project-owner.ts:54`). It never rewrites `auth.json` or rollouts.
5. Compare credential bytes and permissions between original and copy without
   printing secrets. Repeat the same command with `migration_codex_home` pointing
   to the original, then restart Neutron. Retain the backup securely offline.

The marker is `project-owner.json`, containing the JSON string of the full project
id, written exclusively at mode 0600. Do not delete it during disconnect or token
rotation. Every service project-directory access verifies it; it is not a cached
boot assertion (`trident/codex-project-owner.ts:21`,
`trident/codex-credential.ts:386`). Missing or damaged markers require the same
explicit identity investigation. This is protection against accidental identity
aliasing, not against an actor who can rewrite the credential directory itself.
