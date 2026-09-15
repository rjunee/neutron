import { mkdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { GENERAL_RAIL_ID } from '@neutronai/wire-types/topic-id.ts'

const LEGACY_GENERAL_ID = 'general'
const DOC_COMPONENTS = ['docs', '.docs-versions', '.docs-blobs', '.comments'] as const

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/**
 * Move General's pre-reserved docs state to its collision-proof scope directory.
 * Each component rename is atomic and the operation is restart-safe. If both
 * locations contain one component, boot refuses instead of choosing data to lose.
 */
export async function migrateGeneralDocsScope(owner_home: string): Promise<void> {
  const projects = join(owner_home, 'Projects')
  const sourceRoot = join(projects, LEGACY_GENERAL_ID)
  const targetRoot = join(projects, GENERAL_RAIL_ID)

  for (const component of DOC_COMPONENTS) {
    const source = join(sourceRoot, component)
    if (!(await exists(source))) continue
    const target = join(targetRoot, component)
    if (await exists(target)) {
      throw new Error(`general docs scope migration refused: both locations contain ${component}`)
    }
    await mkdir(targetRoot, { recursive: true })
    await rename(source, target)
  }
}
