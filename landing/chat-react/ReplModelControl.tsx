import { useEffect, useMemo, useRef, useState } from 'react'
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
  // Each request supersedes older reads. In particular, a GET that started
  // before a confirmed POST must never paint over that POST's model.
  const requestGeneration = useRef(0)
  const refreshingRef = useRef(false)

  useEffect(() => {
    const generation = ++requestGeneration.current
    setState(null)
    setError(null)
    setSwitching(false)
    setRefreshing(false)
    refreshingRef.current = false
    void client.current(projectId).then(
      (next) => { if (generation === requestGeneration.current) setState(next) },
      (err: unknown) => { if (generation === requestGeneration.current) setError(err instanceof Error ? err.message : 'Could not load model') },
    )
    return () => { requestGeneration.current++ }
  }, [client, projectId])

  async function refresh(): Promise<void> {
    if (refreshingRef.current || switching) return
    const generation = ++requestGeneration.current
    refreshingRef.current = true
    setRefreshing(true)
    try {
      const next = await client.current(projectId)
      if (generation === requestGeneration.current) {
        setState(next)
        setError(null)
      }
    } catch (err) {
      if (generation === requestGeneration.current) setError(err instanceof Error ? err.message : 'Could not load model')
    } finally {
      if (generation === requestGeneration.current) {
        refreshingRef.current = false
        setRefreshing(false)
      }
    }
  }

  async function change(model: string): Promise<void> {
    if (state === null || state.status !== 'ready' || switching || refreshing || refreshingRef.current || model === state.currentModel) return
    if (!state.availableModels.some((option) => option.id === model)) return
    const generation = ++requestGeneration.current
    setSwitching(true)
    setError(null)
    try {
      const requestedSessionId = state.sessionId
      const next = await client.switch(projectId, model, requestedSessionId)
      if (generation !== requestGeneration.current) return
      if (next.sessionId !== requestedSessionId) {
        throw new Error('Session changed before the model switch was confirmed')
      }
      setState(next)
      if (next.currentModel !== model) setError(`Switch not confirmed; current model is ${next.currentModel ?? 'unknown'}.`)
    } catch (err) {
      if (generation !== requestGeneration.current) return
      setError(err instanceof Error ? err.message : 'Could not switch model')
      // A failed switch may be a stale session or busy state. Refresh the
      // authoritative reading, but retain the actionable error for the owner.
      try {
        const next = await client.current(projectId)
        if (generation === requestGeneration.current) setState(next)
      } catch { /* keep last known state */ }
    } finally {
      if (generation === requestGeneration.current) setSwitching(false)
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
        disabled={state === null || state.status !== 'ready' || switching || refreshing}
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
