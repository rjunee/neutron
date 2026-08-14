import { spawnSync } from 'node:child_process'

const supportByBinary = new Map<string, boolean>()

/** Probe the configured CLI rather than assuming a version supports this option. */
export function supportsAutocompact(claudeBin: string): boolean {
  const cached = supportByBinary.get(claudeBin)
  if (cached !== undefined) return cached

  const result = spawnSync(claudeBin, ['--help'], {
    encoding: 'utf8',
    timeout: 5000,
  })
  const supported = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.includes('--autocompact')
  supportByBinary.set(claudeBin, supported)
  return supported
}
