/** Metadata only: the referenced account remains the credential authority. */
export interface CodexProjectGrant {
  kind: 'codex-project-grant'
  version: 1
  grant_id: string
  source_row_id: string
  account_identity: string
}

export function readCodexProjectGrant(plaintext: string): CodexProjectGrant | null {
  const value = JSON.parse(plaintext)
  if (value?.kind !== 'codex-project-grant') return null
  if (value.version !== 1 || typeof value.grant_id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.grant_id)
    || typeof value.source_row_id !== 'string' || !value.source_row_id
    || typeof value.account_identity !== 'string' || !/^[a-f0-9]{64}$/.test(value.account_identity)) {
    throw new Error('Invalid Codex project grant')
  }
  return value as CodexProjectGrant
}
