import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BootstrapConfig } from './config.ts'
import { PERSONA_FILENAMES, WebPersonalityClient, WebPersonalityClientError, type PersonaFilename } from './personality-client.ts'

interface FileState { content: string; draft: string; mtime: number; loading: boolean; saving: boolean; error: string | null; conflict: boolean; saved: boolean }
const emptyState = (): FileState => ({ content: '', draft: '', mtime: 0, loading: true, saving: false, error: null, conflict: false, saved: false })

export function PersonalityEditor({ config, fetchImpl }: { config: BootstrapConfig; fetchImpl?: (input: string, init?: RequestInit) => Promise<Response> }): React.JSX.Element {
  const [active, setActive] = useState<PersonaFilename>('SOUL.md')
  const [files, setFiles] = useState<Record<PersonaFilename, FileState>>(() => ({ 'SOUL.md': emptyState(), 'USER.md': emptyState(), 'priority-map.md': emptyState() }))
  const mounted = useRef(true)
  const client = useMemo(() => new WebPersonalityClient({ base_url: config.origin, token: config.token, ...(fetchImpl === undefined ? {} : { fetchImpl }) }), [config.origin, config.token, fetchImpl])
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const load = useCallback((filename: PersonaFilename): void => {
    setFiles((old) => ({ ...old, [filename]: { ...old[filename], loading: true, error: null, conflict: false } }))
    void client.getFile(filename).then((body) => {
      if (!mounted.current) return
      setFiles((old) => ({ ...old, [filename]: { ...old[filename], content: body.content, draft: body.content, mtime: body.mtime, loading: false, error: null, conflict: false, saved: false } }))
    }).catch((err: unknown) => {
      if (!mounted.current) return
      setFiles((old) => ({ ...old, [filename]: { ...old[filename], loading: false, error: err instanceof Error ? err.message : 'Could not load file.' } }))
    })
  }, [client])
  useEffect(() => { for (const filename of PERSONA_FILENAMES) load(filename) }, [load])
  const save = (force = false): void => {
    const filename = active; const snapshot = files[filename]
    setFiles((old) => ({ ...old, [filename]: { ...old[filename], saving: true, error: null, conflict: false, saved: false } }))
    void client.saveFile({ filename, content: snapshot.draft, expected_mtime: force ? -1 : snapshot.mtime }).then((result) => {
      if (!mounted.current) return
      setFiles((old) => ({ ...old, [filename]: { ...old[filename], content: snapshot.draft, draft: snapshot.draft, mtime: result.mtime, saving: false, error: null, conflict: false, saved: true } }))
    }).catch((err: unknown) => {
      if (!mounted.current) return
      const conflict = err instanceof WebPersonalityClientError && err.status === 409 && err.code === 'mtime_conflict'
      setFiles((old) => ({ ...old, [filename]: { ...old[filename], saving: false, error: conflict ? null : err instanceof Error ? err.message : 'Could not save file.', conflict } }))
    })
  }
  const file = files[active]
  return <section className="cset-section" aria-label="Personality">
    <h2 className="cset-h">Personality — every project on this computer</h2>
    <p className="cset-sub">Edit the three markdown files used to shape the agent. Changes apply on the next agent turn.</p>
    <div className="cset-inline" role="tablist" aria-label="Personality files">
      {PERSONA_FILENAMES.map((filename) => <button key={filename} type="button" role="tab" aria-selected={active === filename} className="cset-btn" onClick={() => setActive(filename)}>{filename}</button>)}
    </div>
    {file.loading ? <div className="cset-empty">Loading…</div> : <div className="cset-field">
      <label className="cset-label" htmlFor="cset-personality-editor">{active}</label>
      <textarea id="cset-personality-editor" className="cset-input cset-personality-editor" data-testid={`persona-editor-${active}`} rows={16} value={file.draft} onChange={(event) => setFiles((old) => ({ ...old, [active]: { ...old[active], draft: event.target.value, saved: false } }))} />
      {file.error !== null ? <p className="cset-error" role="alert">{file.error}</p> : null}
      {file.conflict ? <div className="cset-error" role="alert" data-testid="persona-conflict">This file changed since it was loaded.<div className="cset-form-actions"><button type="button" className="cset-btn" onClick={() => load(active)}>Reload server copy</button><button type="button" className="cset-btn cset-btn-danger" onClick={() => save(true)}>Overwrite anyway</button></div></div> : null}
      {file.saved ? <p className="cset-saved" role="status">Saved</p> : null}
      <div className="cset-form-actions"><button type="button" className="cset-btn cset-btn-primary" disabled={file.saving || file.draft === file.content} onClick={() => save()}>{file.saving ? 'Saving…' : 'Save'}</button></div>
    </div>}
  </section>
}
