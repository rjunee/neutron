/** Shared redacted git diagnostics for publication and replay (dependencies of inventory G085 and G087–G097). */

/**
 * A PUBLISH FAILURE MUST CARRY GIT'S OWN WORDS — WITHOUT BECOMING A DISCLOSURE SURFACE.
 *
 * WHY THIS EXISTS. Run `2aacf419` (2026-08-14) was the first build ever to reach the publish
 * step. It failed, and the stored reason was `outer publisher could not push branch <b>` — the
 * branch name and nothing else. git's stderr had ALREADY said, in words,
 * `! [rejected] ... (non-fast-forward)`. It was thrown away.
 *
 * That is the sibling of the defect fixed in #240 and it landed in brand-new code. #240 removed a
 * message that ASSERTED a cause it never measured; this one MEASURED the cause and dropped it.
 * Opposite mistakes, identical cost: the reader cannot act. Recovering that one line cost a DB
 * read, a hand comparison of merge-bases, and a credentialed dry-run push.
 *
 * BUT stderr from a push is exactly where a credential can surface — a remote URL of the form
 * `https://user:token@host/...` is echoed back verbatim by git. So the text is carried THROUGH
 * this function or not at all. Redaction is not decoration here; without it, fixing an
 * observability defect would open a disclosure one.
 */
export function redactPushError(text: string): string {
  return (
    text
      // ANY userinfo before the `@`, not just `user:password` — git echoes the remote back on
      // failure. CODEX REVIEW [P1 Security]: the first cut required a colon, so the extremely
      // common single-value form `https://<token>@host/...` sailed straight through into a
      // PERSISTED failure reason. A token needs no password half to be a token.
      // The scheme is BOUNDED (`\w{1,32}`) rather than `\w+`: an unbounded prefix before a
      // literal `://` backtracks polynomially on input that is a long run of word characters
      // with no `://` — CodeQL js/polynomial-redos, and this function is fed raw git stderr.
      // No real URL scheme approaches 32 characters, so nothing that was redacted before
      // stops being redacted.
      .replace(/(\w{1,32}:\/\/)[^/\s@]+@/g, '$1***@')
      // Bare GitHub token shapes, in case one reaches stderr by another route.
      .replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '$1***')
      .trim()
      // A reason is read by a human in a chat row; an unbounded paste is its own failure.
      .slice(0, 600)
  )
}

/**
 * The reason for a failed publish step: what we were doing, and what git said about it.
 * Nothing is inferred — the cause is quoted, not deduced.
 */
export function publishFailureReason(step: string, branch: string, stderr: string): string {
  const said = redactPushError(stderr)
  return said === ''
    ? `outer publisher could not ${step} branch ${branch}`
    : `outer publisher could not ${step} branch ${branch}: ${said}`
}

