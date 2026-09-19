import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { CodexOwnerBindingFacts } from './project-control-bootstrap.ts'

export type Rpc = Record<string, unknown>
export const object = (value: unknown): value is Rpc => typeof value === 'object' && value !== null && !Array.isArray(value)
export interface HelperIdentity { pid: number; boot: string; start: string }
export interface OwnerHelperDescriptor {
  version: 1
  socketPath: string
  socketIdentity: string
  token: string
  helper: HelperIdentity
  facts: CodexOwnerBindingFacts
}
export function helperIdentity(pid = process.pid): HelperIdentity {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  if (!boot || !fields[19] || !/^\d+$/.test(fields[19]) || ['Z', 'X'].includes(fields[0]!)) throw new Error('Owner helper identity unknown')
  return { pid, boot, start: fields[19] }
}
export function assertSeparateOwnerCgroup(owner: string, gateway: string): void {
  const ownerPath = /^0::(\/[^\n]*)\n?$/.exec(owner)?.[1]
  const gatewayPath = /^0::(\/[^\n]*)\n?$/.exec(gateway)?.[1]
  if (!ownerPath || !gatewayPath || gatewayPath === '/' || ownerPath === gatewayPath || ownerPath.startsWith(`${gatewayPath}/`)) {
    throw new Error('Owner helper must be outside the gateway service cgroup')
  }
}
export function requireIndependentOwnerHost(gateway: HelperIdentity): void {
  if (!gateway || !Number.isSafeInteger(gateway.pid) || gateway.pid <= 0
    || !isDeepStrictEqual(helperIdentity(gateway.pid), gateway)) throw new Error('Gateway launch identity unknown')
  assertSeparateOwnerCgroup(readFileSync('/proc/self/cgroup', 'utf8'), readFileSync(`/proc/${gateway.pid}/cgroup`, 'utf8'))
  if (!isDeepStrictEqual(helperIdentity(gateway.pid), gateway)) throw new Error('Gateway launch identity changed')
}
export function privatePath(path: string, kind: 'file' | 'socket' | 'directory'): void {
  if (!isAbsolute(path) || realpathSync(kind === 'directory' ? path : dirname(path)) !== (kind === 'directory' ? path : dirname(path))) throw new Error('Canonical owner helper path required')
  const info = lstatSync(path)
  if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0
    || !(kind === 'file' ? info.isFile() : kind === 'socket' ? info.isSocket() : info.isDirectory())) throw new Error('Private owned helper path required')
}
export function assertProjectOwner(codexHome: string, projectId: string): void {
  privatePath(codexHome, 'directory')
  const marker = join(codexHome, 'project-owner.json')
  const info = lstatSync(marker)
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(projectId) || !info.isFile() || info.uid !== process.getuid?.()
    || JSON.parse(readFileSync(marker, 'utf8')) !== projectId) throw new Error('Owner helper credential home belongs to another project')
}
export function socketIdentity(path: string): string {
  privatePath(path, 'socket')
  const info = lstatSync(path)
  return `${info.dev}:${info.ino}`
}
export function exactFacts(actual: unknown, expected: CodexOwnerBindingFacts): void {
  if (!isDeepStrictEqual(actual, expected)) throw new Error('Owner helper binding mismatch')
}
/** Disk supplies a locator, never authority by itself; attachment authenticates it. */
export function readOwnerHelperDescriptor(path: string): OwnerHelperDescriptor {
  privatePath(dirname(path), 'directory'); privatePath(path, 'file')
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!object(value) || value.version !== 1 || typeof value.socketPath !== 'string'
    || typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token)
    || !object(value.helper) || !Number.isSafeInteger(value.helper.pid) || Number(value.helper.pid) <= 0
    || !object(value.facts)) throw new Error('Invalid owner helper descriptor')
  const descriptor = value as unknown as OwnerHelperDescriptor
  if (socketIdentity(descriptor.socketPath) !== descriptor.socketIdentity
    || !isDeepStrictEqual(helperIdentity(descriptor.helper.pid), descriptor.helper)) throw new Error('Stale owner helper descriptor')
  return descriptor
}
