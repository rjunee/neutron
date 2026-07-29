/**
 * C1 — BootConfig defaults-table test (the verbatim-fidelity proof).
 *
 * For EVERY var the schema owns, assert that its resolved default (env UNSET)
 * EQUALS the value the original scattered read site used. If any default here
 * drifts from the source read site, this table fails — that is the whole point:
 * the centralization must be behavior-preserving.
 *
 * The source read sites are cited inline next to each row.
 */

import { describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { resolveBootConfig } from '../index.ts'

describe('C1 BootConfig — defaults table (verbatim fidelity)', () => {
  // Resolve against a fully-empty bag so ONLY the defaults show through.
  const c = resolveBootConfig({})

  test('models — runtime/models.ts', () => {
    expect(c.models.best).toBe('claude-opus-4-8') // :53
    expect(c.models.fable).toBe('claude-fable-5') // :71
    expect(c.models.sonnet).toBe('claude-sonnet-4-6') // :89
    expect(c.models.fast).toBe('claude-haiku-4-5-20251001') // :96
  })

  test('claude bin — CLAUDE_BIN ?? "claude"', () => {
    expect(c.claudeBin).toBe('claude')
  })

  test('listener host/port — gateway', () => {
    expect(c.host).toBe('127.0.0.1') // gateway/index.ts:308
    expect(c.port).toBeUndefined() // unset → resolveListenPort default 7800 at seam
  })

  test('role — gateway/deployment-mode.ts default "open"', () => {
    expect(c.role).toBe('open')
    expect(c.hostedRelayMetered).toBe(false)
  })

  test('DB path — migrations/db-path.ts single-source precedence', () => {
    // NEUTRON_DB_PATH unset, NEUTRON_HOME unset → <~/neutron>/project.db.
    expect(c.dbPath).toBe(join(homedir(), 'neutron', 'project.db'))
    expect(c.neutronHome).toBe(join(homedir(), 'neutron'))
  })

  test('numeric knobs — verbatim defaults', () => {
    expect(c.maxUploadBytes).toBe(5 * 1024 * 1024 * 1024) // import-upload-handler.ts:79
    expect(c.maxSynthesisProjects).toBe(10) // synthesis-session.ts:70
    expect(c.overnightMaxConcurrent).toBe(2) // dispatcher.ts:57
    expect(c.overnightMaxPerWindow).toBe(8) // dispatcher.ts:58
    expect(c.replKeepaliveMs).toBe(10_000) // persistent-repl-substrate.ts
  })

  test('urls / domains — verbatim defaults', () => {
    expect(c.webAppBase).toBe('') // runtime/doc-links.ts:70 (NEUTRON_WEB_APP_BASE ?? '')
    expect(c.vaultRedirectorBase).toBe('https://vault.example.test') // :84
    expect(c.baseDomain).toBe('') // return-url-validator.ts:51
    expect(c.trustedHomeAuthority).toBe('') // member-join.ts:66
    expect(c.m2FeedbackPath).toBeUndefined() // collector keeps its own default
  })

  test('boolean flags — default false with exact per-site rules', () => {
    expect(c.replDebug).toBe(false) // === '1'
    expect(c.devAuth).toBe(false) // === '1'
    expect(c.skipGbrain).toBe(false) // '1' || 'true'
    expect(c.disableAmbientClaudeAuth).toBe(false)
  })

  test('optional passthrough — undefined when unset', () => {
    expect(c.instanceSlug).toBeUndefined()
    expect(c.ownerHome).toBeUndefined()
    expect(c.agentName).toBeUndefined()
    expect(c.graphComposerModule).toBeUndefined()
    expect(c.authJwksUrl).toBeUndefined()
    expect(c.nodeEnv).toBeUndefined()
    expect(c.tz).toBeUndefined()
    expect(c.secrets.anthropicApiKey).toBeUndefined()
    expect(c.secrets.openaiApiKey).toBeUndefined()
  })

  test('the resolved config is deeply frozen', () => {
    expect(Object.isFrozen(c)).toBe(true)
    expect(Object.isFrozen(c.models)).toBe(true)
    expect(Object.isFrozen(c.secrets)).toBe(true)
  })

  test('boolean truthiness rules match each source site exactly', () => {
    expect(resolveBootConfig({ NEUTRON_REPL_DEBUG: '1' }).replDebug).toBe(true)
    expect(resolveBootConfig({ NEUTRON_REPL_DEBUG: 'true' }).replDebug).toBe(false) // only '1'
    expect(resolveBootConfig({ NEUTRON_DEV_AUTH: '1' }).devAuth).toBe(true)
    expect(resolveBootConfig({ NEUTRON_DEV_AUTH: 'yes' }).devAuth).toBe(false) // only '1'
    expect(resolveBootConfig({ NEUTRON_SKIP_GBRAIN: 'true' }).skipGbrain).toBe(true)
    expect(resolveBootConfig({ NEUTRON_SKIP_GBRAIN: '1' }).skipGbrain).toBe(true)
    expect(resolveBootConfig({ NEUTRON_SKIP_GBRAIN: 'yes' }).skipGbrain).toBe(false)
    // ambient: any non-empty, non-'0', non-'false' string disables
    expect(
      resolveBootConfig({ NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH: '1' }).disableAmbientClaudeAuth,
    ).toBe(true)
    expect(
      resolveBootConfig({ NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH: 'anything' })
        .disableAmbientClaudeAuth,
    ).toBe(true)
    expect(
      resolveBootConfig({ NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH: '0' }).disableAmbientClaudeAuth,
    ).toBe(false)
    expect(
      resolveBootConfig({ NEUTRON_DISABLE_AMBIENT_CLAUDE_AUTH: 'false' }).disableAmbientClaudeAuth,
    ).toBe(false)
  })

  test('role normalization matches resolveDeploymentMode', () => {
    expect(resolveBootConfig({ NEUTRON_ROLE: 'managed' }).role).toBe('managed')
    expect(resolveBootConfig({ NEUTRON_ROLE: 'Connect ' }).role).toBe('connect') // trim+lower
    expect(resolveBootConfig({ NEUTRON_ROLE: 'bogus' }).role).toBe('open') // unknown → default
    // hosted-relay marker only meaningful when role=connect
    expect(
      resolveBootConfig({ NEUTRON_ROLE: 'connect', NEUTRON_CONNECT_METERED: '1' })
        .hostedRelayMetered,
    ).toBe(true)
    expect(
      resolveBootConfig({ NEUTRON_ROLE: 'open', NEUTRON_CONNECT_METERED: '1' }).hostedRelayMetered,
    ).toBe(false)
  })

  test('overrides flow through (env wins over default)', () => {
    const o = resolveBootConfig({
      NEUTRON_BEST_MODEL: 'x-model',
      NEUTRON_HOST: '0.0.0.0',
      NEUTRON_WEB_APP_BASE: 'https://app.example/',
      VAULT_REDIRECTOR_BASE: 'https://v.example',
    })
    expect(o.models.best).toBe('x-model')
    expect(o.host).toBe('0.0.0.0')
    expect(o.webAppBase).toBe('https://app.example/') // raw kept; read site strips at call time
    expect(o.vaultRedirectorBase).toBe('https://v.example')
  })
})
