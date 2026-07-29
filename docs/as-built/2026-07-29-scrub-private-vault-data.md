## 2026-07-29 — Scrub owner-private data out of the migration lane and its docs

The the legacy harness→Neutron migration code was written directly into this PUBLIC repo, and it carried the reference vault's real contents into it. Not secrets — no keys, no tokens — but personal data: the owner's real portfolio/project slugs used as test fixture names, their home-directory paths, their messaging handle and numeric account id, and comment prose that inventoried which specific projects in their vault had which frontmatter defects. This change replaces all of it with neutral synthetic equivalents. Working tree only; no history rewrite.

### What was removed, by category

1. **Real project / business slugs used as fixture identifiers.** Test trees, manifest fixtures, expected display names and report assertions were all keyed on the owner's actual portfolio. Replaced with synthetic slugs chosen to preserve the shapes the tests exercise: hyphenation, acronym segments, CamelCase brands, and the prefix-collision pair (`<slug>` vs `<slug>-2`) that the history lane's topic-id check depends on.
2. **Personal filesystem paths and the account name inside them.** Absolute home paths and the Claude Code `~/.claude/projects/<encoded-cwd>/` directory slugs that embed them, in both comments and fixtures.
3. **Messaging identity.** The owner's real handle appeared in `<channel>` envelope examples AND as the *production default* of `DEFAULT_OWNER_HANDLE`; a real numeric account id appeared in a verbatim envelope sample. Both are now neutral placeholders — see the behaviour note below.
4. **Vault-inventory prose.** Several module headers named *which* specific projects were missing frontmatter, used an alternate key set, or carried inline `#` comments. Each was rewritten to state the SHAPE that motivates the parser branch without enumerating the vault. The engineering reasoning is deliberately untouched — the manifest-join-vs-re-derivation argument, the priority polarity inversion, `Dirent.isFile()` being false for symlinks, the timeline-embedding hazard, and the byte-fidelity rationale all survive verbatim.
5. **A hand-curated display-name override table** that was, in effect, a copy of the owner's project list. Reframed as neutral examples of the two families it actually exists for (acronym segment, CamelCase brand), with a note to extend it per install.
6. **Third-party personal names** appearing in fixture content and entity-page fixtures.
7. **A private counterparty name** used as a column-padding demo string, and residual owner-name possessives throughout the lane's comments (now "the owner").

### One behaviour change, deliberate

`DEFAULT_OWNER_HANDLE` (`open/legacy-import/history/classify.ts`) was a real handle and is now the placeholder `'owner'`. The history lane classifies an entry as the owner's only when the `<channel user="…">` attribute matches, so any install whose transcripts use a different handle must now pass `--owner-handle <handle>` (the flag already existed and is surfaced in `--help`). A mismatch is loud, not silent: the lane classifies zero owner messages and the dry-run report shows that before anything is written.

### Verification

- Repo-wide grep for the removed identifier set across `open/`, `docs/`, `bin/` returns zero hits.
- Every affected test file passes with the **same** test and assertion counts as before the rename (311 tests / 1293 assertions across the ten migration-lane files; 336 / 1413 including the substrate-wiring test). No assertion was relaxed, deleted, or made less specific — fixture *names* changed, the properties asserted did not.
- `bunx tsc -p open/tsconfig.json --noEmit` clean; `scripts/ci/leak-gate.sh --tree .` silent.
- **Mutation-checked** that the load-bearing assertions still bite after the rename: re-deriving the destination project id from the source directory name instead of reading the manifest → 7 failures; trimming the body in the document write path → 12 failures; trimming the extracted `<channel>` body → 4 failures. All three were reverted after measurement.

### Known residue (not closed here)

The owner's first name still appears in comments, fixture slugs and test data across roughly fifty files OUTSIDE the migration lane — onboarding, connect, landing, gateway, work-board, reminders, trident, runtime and the mobile app — as does at least one collaborator's first name. That is the same class of leak and wants a follow-up sweep; it was left alone here to keep this change reviewable and to avoid touching subsystems whose tests were out of scope.
