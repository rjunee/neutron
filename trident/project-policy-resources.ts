import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

/** Host-only root, outside worker writable roots. Each allocation records its owner
 * in its name before any materialisation; another host reaps dead owners on entry.
 * A live or reused process id is retained conservatively. */
export async function withProjectPolicyDirectory<T>(root: string, use: (directory: string) => Promise<T>): Promise<T> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const match = /^policy-([1-9][0-9]*)-/.exec(entry.name)
    if (!entry.isDirectory() || !match) continue
    try { process.kill(Number(match[1]), 0) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      await rm(join(root, entry.name), { recursive: true, force: true })
    }
  }
  const directory = await mkdtemp(join(root, `policy-${process.pid}-`))
  try { return await use(directory) }
  finally { await rm(directory, { recursive: true, force: true }) }
}
