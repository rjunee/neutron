/** Synthetic nested launchers own these inputs; production measurement still
 * refuses them. Restore only this fixture's namespace, including absent keys. */
export function isolatePackageLauncherEnvironment(env: Record<string, string | undefined> = process.env): () => void {
  const owns = (name: string) => /^(BUN_|npm_|NPM_)/.test(name)
    || name.startsWith('NODE_') && name !== 'NODE_ENV'
    || ['NODE', 'SHELLOPTS', 'BASHOPTS', 'ENV'].includes(name)
  const saved = new Map(Object.entries(env).filter(([name]) => owns(name)))
  for (const name of saved.keys()) delete env[name]
  let restored = false
  return () => {
    if (restored) return
    restored = true
    for (const name of Object.keys(env)) if (owns(name)) delete env[name]
    for (const [name, value] of saved) env[name] = value
  }
}
