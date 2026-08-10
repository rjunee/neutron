/**
 * A LABEL THAT DESCRIBES A DIFFERENT TOKEN IS WORSE THAN NO LABEL.
 *
 * The usage series has an `account_label` column that has been null on every row,
 * because whatever swaps `.credentials.json` does so from outside this process and
 * the token carries no account name. This reads an optional sidecar that names it.
 *
 * ⚠️ THE FAILURE THIS FILE EXISTS FOR IS NOT "the label is missing" — a missing
 * label renders as "active credential", which is true and harmless. It is a label
 * left behind by a PREVIOUS swap being attached to a CURRENT reading. That produces
 * a graph that looks right, reads right, and sends the owner to move quota away from
 * an account that was never the one under load. Hence the fingerprint: the label is
 * used only when it demonstrably describes the token actually in hand.
 *
 * Every other malformed input funnels to the same null, because the surfaces have
 * exactly one way to say "we don't know which account this is".
 */

import { describe, expect, it } from 'bun:test'

import {
  credentialFingerprint,
  credentialLabelPath,
  readCredentialLabel,
} from '../credential-label.ts'
import { resolveActiveCredential } from '../active-credential.ts'

const TOKEN = 'sk-ant-oat01-example-token-for-tests'
const OTHER_TOKEN = 'sk-ant-oat01-a-completely-different-token'

function sidecar(body: unknown): { readFile: () => string } {
  return { readFile: (): string => JSON.stringify(body) }
}

describe('credentialLabelPath', () => {
  it('sits beside the credentials file in an isolated config dir', () => {
    const p = credentialLabelPath({ CLAUDE_CONFIG_DIR: '/var/lib/x/.claude' })
    expect(p).toBe('/var/lib/x/.claude/.credentials.meta.json')
  })

  it('follows HOME when no config dir is set', () => {
    expect(credentialLabelPath({ HOME: '/home/someone' })).toBe(
      '/home/someone/.claude/.credentials.meta.json',
    )
  })
})

describe('credentialFingerprint', () => {
  it('is short, stable, and not the token', () => {
    const fp = credentialFingerprint(TOKEN)
    expect(fp).toHaveLength(12)
    expect(fp).toMatch(/^[0-9a-f]{12}$/)
    expect(fp).toBe(credentialFingerprint(TOKEN))
    expect(TOKEN.includes(fp)).toBe(false)
  })

  it('differs for different tokens', () => {
    expect(credentialFingerprint(TOKEN)).not.toBe(credentialFingerprint(OTHER_TOKEN))
  })
})

describe('readCredentialLabel', () => {
  const env = { CLAUDE_CONFIG_DIR: '/x/.claude' }

  it('returns the label when the fingerprint matches the token in hand', () => {
    const deps = sidecar({ label: 'acct-2', fingerprint: credentialFingerprint(TOKEN) })
    expect(readCredentialLabel(env, TOKEN, deps)).toBe('acct-2')
  })

  it('REFUSES a label whose fingerprint describes a different token', () => {
    // The whole reason this module exists. A sidecar left by the previous swap
    // would otherwise stamp the old account's name onto the new account's reading.
    const deps = sidecar({ label: 'acct-1', fingerprint: credentialFingerprint(OTHER_TOKEN) })
    expect(readCredentialLabel(env, TOKEN, deps)).toBeNull()
  })

  it('refuses a label with no fingerprint at all', () => {
    // A writer that omits it has not proven which token it meant, and "probably the
    // current one" is exactly the assumption that goes wrong during a swap.
    expect(readCredentialLabel(env, TOKEN, sidecar({ label: 'acct-2' }))).toBeNull()
  })

  it('returns null when there is no sidecar — the ordinary case, not an error', () => {
    expect(
      readCredentialLabel(env, TOKEN, {
        readFile: (): string => {
          throw new Error('ENOENT')
        },
      }),
    ).toBeNull()
  })

  it('returns null on unparseable, non-object, or wrong-typed content', () => {
    const fp = credentialFingerprint(TOKEN)
    expect(readCredentialLabel(env, TOKEN, { readFile: (): string => 'not json' })).toBeNull()
    expect(readCredentialLabel(env, TOKEN, { readFile: (): string => 'null' })).toBeNull()
    expect(readCredentialLabel(env, TOKEN, { readFile: (): string => '[]' })).toBeNull()
    expect(readCredentialLabel(env, TOKEN, sidecar({ label: 7, fingerprint: fp }))).toBeNull()
    expect(readCredentialLabel(env, TOKEN, sidecar({ label: 'a', fingerprint: 7 }))).toBeNull()
  })

  it('trims a label, and refuses an empty or absurdly long one', () => {
    const fp = credentialFingerprint(TOKEN)
    expect(readCredentialLabel(env, TOKEN, sidecar({ label: '  acct-2  ', fingerprint: fp }))).toBe(
      'acct-2',
    )
    expect(readCredentialLabel(env, TOKEN, sidecar({ label: '   ', fingerprint: fp }))).toBeNull()
    // A 200-character "name" is a mistake being written into a UI, not a name.
    expect(
      readCredentialLabel(env, TOKEN, sidecar({ label: 'x'.repeat(200), fingerprint: fp })),
    ).toBeNull()
  })
})

