/**
 * @neutronai/gateway/realmode-composer — Item 4 project-page indexer.
 *
 * Production `ProjectPageIndexFn` for the project materializer (spec
 * § 4.2d): writes the materialized project's canonical page through
 * `writeEntity(kind='project')` with the GBrain sync hook attached, so
 * the page lands at `<ownerDataDir>/entities/projects/<slug>.md` AND
 * auto-`put_page`s into the owner's GBrain store — the Item-1 live
 * agent's `memoryStore.query` then surfaces the project (docs +
 * transcript-summary digest) in chat recall.
 *
 * Mirrors the import entity-populator wiring exactly
 * (`build-import-job-runner.ts`): same `writeEntity` default, same
 * optional `syncHook`, same own-origin attribution (the project page is
 * the owner's own content, so originInstance === receivingInstanceSlug
 * passes the M2.6 quarantine guard).
 *
 * Failure contract: throw freely — the materializer catches, logs, and
 * continues (the on-disk project repo stands regardless; index drift is
 * repairable by the next overnight re-fire only for not-yet-materialized
 * projects, so failures here are logged loudly by the caller).
 */

import { writeEntity as defaultWriteEntity, type SyncHook } from '@neutronai/runtime/entity-writer.ts'
import { entitySlugify } from '@neutronai/runtime/entity-slug.ts'
import type { ProjectPageIndexFn } from '@neutronai/onboarding/wow-moment/project-materializer.ts'

/** Minimal writeEntity surface (test seam — mirrors entity-populator's). */
export type ProjectPageWriteEntityFn = typeof defaultWriteEntity

export interface BuildProjectPageIndexerInput {
  /** Absolute path to the instance's Zone-B data dir (entities/ root). */
  ownerDataDir: string
  /** Frozen internal handle — origin + receiving instance for the guard. */
  project_slug: string
  /** Test seam. Defaults to the real `runtime/entity-writer.ts` writer. */
  writeEntity?: ProjectPageWriteEntityFn
  /** GBrain sync hook — when present, each changed page put_pages into
   *  the owner's memory store. Omit on instances without GBrain wired. */
  syncHook?: SyncHook
  now?: () => number
}

export function buildProjectPageIndexer(
  input: BuildProjectPageIndexerInput,
): ProjectPageIndexFn {
  const writeEntity = input.writeEntity ?? defaultWriteEntity
  const now = input.now ?? ((): number => Date.now())
  return async (page): Promise<void> => {
    // Entity slugs are stricter than project ids (`^[a-z0-9][a-z0-9-]*$`
    // vs slugifyProjectId's `[a-z0-9._-]`); normalize through the same
    // slugifier the import populator uses so e.g. "v2.0_beta" → "v2-0-beta".
    const slug = entitySlugify(page.project_slug) ?? entitySlugify(page.name)
    if (slug === null) {
      throw new Error(
        `project-page-indexer: project "${page.project_slug}" yields no valid entity slug`,
      )
    }
    const ts = new Date(now()).toISOString()
    await writeEntity(
      {
        ownerDataDir: input.ownerDataDir,
        kind: 'project',
        slug,
        body: {
          frontmatter: {
            slug,
            type: 'project',
            name: page.name,
            source: 'project-materializer',
            project_dir: page.source_path,
          },
          compiledTruth: page.body,
          timelineAppend: {
            ts,
            source: `neutron://${page.source_path}`,
            body: 'Project materialized on disk during onboarding wow-moment (Item 4)',
          },
        },
        originInstance: input.project_slug,
        receivingInstanceSlug: input.project_slug,
      },
      input.syncHook !== undefined ? { syncHook: input.syncHook } : {},
    )
  }
}
