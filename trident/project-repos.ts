import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Project-owned declaration; paths are relative to the project directory. */
export interface ProjectRepo {
  name: string
  path: string
  remote: string | null
}
export interface ProjectRepos {
  repos: ProjectRepo[]
  default: string | null
}

export const PROJECT_REPOS_FILE = 'project-repos.json'
const repoName = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/** Validate every read, including declarations edited outside the application. */
export function parseProjectRepos(raw: unknown): ProjectRepos {
  if (raw === null || typeof raw !== 'object' || !Array.isArray((raw as ProjectRepos).repos)) {
    throw new Error('Invalid project repo declaration: expected repos array')
  }
  const declaration = raw as ProjectRepos
  const names = new Set<string>()
  for (const repo of declaration.repos) {
    if (repo === null || typeof repo !== 'object' || typeof repo.name !== 'string' || !repoName.test(repo.name)) {
      throw new Error('Invalid project repo name')
    }
    if (names.has(repo.name)) throw new Error(`Duplicate project repo "${repo.name}"`)
    names.add(repo.name)
    if (repo.path !== `repos/${repo.name}` && repo.path !== 'code') {
      throw new Error(`Invalid path for repo "${repo.name}": use repos/${repo.name} or existing code`)
    }
    if (repo.remote !== null && (typeof repo.remote !== 'string' || repo.remote.trim() === '')) {
      throw new Error(`Invalid remote for repo "${repo.name}"`)
    }
  }
  if (new Set(declaration.repos.map(repo => repo.path)).size !== declaration.repos.length) {
    throw new Error('Project repos must have distinct paths')
  }
  if (declaration.repos.length === 0 ? declaration.default !== null :
      typeof declaration.default !== 'string' || !names.has(declaration.default)) {
    throw new Error(`Invalid default repo "${declaration.default}"`)
  }
  return declaration
}

/** Only a missing declaration uses the existing single-code workspace. */
export function readProjectRepos(projectDir: string, projectSlug: string): ProjectRepos {
  let source: string
  try {
    source = readFileSync(join(projectDir, PROJECT_REPOS_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return parseProjectRepos({ repos: [{ name: projectSlug, path: 'code', remote: null }], default: projectSlug })
  }
  return parseProjectRepos(JSON.parse(source))
}

export function resolveProjectRepo(declaration: ProjectRepos, requested?: string | null): ProjectRepo {
  const checked = parseProjectRepos(declaration)
  const name = requested ?? checked.default
  const repo = checked.repos.find(candidate => candidate.name === name)
  if (repo === undefined) throw new Error(`Project does not declare repo "${name ?? '(default)'}"`)
  return repo
}