describe('the label is resolved WITH the credential, never separately', () => {
  it('carries the label for the env token', () => {
    const resolved = resolveActiveCredential(
      { CLAUDE_CONFIG_DIR: '/x/.claude', CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
      { readLabel: (_e, t) => (t === TOKEN ? 'acct-2' : null) },
    )
    expect(resolved).toEqual({ kind: 'measurable', token: TOKEN, account_label: 'acct-2' })
  })

  it('carries the label for the token on disk — the one a host swaps', () => {
    const blob = JSON.stringify({ claudeAiOauth: { accessToken: TOKEN } })
    const resolved = resolveActiveCredential(
      { CLAUDE_CONFIG_DIR: '/x/.claude' },
      { readFile: () => blob, readLabel: (_e, t) => (t === TOKEN ? 'acct-3' : null) },
    )
    expect(resolved).toEqual({ kind: 'measurable', token: TOKEN, account_label: 'acct-3' })
  })

  it('asks the label reader about the SAME token it resolved, not some other one', () => {
    // The structural guarantee. If these two ever came from separate calls, a swap
    // landing between them would pair one account's reading with another's name.
    const blob = JSON.stringify({ claudeAiOauth: { accessToken: TOKEN } })
    const asked: string[] = []
    resolveActiveCredential(
      { CLAUDE_CONFIG_DIR: '/x/.claude' },
      {
        readFile: () => blob,
        readLabel: (_e, t) => {
          asked.push(t)
          return null
        },
      },
    )
    expect(asked).toEqual([TOKEN])
  })

  it('does not consult the label reader when there is nothing to measure', () => {
    // An API-key box has no window to draw and no account to name; asking would be
    // a pointless disk read on every tick.
    let asked = 0
    const resolved = resolveActiveCredential(
      { CLAUDE_CONFIG_DIR: '/x/.claude', ANTHROPIC_API_KEY: 'sk-ant-api-x' },
      {
        readFile: (): string => {
          throw new Error('ENOENT')
        },
        readLabel: () => {
          asked += 1
          return 'nope'
        },
      },
    )
    expect(resolved).toEqual({ kind: 'unmeasurable', reason: 'unsupported_credential' })
    expect(asked).toBe(0)
  })

  it('the default label reader does NOT inherit the credentials readFile stub', () => {
    // Otherwise a test could "pass" by feeding the credentials blob to the label
    // parser, and the seam would look isolated while sharing one source.
    const blob = JSON.stringify({
      claudeAiOauth: { accessToken: TOKEN },
      label: 'smuggled',
      fingerprint: credentialFingerprint(TOKEN),
    })
    const resolved = resolveActiveCredential(
      { CLAUDE_CONFIG_DIR: '/definitely/not/a/real/dir/.claude' },
      { readFile: () => blob },
    )
    expect(resolved).toEqual({ kind: 'measurable', token: TOKEN, account_label: null })
  })
})
