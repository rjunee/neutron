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
    for (const sha of tips) {
      const ref = `refs/vault-history/${kind}/${sha}`
      await git([`--git-dir=${gitDir}`, 'fetch', '--no-tags', '--no-write-fetch-head',
        source, `${sha}:${ref}`])
      // A successful ref update is insufficient when an object store is damaged.
      await git([`--git-dir=${gitDir}`, 'rev-list', '--objects', '--missing=error', ref])
    }
  }
}
