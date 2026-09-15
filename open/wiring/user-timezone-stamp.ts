import { constants as fsConstants } from 'node:fs'
import { lstat, open, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

const TIMEZONE_LINE = /^- \*\*Timezone:\*\* .*$/m

/**
 * Reconcile the captured zone into an existing USER.md without regenerating
 * the owner's other persona facts. Missing files are left for persona-gen.
 */
export async function stampExistingUserTimezone(
  ownerHome: string,
  timezone: string,
): Promise<'written' | 'unchanged' | 'missing' | 'rejected'> {
  const personaDir = join(ownerHome, 'persona')
  const target = join(personaDir, 'USER.md')
  try {
    if ((await lstat(personaDir)).isSymbolicLink() || (await lstat(target)).isSymbolicLink()) {
      return 'rejected'
    }
  } catch {
    return 'missing'
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const current = await handle.readFile({ encoding: 'utf8' })
    const timezoneLine = `- **Timezone:** ${timezone}`
    const next = TIMEZONE_LINE.test(current)
      ? current.replace(TIMEZONE_LINE, timezoneLine)
      : `${current.trimEnd()}\n${timezoneLine}\n`
    if (next === current) return 'unchanged'

    const temp = join(personaDir, `.USER.md.timezone-${randomUUID()}`)
    try {
      await writeFile(temp, next, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      await rename(temp, target)
    } catch (err) {
      await unlink(temp).catch(() => undefined)
      throw err
    }
    return 'written'
  } catch {
    return 'rejected'
  } finally {
    await handle?.close().catch(() => undefined)
  }
}
