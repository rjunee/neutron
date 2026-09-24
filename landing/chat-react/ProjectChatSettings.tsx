import { useEffect, useRef, useState } from 'react'
import { CHAT_PROVIDER_CHOICES, chatProviderName, ProjectChatSettingsClient,
  type ProjectChatSettings as Settings, type ProjectCodexStatus } from '@neutronai/client-core/project-chat-settings.ts'
import type { FetchImpl } from '@neutronai/client-core'

/** Mounted with a project key: pending replies cannot become another project's state. */
export function ProjectChatSettings({ projectId, origin, token, fetchImpl, codexStatus }: {
  projectId: string; origin: string; token: string; fetchImpl?: FetchImpl; codexStatus: ProjectCodexStatus | null
}) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const mounted = useRef(false)
  const sequence = useRef(0)
  useEffect(() => {
    mounted.current = true
    const seq = ++sequence.current
    const client = new ProjectChatSettingsClient({ base_url: origin, token, ...(fetchImpl ? { fetchImpl } : {}) })
    void client.get(projectId).then(value => {
      if (mounted.current && sequence.current === seq) { setSettings(value); setError(null) }
    }).catch((err: unknown) => {
      if (mounted.current && sequence.current === seq) setError(err instanceof Error ? err.message : 'Could not load chat settings')
    })
    return () => { mounted.current = false; ++sequence.current }
  }, [projectId, origin, token, fetchImpl])

  async function select(value: string) {
    if (busy || !settings) return
    if (value !== 'inherit' && value !== 'anthropic' && value !== 'openai-codex') return
    setBusy(true); setError(null)
    const seq = ++sequence.current
    try {
      const saved = await new ProjectChatSettingsClient({ base_url: origin, token, ...(fetchImpl ? { fetchImpl } : {}) })
        .set(projectId, value === 'inherit' ? null : value)
      if (mounted.current && sequence.current === seq) setSettings(saved)
    } catch (err) {
      if (mounted.current && sequence.current === seq) setError(err instanceof Error ? err.message : 'Could not save chat settings')
    } finally { if (mounted.current && sequence.current === seq) setBusy(false) }
  }

  const credential = codexStatus?.owner_credential
  const selected = settings?.project.model_provider ?? 'inherit'
  return <section className="cset-section" aria-label="Project chat provider">
    <h2 className="cset-h">Chat provider</h2>
    <p className="cset-hint">Choose this project’s chat harness. A configured API chat route takes precedence. Switching providers does not transfer the other provider’s conversation context.</p>
    <label className="cset-label" htmlFor="project-chat-provider">Project chat provider</label>
    <select id="project-chat-provider" className="cset-input" value={selected}
      disabled={settings === null || busy} onChange={event => { void select(event.target.value) }}>
      {CHAT_PROVIDER_CHOICES.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
      {selected === 'openai' || selected === 'pi' ? <option value={selected}>{chatProviderName(selected)}</option> : null}
    </select>
    {settings ? <p className="cset-hint">Effective: {chatProviderName(settings.model_provider_resolution.provider)} · {settings.model_provider_resolution.source} setting</p> : null}
    {busy ? <p role="status">Saving…</p> : null}
    {error ? <p className="cset-error" role="alert">{error}</p> : null}
    <p className="cset-hint" role="status">{credential?.detail ?? 'Project Codex credential status is unavailable.'}</p>
    {credential ? <p className="cset-hint">Checked {new Date(credential.checked_at).toLocaleString()}</p> : null}
    {credential?.configured !== true ? <p className="cset-hint">Codex chat needs a subscription connected to this project below. An account-wide review connection is insufficient.</p> : null}
  </section>
}
