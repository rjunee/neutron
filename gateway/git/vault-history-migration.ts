import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { GitExecFn } from './git-exec.ts'

/** Original objects stay addressable by SHA; source repositories are never removed.
 * SHA-named refs are append-only, including tips retained only by a reflog. A retry
 * after interruption imports the same objects and cannot discard an earlier tip.
 * Both the encrypted remote bundle and restore must preserve these custom refs.
 */
export async function importLegacyVaultHistories(
  root: string,
  gitDir: string,
  git: GitExecFn,
): Promise<void> {
  const retained = new Set((await git([`--git-dir=${gitDir}`, 'for-each-ref',
    '--format=%(refname) %(objectname)', 'refs/vault-history/'])).stdout.split('\n'))
  for (const [kind, name] of [['materializer', '.git'], ['docs', '.docs-versions']] as const) {
    if (!existsSync(join(root, name))) continue
    const source = kind === 'materializer'
      ? (await git(['-C', root, 'rev-parse', '--absolute-git-dir'])).stdout.trim()
      : join(root, name)
    const args = [`--git-dir=${source}`]
    const refs = await git([...args, 'for-each-ref', '--format=%(objectname)'])
    const logs = await git([...args, 'reflog', 'show', '--all', '--format=%H'])
    const head = await git([...args, 'rev-parse', '--verify', 'HEAD'], { allowNonZero: true })
    const tips = new Set(`${refs.stdout}\n${logs.stdout}\n${head.stdout}`.split('\n')
      .filter((sha) => /^[a-f0-9]{40,64}$/.test(sha)))
    const missing: string[] = []
    for (const sha of tips) {
      const ref = `refs/vault-history/${kind}/${sha}`
      if (!retained.has(`${ref} ${sha}`)) missing.push(`${sha}:${ref}`)
    }
    // Bound argv size without traversing the same ancestry once for every tip.
    for (let start = 0; start < missing.length; start += 100) {
      await git([`--git-dir=${gitDir}`, 'fetch', '--no-tags', '--no-write-fetch-head',
        source, ...missing.slice(start, start + 100)])
    }
  }
  // A successful ref update alone is insufficient when an object store is damaged.
  await git([`--git-dir=${gitDir}`, 'rev-list', '--objects', '--missing=error', '--all'])
}
