/**
 * @neutronai/work-board — spec-doc service (M1 play-button + on-disk spec).
 *
 * The ONE place that couples the pure {@link ./spec-doc.ts} policy to real I/O:
 * the `DocStore` (writes/reads the markdown under `Projects/<id>/docs/plans/`)
 * and the `WorkBoardStore` (owns the card row + its `design_doc_ref`). Both the
 * agent `work_board_add` tool and the HTTP create route go through
 * `createCardWithOptionalSpec`, and both the ▶ start route and the
 * `work_board_start` agent tool go through `resolveTaskForItem`, so there is a
 * single doc-write path and a single spec-read path (no dual code paths).
 *
 * Layering: depends on STRUCTURAL slices of `DocStore` (`writeDoc`/`readDoc`)
 * and `WorkBoardStore` (`create`/`update`) so it stays unit-testable with stubs
 * and never widens the work-board package's dependency surface.
 */

import { createLogger } from '@neutronai/logger'
import {
  buildSpecDocMarkdown,
  designDocRefForPath,
  docPathFromDesignRef,
  shouldPersistSpecDoc,
  specDocRelPath,
  specDocSlug,
} from './spec-doc.ts'
import type {
  CreateWorkBoardItemInput,
  WorkBoardItem,
  WorkBoardItemUpdate,
} from './store.ts'

/** The `DocStore` slice the service needs (write + read a project markdown doc). */
export interface SpecDocStore {
  writeDoc(input: {
    project_id: string
    path: string
    content: string
  }): Promise<unknown>
  readDoc(project_id: string, path: string): Promise<{ content: string }>
}

/** The `WorkBoardStore` slice the service needs. */
export interface SpecDocBoardStore {
  create(project_slug: string, input: CreateWorkBoardItemInput): Promise<WorkBoardItem>
  update(
    project_slug: string,
    id: string,
    patch: WorkBoardItemUpdate,
  ): Promise<WorkBoardItem | null>
}

export interface CreateCardWithSpecInput {
  title: string
  status?: WorkBoardItem['status']
  /** An explicit design-doc pointer the caller already has (agent-supplied
   *  link). When present it WINS — we never overwrite it with a generated doc. */
  design_doc_ref?: string | null
  /** The full context/ask. When substantial (see `shouldPersistSpecDoc`) it is
   *  persisted to a spec doc and the card's `design_doc_ref` is set to point at
   *  it. A short one-liner (or absent) spec leaves the card title-only. */
  spec?: string | null
}

export interface SpecDocLog {
  warn(message: string): void
}

const specDocLog = createLogger('work-board-spec-doc')

export class WorkBoardSpecDocService {
  private readonly docs: SpecDocStore
  private readonly board: SpecDocBoardStore
  private readonly log: SpecDocLog
  private readonly ensureDocsDir: ((project_slug: string) => Promise<void>) | null

  constructor(deps: {
    docs: SpecDocStore
    board: SpecDocBoardStore
    log?: SpecDocLog
    /**
     * Ensure the project's `docs/` root exists before a spec doc is written.
     * The `DocStore` write path realpath-confines every write UNDER `docs/` and
     * REJECTS a write when that root doesn't exist yet (its closest existing
     * ancestor resolves above the root). Most projects are materialized with a
     * `docs/` dir, but the owner's default board scope (and any not-yet-
     * materialized project) may lack one — without this the spec-doc write would
     * silently degrade to a title-only card. The composer wires this to a
     * recursive mkdir of `<owner_home>/Projects/<slug>/docs`.
     */
    ensureDocsDir?: (project_slug: string) => Promise<void>
  }) {
    this.docs = deps.docs
    this.board = deps.board
    this.log = deps.log ?? { warn: (m) => specDocLog.warn(m) }
    this.ensureDocsDir = deps.ensureDocsDir ?? null
  }

  /**
   * Create a Plan card, persisting a spec doc when the ask is non-trivial.
   * An explicit `design_doc_ref` short-circuits doc generation. A doc-write
   * failure degrades gracefully — the card is still created (title-only) — so a
   * transient FS error never blocks adding work to the board.
   */
  async createCardWithOptionalSpec(
    project_slug: string,
    input: CreateCardWithSpecInput,
  ): Promise<WorkBoardItem> {
    const explicit =
      typeof input.design_doc_ref === 'string' && input.design_doc_ref.trim().length > 0
        ? input.design_doc_ref.trim()
        : null

    const item = await this.board.create(project_slug, {
      title: input.title,
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(explicit !== null ? { design_doc_ref: explicit } : {}),
    })

    // Explicit ref wins; trivial asks stay title-only.
    if (explicit !== null) return item
    if (!shouldPersistSpecDoc(input.spec, input.title)) return item

    const spec = (input.spec ?? '').trim()
    const relPath = specDocRelPath(specDocSlug(item.title, item.id.slice(-6)))
    try {
      if (this.ensureDocsDir !== null) await this.ensureDocsDir(project_slug)
      await this.docs.writeDoc({
        project_id: project_slug,
        path: relPath,
        content: buildSpecDocMarkdown({
          title: item.title,
          spec,
          created_at: item.created_at,
        }),
      })
    } catch (err) {
      this.log.warn(
        `[work-board] event=spec_doc_write_failed project=${project_slug} item=${item.id} err=${errText(err)}`,
      )
      return item
    }

    try {
      const updated = await this.board.update(project_slug, item.id, {
        design_doc_ref: designDocRefForPath(relPath),
      })
      return updated ?? item
    } catch (err) {
      // Doc is on disk but the ref didn't land — the card is usable (title) and
      // the doc is visible in Documents; log so the drift is observable.
      this.log.warn(
        `[work-board] event=spec_doc_ref_update_failed project=${project_slug} item=${item.id} err=${errText(err)}`,
      )
      return item
    }
  }

  /**
   * Resolve the build spec for a card: the content of its `design_doc_ref` doc
   * when the ref points at an in-app doc that reads cleanly, else the card
   * title. This is what ▶ start (and the planning stage) feed to the trident
   * run as its `task`, so the on-disk doc is the canonical spec input — one
   * source of truth, surviving session resets.
   */
  async resolveTaskForItem(
    project_slug: string,
    item: { title: string; design_doc_ref: string | null },
  ): Promise<string> {
    const path = docPathFromDesignRef(item.design_doc_ref)
    if (path !== null) {
      try {
        const doc = await this.docs.readDoc(project_slug, path)
        const content = doc.content.trim()
        if (content.length > 0) return content
      } catch (err) {
        this.log.warn(
          `[work-board] event=spec_doc_read_failed project=${project_slug} path=${path} err=${errText(err)}`,
        )
      }
    }
    return item.title
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
