/**
 * @neutronai/channels — files in an agent reply bound for Telegram.
 *
 * The agent's `reply` tool carries text only. To send a file back to a Telegram
 * chat, the agent puts each file on its own line of the reply as
 *
 *     [[file: /absolute/path/to/file.pdf]]
 *
 * and the Telegram receiver lifts those lines out, posts the remaining text, then
 * posts each file: images as photos, mp4/mov as videos, everything else as a
 * document. Two or more photos and videos in one reply go out as one album.
 *
 * The convention is Telegram-side only; it changes nothing about the reply tool or
 * any other channel. Pure functions here, so the parsing and the grouping are
 * testable without a bot.
 */

import { basename, extname, isAbsolute } from 'node:path'

/** At most this many files are taken from one reply. */
export const MAX_REPLY_FILES = 10
/** Bot API upload limit for bots (50 MB). */
export const TELEGRAM_UPLOAD_MAX_BYTES = 50 * 1024 * 1024
/** Bot API text limit per message, in UTF-16 code units. */
export const TELEGRAM_TEXT_MAX = 4096

const FILE_LINE = /^\s*\[\[file:\s*(.+?)\s*\]\]\s*$/

export interface ReplyWithFiles {
  /** The reply with every `[[file: …]]` line removed and surrounding blank runs collapsed. */
  text: string
  /** Absolute paths in reply order, de-duplicated, capped at {@link MAX_REPLY_FILES}. */
  files: string[]
  /** Directives that were not usable (relative path, over the cap). */
  rejected: string[]
}

export function extractReplyFiles(reply: string): ReplyWithFiles {
  const kept: string[] = []
  const files: string[] = []
  const rejected: string[] = []
  for (const line of reply.split('\n')) {
    const m = FILE_LINE.exec(line)
    if (m === null) {
      kept.push(line)
      continue
    }
    const path = (m[1] ?? '').trim()
    if (!isAbsolute(path)) {
      rejected.push(path)
      continue
    }
    if (files.includes(path)) continue
    if (files.length >= MAX_REPLY_FILES) {
      rejected.push(path)
      continue
    }
    files.push(path)
  }
  const text = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return { text, files, rejected }
}

export type TelegramFileKind = 'photo' | 'video' | 'document'

const PHOTO_EXT: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }
const VIDEO_EXT: Record<string, string> = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/mp4' }
const DOC_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.gif': 'image/gif',
  '.zip': 'application/zip',
}

/** How a file is posted, and the content type it is uploaded with. */
export function classifyReplyFile(path: string): { kind: TelegramFileKind; content_type: string; filename: string } {
  const ext = extname(path).toLowerCase()
  const filename = basename(path)
  const photo = PHOTO_EXT[ext]
  if (photo !== undefined) return { kind: 'photo', content_type: photo, filename }
  const video = VIDEO_EXT[ext]
  if (video !== undefined) return { kind: 'video', content_type: video, filename }
  return { kind: 'document', content_type: DOC_EXT[ext] ?? 'application/octet-stream', filename }
}

/**
 * Group files for posting, keeping reply order. Consecutive photos and videos
 * become one album when there are two or more of them; documents and lone media
 * are posted one by one.
 */
export function planReplyUploads<T extends { kind: TelegramFileKind }>(files: readonly T[]): Array<{ album: T[] } | { single: T }> {
  const plan: Array<{ album: T[] } | { single: T }> = []
  let run: T[] = []
  const flush = (): void => {
    if (run.length >= 2) plan.push({ album: run })
    else if (run.length === 1) plan.push({ single: run[0] as T })
    run = []
  }
  for (const f of files) {
    if (f.kind === 'document') {
      flush()
      plan.push({ single: f })
    } else {
      run.push(f)
      if (run.length === MAX_REPLY_FILES) flush()
    }
  }
  flush()
  return plan
}

/**
 * Split text into Telegram-sized messages, preferring paragraph, then line, then
 * word boundaries. Lengths are UTF-16 code units, which is what Telegram counts.
 */
export function chunkTelegramText(text: string, max: number = TELEGRAM_TEXT_MAX): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max)
    if (cut < max / 2) cut = rest.lastIndexOf('\n', max)
    if (cut < max / 2) cut = rest.lastIndexOf(' ', max)
    if (cut <= 0) cut = max
    // Never split a surrogate pair.
    const code = rest.charCodeAt(cut - 1)
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1
    out.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).replace(/^\s+/, '')
  }
  if (rest.length > 0) out.push(rest)
  return out
}
