/**
 * @neutronai/onboarding/history-import — Drive OAuth importer (STUB, P2 S3).
 *
 * Per docs/plans/P2-onboarding.md § 6 S3 line 1997 + § 2.3 budget table
 * row "Drive / Notion / Slack OAuth STUB only in P2 ($0)".
 *
 * S3 ships ONLY the surface: the not-yet-supported UX message. The live
 * import dispatcher (default-source-parser.ts) raises the typed error
 * from this constant. The actual fetch + parse lands in a later sprint.
 */

export const DRIVE_STUB_MESSAGE =
  "Google Drive import isn't supported yet — we'll add this in a later update."
