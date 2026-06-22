/**
 * landing/chat-react — the compose-side attachment draft.
 *
 * Holds the images the user has picked/dropped but not yet sent. Each item
 * uploads to the chat-attachment surface immediately (so the slow part — the
 * network — overlaps with the user typing a caption); once `ready` its server
 * URL is included on the next send. Mirrors the vanilla client's affordance
 * (file picker + drag-drop) but stages attachments so an image can ride along
 * with a text caption in a single message.
 *
 * The draft is owned at the Root so BOTH the composer UI (renders chips,
 * add/remove) AND the send path (`useNeutronChat.onNew`, which reads
 * `readUrls()` + `clear()`s after handing off to the controller) share one
 * instance. `readUrls` reads through a ref so a send fired from a stale render
 * closure still sees the latest ready set.
 */

import { useCallback, useRef, useState } from 'react'

import {
  AttachmentUploadError,
  uploadAttachment as defaultUpload,
  type UploadResult,
} from './uploads.ts'

export type StagedStatus = 'uploading' | 'ready' | 'error'

export interface StagedAttachment {
  /** Local id (not the server URL) — drives React keys + remove(). */
  id: string
  name: string
  /** The server URL once `ready`; null while uploading / on error. */
  url: string | null
  status: StagedStatus
  /** Human-readable failure reason when `status === 'error'`. */
  error?: string
}

export interface AttachmentDraft {
  items: StagedAttachment[]
  /** Begin uploading one or more picked/dropped files. */
  addFiles: (files: FileList | readonly File[]) => void
  /** Drop a staged item (cancels nothing in flight — the upload result is
   *  simply ignored once removed). */
  remove: (id: string) => void
  /** The server URLs of all `ready` items, in add order. Read at send time. */
  readUrls: () => string[]
  /**
   * Resolve once no item is still `uploading` (success OR failure settles each),
   * returning the ready URLs. The send path awaits this so a caption sent while
   * a larger image is still uploading doesn't silently drop the attachment.
   * Bounded by `timeoutMs` (default 30s) so a stuck upload can't wedge a send.
   */
  waitForUploads: (timeoutMs?: number) => Promise<string[]>
  /** Clear the whole draft after a successful send hand-off. */
  clear: () => void
  /** True while any item is still uploading. */
  uploading: boolean
  /** True when at least one item is `ready` to send. */
  hasReady: boolean
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

export interface UseAttachmentDraftOptions {
  token: string
  fetchImpl?: FetchImpl
  /** Injected in tests; defaults to the real {@link uploadAttachment}. */
  uploadImpl?: (file: File, opts: { token: string; fetchImpl?: FetchImpl }) => Promise<UploadResult>
}

let idCounter = 0
function nextId(): string {
  idCounter += 1
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID !== undefined) return c.randomUUID()
  return `att-${idCounter}`
}

export function useAttachmentDraft(opts: UseAttachmentDraftOptions): AttachmentDraft {
  const [items, setItems] = useState<StagedAttachment[]>([])
  // Mirror so readUrls() at send time never reads a stale snapshot.
  const itemsRef = useRef<StagedAttachment[]>([])
  itemsRef.current = items

  const upload = opts.uploadImpl ?? defaultUpload
  const { token, fetchImpl } = opts

  const patch = useCallback((id: string, next: Partial<StagedAttachment>): void => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...next } : it)))
  }, [])

  const addFiles = useCallback(
    (files: FileList | readonly File[]): void => {
      const list = Array.from(files)
      for (const file of list) {
        const id = nextId()
        setItems((prev) => [...prev, { id, name: file.name, url: null, status: 'uploading' }])
        const uploadOpts: { token: string; fetchImpl?: FetchImpl } = { token }
        if (fetchImpl !== undefined) uploadOpts.fetchImpl = fetchImpl
        void upload(file, uploadOpts)
          .then((res) => {
            patch(id, { url: res.url, status: 'ready' })
          })
          .catch((err: unknown) => {
            const message =
              err instanceof AttachmentUploadError
                ? err.message
                : err instanceof Error
                  ? err.message
                  : 'upload failed'
            patch(id, { status: 'error', error: message })
          })
      }
    },
    [token, fetchImpl, upload, patch],
  )

  const remove = useCallback((id: string): void => {
    setItems((prev) => prev.filter((it) => it.id !== id))
  }, [])

  const readUrls = useCallback((): string[] => {
    const out: string[] = []
    for (const it of itemsRef.current) {
      if (it.status === 'ready' && it.url !== null) out.push(it.url)
    }
    return out
  }, [])

  const waitForUploads = useCallback(
    async (timeoutMs = 30_000): Promise<string[]> => {
      const stepMs = 30
      let waited = 0
      while (itemsRef.current.some((it) => it.status === 'uploading') && waited < timeoutMs) {
        await new Promise((r) => setTimeout(r, stepMs))
        waited += stepMs
      }
      return readUrls()
    },
    [readUrls],
  )

  const clear = useCallback((): void => {
    setItems([])
  }, [])

  return {
    items,
    addFiles,
    remove,
    readUrls,
    waitForUploads,
    clear,
    uploading: items.some((it) => it.status === 'uploading'),
    hasReady: items.some((it) => it.status === 'ready'),
  }
}
