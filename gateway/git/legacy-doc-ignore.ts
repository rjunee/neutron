import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Exact retired initializer bytes, solely for identifying its generated block. */
export const LEGACY_DOC_VERSION_GITIGNORE = `# P7.4 — commit markdown only. Binary handling lands in P7.5 (git-LFS).
# Until then every binary extension is hard-ignored so a \`git add .\` can
# never inflate the .docs-versions/objects/ tree with a 50 MB PDF.

# Images
*.png
*.jpg
*.jpeg
*.gif
*.webp
*.svg
*.bmp
*.tiff
*.heic
*.ico

# Audio / video
*.mp3
*.m4a
*.wav
*.flac
*.ogg
*.mp4
*.mov
*.avi
*.webm
*.mkv

# Documents (non-markdown)
*.pdf
*.doc
*.docx
*.xls
*.xlsx
*.ppt
*.pptx
*.odt
*.ods
*.odp

# Archives
*.zip
*.tar
*.tar.gz
*.tgz
*.rar
*.7z

# Bin / temp
*.bin
*.exe
*.dll
*.so
*.dylib
*.tmp
.DS_Store
Thumbs.db
`


/** Retire only the known generated block, retaining every owner-added byte. */
export async function reconcileLegacyDocIgnore(root: string): Promise<void> {
  const path = join(root, 'docs', '.gitignore')
  let original: Buffer
  try {
    if (!(await lstat(path)).isFile()) throw new Error('Legacy docs ignore must be a regular file')
    original = await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const generated = Buffer.from(LEGACY_DOC_VERSION_GITIGNORE, 'utf8')
  const start = original.indexOf(generated)
  if (start < 0 || (start > 0 && original[start - 1] !== 10)) return
  const remaining = Buffer.concat([original.subarray(0, start), original.subarray(start + generated.length)])
  const hash = createHash('sha256').update(original).digest('hex')
  const archive = join(root, '.docs-versions', `vault-migration-ignore-${hash}.txt`)
  try {
    await writeFile(archive, original, { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (!(await readFile(archive)).equals(original)) throw new Error('Legacy ignore archive differs')
  }
  if (!(await readFile(path)).equals(original)) throw new Error('Legacy docs ignore changed during migration')
  const temporary = join(root, '.docs-versions', `vault-migration-ignore-${randomUUID()}.tmp`)
  await writeFile(temporary, remaining, { flag: 'wx' })
  await rename(temporary, path)
}
