import { createHash, randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, normalize } from 'node:path'
import type { CodexResultTransport } from '@neutronai/runtime/workers/codex-in-repl.ts'
import { decodeProjectTrailer, type ProjectTrailerDecoder } from '@neutronai/runtime/workers/project-runners.ts'

interface ResultTransport {
  projectId: string
  projectDir: string
  stateDir: string
  runId: string
  trailer: ProjectTrailerDecoder
}

function childDirectory(parent: number, name: string, create = false): number {
  const path = `/proc/self/fd/${parent}/${name}`
  if (create) {
    try { mkdirSync(path, { mode: 0o700 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  }
  return openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
}

// Open each path component relative to an already-pinned directory. A symlink
// at ANY ancestor refuses; lstat-then-open would leave a substitution window.
function directory(path: string): number {
  if (!isAbsolute(path) || normalize(path) !== path) throw new Error('Result directory must be canonical and absolute')
  let fd = openSync('/', constants.O_RDONLY | constants.O_DIRECTORY)
  try {
    for (const part of path.split('/').filter(Boolean)) {
      const next = childDirectory(fd, part)
      closeSync(fd); fd = next
    }
    return fd
  } catch (error) { closeSync(fd); throw error }
}

/** Linux host-owned transfer, not an additional native write grant. Canonical
 * reservation journals stay outside the sandbox; only the exact child result
 * slot lives inside the project. Call INSIDE guardBuildRunner so publication
 * uncertainty retains the same owner work fence as native/decoder uncertainty. */
export function codexBuildResultTransport(options: ResultTransport): CodexResultTransport {
  return { prepare: async (input, signal, disposition) => {
    const request = structuredClone(input)
    const fail = (): never => { throw new Error('Codex result transport could not establish an exact validated host artifact.') }
    if (signal.aborted || request.budget.wall_ms <= 0) return fail()
    const descriptors: number[] = []
    try {
      if (request.run_id !== options.runId) return fail()
      let reviewDirectory: string | undefined
      let destinationName = `${request.role}.result`
      if (request.result.schema === 'verdict' && (request.role === 'review' || request.role === 'synthesis')) {
        // ProjectReviewSource mints the directory and encodes it in the host
        // step identity. Native work cannot create owner-home evidence folders.
        const identity = /^(review-[A-Za-z0-9]{6}):[1-9][0-9]*:[0-9]+$/.exec(request.step_id)
        if (!identity || request.brief.path !== join(options.stateDir, identity[1]!, 'brief.json')) return fail()
        reviewDirectory = identity[1]!
        destinationName = 'result.json'
      } else if (!['plan', 'build', 'fix', 'review'].includes(request.role)) return fail()
      if (request.result.path !== join(options.stateDir, reviewDirectory ?? '', destinationName)) return fail()
      const stateFd = directory(options.stateDir); descriptors.push(stateFd)
      const destinationFd = reviewDirectory ? childDirectory(stateFd, reviewDirectory) : stateFd
      if (reviewDirectory) descriptors.push(destinationFd)
      const projectFd = directory(options.projectDir); descriptors.push(projectFd)
      const key = createHash('sha256').update(JSON.stringify([options.projectId, request.run_id, request.step_id])).digest('hex')
      let stage = options.projectDir
      for (const component of ['.neutron', 'build-results', key]) {
        stage = join(stage, component)
        descriptors.push(childDirectory(descriptors.at(-1)!, component, disposition === 'dispatch'))
      }
      const stageFd = descriptors.at(-1)!
      const stageStat = fstatSync(stageFd)
      const state = `/proc/self/fd/${stateFd}`
      const destination = `/proc/self/fd/${destinationFd}`
      const source = `/proc/self/fd/${stageFd}/result.json`
      // Bind the original host request to this exact staging inode. A substituted
      // directory, foreign request or lost manifest write never authorizes replay.
      const identity = JSON.stringify({ request, stage, dev: stageStat.dev, ino: stageStat.ino })
      const manifest = join(state, `codex-result-${key}.json`)
      if (disposition === 'dispatch') {
        const temporary = join(state, `.codex-manifest-${randomBytes(12).toString('hex')}.tmp`)
        const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        try {
          try { writeFileSync(fd, identity); fsyncSync(fd) }
          finally { closeSync(fd) }
          try { linkSync(temporary, manifest) }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
          fsyncSync(stateFd)
        } finally { unlinkSync(temporary) }
      }
      const manifestFd = openSync(manifest, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try { if (!fstatSync(manifestFd).isFile() || readFileSync(manifestFd, 'utf8') !== identity) return fail() }
      finally { closeSync(manifestFd) }
      let closed = false
      return { resultPath: join(stage, 'result.json'), close() {
        if (closed) return
        closed = true
        for (const fd of descriptors.reverse()) closeSync(fd)
      }, async clearForDispatch() {
        if (signal.aborted || closed) return fail()
        try { unlinkSync(source); fsyncSync(stageFd) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }, async publish() {
        if (signal.aborted || closed) return fail()
        const currentStage = directory(stage)
        try {
          const current = fstatSync(currentStage)
          if (current.ino !== stageStat.ino || current.dev !== stageStat.dev) return fail()
        } finally { closeSync(currentStage) }
        let sourceFd: number
        try { sourceFd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
        let bytes: Buffer
        try {
          if (!fstatSync(sourceFd).isFile()) return fail()
          bytes = readFileSync(sourceFd)
        } finally { closeSync(sourceFd) }
        const decoded = decodeProjectTrailer(new TextDecoder('utf-8', { fatal: true }).decode(bytes), request, options.trailer)
        if (decoded.kind !== 'completed' && decoded.kind !== 'blocked') return fail()
        const temporary = join(destination, `.codex-result-${randomBytes(12).toString('hex')}.tmp`)
        const temporaryFd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        try { writeFileSync(temporaryFd, bytes); fsyncSync(temporaryFd) }
        finally { closeSync(temporaryFd) }
        try {
          renameSync(temporary, join(destination, destinationName))
          fsyncSync(destinationFd)
        } finally { try { unlinkSync(temporary) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } }
        return true
      } }
    } catch (error) {
      for (const fd of descriptors.reverse()) closeSync(fd)
      throw error
    }
  } }
}
