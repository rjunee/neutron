import { useEffect, useMemo, useState } from 'react'
import { WebReplModelClient, type ReplModelState } from './repl-model-client.ts'

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

/** The shell keys this control by scope, so a late response cannot cross conversations. */
export function ReplModelControl({ projectId, origin, token, fetchImpl }: {
  projectId: string | null
  origin: string
  token: string
  fetchImpl?: FetchImpl
}): React.JSX.Element {
  const client = useMemo(() => new WebReplModelClient({
    base_url: origin, token, ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  }), [origin, token, fetchImpl])
  const [state, setState] = useState<ReplModelState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [switching, setSwitching] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    let live = true
    setState(null)
    setError(null)
    void client.current(projectId).then(
      (next) => { if (live) setState(next) },
      (err: unknown) => { if (live) setError(err instanceof Error ? err.message : 'Could not load model') },
    )
    return () => { live = false }
  }, [client, projectId])

  async function refresh(): Promise<void> {
    if (refreshing || switching) return
    setRefreshing(true)
    try {
      setState(await client.current(projectId))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load model')
    } finally {
      setRefreshing(false)
    }
  }

  async function change(model: string): Promise<void> {
    if (state === null || state.status !== 'ready' || switching || model === state.currentModel) return
    if (!state.availableModels.some((option) => option.id === model)) return
    setSwitching(true)
    setError(null)
    try {
      const requestedSessionId = state.sessionId
      const next = await client.switch(projectId, model, requestedSessionId)
      if (next.sessionId !== requestedSessionId) {
        throw new Error('Session changed before the model switch was confirmed')
      }
      setState(next)
      if (next.currentModel !== model) setError(`Switch not confirmed; current model is ${next.currentModel ?? 'unknown'}.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not switch model')
      // A failed switch may be a stale session or busy state. Refresh the
      // authoritative reading, but retain the actionable error for the owner.
      try { setState(await client.current(projectId)) } catch { /* keep last known state */ }
    } finally {
      setSwitching(false)
    }
  }

  const current = state?.currentModel ?? ''
  const currentListed = state?.availableModels.some((option) => option.id === current) ?? false
  return (
    <div aria-label="Conversation model" style={{ alignSelf: 'center', display: 'flex', flexDirection: 'column', minWidth: 120, maxWidth: 220 }}>
      <label style={{ color: 'var(--fg-muted)', fontSize: '0.72rem' }} htmlFor="car-repl-model">Model</label>
      <select
        id="car-repl-model"
        aria-label="Conversation model"
        value={current}
        disabled={state === null || state.status !== 'ready' || switching}
        onChange={(event) => { void change(event.target.value) }}
        style={{ maxWidth: '100%', background: 'var(--surface)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 6 }}
      >
        {!currentListed && <option value={current}>{current || (state === null ? error === null ? 'Loading…' : 'Unavailable' : 'Unknown model')}</option>}
        {state?.availableModels.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
      {switching && <span role="status">Switching model…</span>}
      {!switching && state?.status !== 'ready' && state !== null && <span role="status">{state.detail ?? `Model switch ${state.status}`}</span>}
      {error && <span role="alert" style={{ color: 'var(--danger, #b33)', fontSize: '0.72rem' }}>{error}</span>}
      {(error !== null || (state !== null && state.status !== 'ready')) && (
        <button type="button" disabled={refreshing || switching} onClick={() => { void refresh() }}>
          {refreshing ? 'Refreshing…' : 'Refresh model'}
        </button>
      )}
    </div>
  )
}
