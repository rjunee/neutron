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

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  it('sits beside the credentials file it describes', () => {
    // Takes the PATH, not the env: this module must not import
    // `active-credential.ts`, which imports it — the layering gate refused that
    // cycle, correctly, and the path argument is also the clearer contract.
    expect(credentialLabelPath('/var/lib/x/.claude/.credentials.json')).toBe(
      '/var/lib/x/.claude/.credentials.meta.json',
    )
    expect(credentialLabelPath('/home/someone/.claude/.credentials.json')).toBe(
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
  const CREDS = '/x/.claude/.credentials.json'

  it('returns the label when the fingerprint matches the token in hand', () => {
    const deps = sidecar({ label: 'acct-2', fingerprint: credentialFingerprint(TOKEN) })
    expect(readCredentialLabel(CREDS, TOKEN, deps)).toBe('acct-2')
  })

  it('REFUSES a label whose fingerprint describes a different token', () => {
    // The whole reason this module exists. A sidecar left by the previous swap
    // would otherwise stamp the old account's name onto the new account's reading.
    const deps = sidecar({ label: 'acct-1', fingerprint: credentialFingerprint(OTHER_TOKEN) })
    expect(readCredentialLabel(CREDS, TOKEN, deps)).toBeNull()
  })

  it('refuses a label with no fingerprint at all', () => {
    // A writer that omits it has not proven which token it meant, and "probably the
    // current one" is exactly the assumption that goes wrong during a swap.
    expect(readCredentialLabel(CREDS, TOKEN, sidecar({ label: 'acct-2' }))).toBeNull()
  })

  it('returns null when there is no sidecar — the ordinary case, not an error', () => {
    expect(
      readCredentialLabel(CREDS, TOKEN, {
        readFile: (): string => {
          throw new Error('ENOENT')
        },
      }),
    ).toBeNull()
  })

  it('returns null on unparseable, non-object, or wrong-typed content', () => {
    const fp = credentialFingerprint(TOKEN)
    expect(readCredentialLabel(CREDS, TOKEN, { readFile: (): string => 'not json' })).toBeNull()
    expect(readCredentialLabel(CREDS, TOKEN, { readFile: (): string => 'null' })).toBeNull()
    expect(readCredentialLabel(CREDS, TOKEN, { readFile: (): string => '[]' })).toBeNull()
    expect(readCredentialLabel(CREDS, TOKEN, sidecar({ label: 7, fingerprint: fp }))).toBeNull()
    expect(readCredentialLabel(CREDS, TOKEN, sidecar({ label: 'a', fingerprint: 7 }))).toBeNull()
  })

  it('trims a label, and refuses an empty or absurdly long one', () => {
    const fp = credentialFingerprint(TOKEN)
    expect(readCredentialLabel(CREDS, TOKEN, sidecar({ label: '  acct-2  ', fingerprint: fp }))).toBe(
      'acct-2',
    )
    expect(readCredentialLabel(CREDS, TOKEN, sidecar({ label: '   ', fingerprint: fp }))).toBeNull()
    // A 200-character "name" is a mistake being written into a UI, not a name.
    expect(
      readCredentialLabel(CREDS, TOKEN, sidecar({ label: 'x'.repeat(200), fingerprint: fp })),
    ).toBeNull()
  })

  it('accepts exactly 64 characters and refuses 65 — the boundary, not a round number', () => {
    // 200 characters is rejected by any off-by-one version of the check, so it proved
    // only that SOME limit exists. Where the limit falls is the part a later edit can
    // move without any test noticing.
    const fp = credentialFingerprint(TOKEN)
    expect(readCredentialLabel(CREDS, TOKEN, sidecar({ label: 'x'.repeat(64), fingerprint: fp }))).toBe(
      'x'.repeat(64),
    )
    expect(
      readCredentialLabel(CREDS, TOKEN, sidecar({ label: 'x'.repeat(65), fingerprint: fp })),
    ).toBeNull()
  })
})

describe('the real path, on a real filesystem — no injected reader', () => {
  /**
   * WHY THIS BLOCK EXISTS, given everything above already passes.
   *
   * Every positive test above injects `readFile`/`readLabel`, which means the two
   * things that can only ever be wrong in production were asserted by nothing: WHERE
   * the sidecar is looked for, and whether the default reader is wired to look there
   * at all. The one test that used the default reader pointed at a directory that does
   * not exist and expected null — an assertion a completely wrong path satisfies just
   * as well as a correct one. So these two use real files at real paths and pass no
   * deps whatsoever.
   */
  function withSidecar(body: unknown, assert: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), 'neutron-account-label-'))
    try {
      writeFileSync(
        join(dir, '.credentials.json'),
        JSON.stringify({ claudeAiOauth: { accessToken: TOKEN } }),
        { mode: 0o600 },
      )
      // 0600, because that is what the sidecar contract requires of a writer — see
      // `docs/AS_BUILT.md` § 2026-08-09 — Naming the account behind a reading § The sidecar. The
      // reader does not enforce it (a silent label drop is the one failure mode this
      // feature works hardest to avoid), so the fixture models the contract instead.
      writeFileSync(join(dir, '.credentials.meta.json'), JSON.stringify(body), { mode: 0o600 })
      assert(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('finds and uses a sidecar that is actually on disk beside the credential', () => {
    withSidecar({ label: 'acct-2', fingerprint: credentialFingerprint(TOKEN) }, (dir) => {
      expect(resolveActiveCredential({ CLAUDE_CONFIG_DIR: dir })).toEqual({
        kind: 'measurable',
        token: TOKEN,
        account_label: 'acct-2',
      })
    })
  })

  it('REFUSES a stale on-disk sidecar, through the same wiring that accepts a good one', () => {
    // The refusal is the whole value of the feature, so it has to be proven on the
    // production path and not only against an injected reader. Same directory, same
    // default reader, same token — only the fingerprint describes a token we are not
    // holding, which is exactly the state a swap leaves behind.
    withSidecar({ label: 'acct-1', fingerprint: credentialFingerprint(OTHER_TOKEN) }, (dir) => {
      expect(resolveActiveCredential({ CLAUDE_CONFIG_DIR: dir })).toEqual({
        kind: 'measurable',
        token: TOKEN,
        account_label: null,
      })
    })
  })
})

describe('the label is resolved WITH the credential, never separately', () => {
  it('carries the label for the env token', () => {
    const resolved = resolveActiveCredential(
      { CLAUDE_CONFIG_DIR: '/x/.claude', CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
      { readLabel: (t) => (t === TOKEN ? 'acct-2' : null) },
    )
    expect(resolved).toEqual({ kind: 'measurable', token: TOKEN, account_label: 'acct-2' })
  })

  it('carries the label for the token on disk — the one a host swaps', () => {
    const blob = JSON.stringify({ claudeAiOauth: { accessToken: TOKEN } })
    const resolved = resolveActiveCredential(
      { CLAUDE_CONFIG_DIR: '/x/.claude' },
      { readFile: () => blob, readLabel: (t) => (t === TOKEN ? 'acct-3' : null) },
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
        readLabel: (t) => {
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

  it('a writer following the DOCS produces a fingerprint this reader accepts', () => {
    // The docs are the whole interface for the half of this contract that lives in
    // another process, so a stale sentence in them is a defect in the feature — and
    // it drifted TWICE: the as-built § The sidecar and the plan's Tier-1 bullet each
    // described a sidecar this reader silently rejects (`sha256(token)` in one, no
    // fingerprint at all in the other). Silently is the problem: labels just stop
    // appearing, which is indistinguishable from the ordinary unlabelled case.
    //
    // Scoped to the CONTRACT statement, not the prose: the as-built file legitimately
    // discusses SHA-256 and scrypt in its history section, and a guard that tripped on
    // that would be a false positive on the very document it protects.
    const algorithm = /sha-?\d|scrypt|md5|digest|hash/i
    const contract = (doc: string, from: string, to: string): string => {
      const at = doc.indexOf(from)
      expect(at).toBeGreaterThan(-1)
      // THE END HAS TO BE FOUND TOO. `indexOf` returns -1 when the terminator is
      // gone, and `slice(at, -1)` does not fail — it silently widens the region to
      // the whole rest of the document. Measured: renaming the Tier-2 heading grew
      // the "Tier 1 bullet" from 982 to 11328 characters with all three assertions
      // below still green. A drift guard that quietly stops being scoped to the one
      // statement it guards is worse than no guard, because it reports success.
      const end = doc.indexOf(to, at + from.length)
      expect(end).toBeGreaterThan(at)
      return doc.slice(at, end)
    }

    // The contract used to live in its own file, `docs/as-built/2026-08-09-credential-
    // account-label.md`, and this test read it whole. That directory is gone — every
    // entry folded back into the one canonical `docs/AS_BUILT.md` — so the read has to
    // be SCOPED to the entry before any of the anchors below mean anything: run
    // `contract` against the whole log and the "fenced JSON block that shows a writer
    // what to write" is whichever block happens to appear first in 300 entries, which
    // is a guard that passes while reading someone else's document.
    const asBuilt = contract(
      readFileSync(new URL('../../docs/AS_BUILT.md', import.meta.url), 'utf8'),
      '## 2026-08-09 — Naming the account behind a reading',
      '\n## 2026-08-09 — A fix round that never reached the branch',
    )
    // The fenced JSON block that shows a writer what to write.
    const block = contract(asBuilt, '```json', '```\n')
    expect(block).toContain('fingerprint')
    expect(block).not.toMatch(algorithm)
    expect(asBuilt).toContain('credentialFingerprint')

    // AND that the contract ASKS for the file permission its own security argument
    // depends on. The case for scrypt-over-sha256 cites a 0600 sidecar as one of three
    // facts making a weak digest unexploitable — but this reader cannot check the mode,
    // and refusing a loose one would drop the label silently. So the requirement only
    // exists if the writer-facing contract states it, which for a while it did not: the
    // permission was asserted as an observed fact in the security note and required of
    // nobody.
    expect(contract(asBuilt, '### The sidecar', '### ⚠️')).toContain('0600')

    const plan = readFileSync(
      new URL('../../docs/plans/2026-08-09-model-usage-dashboard.md', import.meta.url),
      'utf8',
    )
    // The Tier-1 bullet, up to the start of Tier 2.
    const bullet = contract(plan, '**Tier 1 — a label.**', '- **Tier 2')
    expect(bullet).toContain('"fingerprint"')
    expect(bullet).toContain('credentialFingerprint')
    expect(bullet.replace('credentialFingerprint', '')).not.toMatch(algorithm)
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
