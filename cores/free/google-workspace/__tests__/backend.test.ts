import { describe, expect, test } from 'bun:test'

import {
  DocNotFoundError,
  DriveFileNotFoundError,
  GoogleWorkspaceApiError,
  OAuthMissingError,
  buildGoogleWorkspaceClient,
  buildInMemoryGoogleWorkspaceClient,
  flattenDocBody,
  parseA1Range,
  type FetchLike,
} from '../src/backend.ts'

// ---------------------------------------------------------------------------
// Mocked-fetch harness for the production REST client
// ---------------------------------------------------------------------------

interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body: string | undefined
}

function mockFetch(
  handler: (call: RecordedCall) => { status?: number; json?: unknown; text?: string },
): { fetchImpl: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const fetchImpl: FetchLike = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString()
    const headers: Record<string, string> = {}
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>
    for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = String(v)
    const call: RecordedCall = {
      url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    }
    calls.push(call)
    const out = handler(call)
    const status = out.status ?? 200
    const ok = status >= 200 && status < 300
    return {
      ok,
      status,
      json: async () => out.json ?? {},
      text: async () => out.text ?? (out.json !== undefined ? JSON.stringify(out.json) : ''),
    } as unknown as Response
  }
  return { fetchImpl, calls }
}

const STATIC_TOKEN = async (): Promise<string> => 'tok-123'

describe('Google Workspace Core — production REST client (mocked Google API)', () => {
  test('drive_list issues GET /files with q, orderBy, fields + bearer token', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({
      json: {
        files: [
          {
            id: 'f1',
            name: 'Report',
            mimeType: 'text/plain',
            modifiedTime: '2026-06-01T00:00:00Z',
            size: '42',
            webViewLink: 'https://drive/f1',
          },
        ],
        nextPageToken: 'next-1',
      },
    }))
    const client = buildGoogleWorkspaceClient({ accessToken: STATIC_TOKEN, fetchImpl })
    const res = await client.driveList({ query: "name contains 'Report'", folder_id: 'fold1', page_size: 10 })
    expect(res.files).toHaveLength(1)
    expect(res.files[0]).toMatchObject({ id: 'f1', name: 'Report', mime_type: 'text/plain', size: 42 })
    expect(res.next_page_token).toBe('next-1')
    const call = calls[0]!
    expect(call.method).toBe('GET')
    expect(call.url).toContain('/drive/v3/files?')
    expect(call.headers['authorization']).toBe('Bearer tok-123')
    const q = new URL(call.url).searchParams
    expect(q.get('q')).toBe("name contains 'Report' and 'fold1' in parents")
    expect(q.get('orderBy')).toBe('modifiedTime desc')
    expect(q.get('pageSize')).toBe('10')
    expect(q.get('fields')).toContain('files(')
  })

  test('drive_read exports Google-native docs as text/plain by default', async () => {
    const { fetchImpl, calls } = mockFetch((call) => {
      if (call.url.includes('/export?')) return { text: 'exported body' }
      return { json: { id: 'd1', name: 'My Doc', mimeType: 'application/vnd.google-apps.document' } }
    })
    const client = buildGoogleWorkspaceClient({ accessToken: STATIC_TOKEN, fetchImpl })
    const res = await client.driveRead({ file_id: 'd1' })
    expect(res.file.content_text).toBe('exported body')
    expect(res.file.exported_as).toBe('text/plain')
    const exportCall = calls.find((c) => c.url.includes('/export?'))!
    expect(new URL(exportCall.url).searchParams.get('mimeType')).toBe('text/plain')
  })

  test('drive_read downloads non-native files via alt=media (exported_as null)', async () => {
    const { fetchImpl, calls } = mockFetch((call) => {
      if (call.url.includes('alt=media')) return { text: 'raw text file' }
      return { json: { id: 'p1', name: 'notes.txt', mimeType: 'text/plain' } }
    })
    const client = buildGoogleWorkspaceClient({ accessToken: STATIC_TOKEN, fetchImpl })
    const res = await client.driveRead({ file_id: 'p1' })
    expect(res.file.content_text).toBe('raw text file')
    expect(res.file.exported_as).toBeNull()
    expect(calls.some((c) => c.url.includes('alt=media'))).toBe(true)
  })

  test('drive_read maps 404 metadata to DriveFileNotFoundError', async () => {
    const { fetchImpl } = mockFetch(() => ({ status: 404, text: 'not found' }))
    const client = buildGoogleWorkspaceClient({ accessToken: STATIC_TOKEN, fetchImpl })
    await expect(client.driveRead({ file_id: 'missing' })).rejects.toBeInstanceOf(DriveFileNotFoundError)
  })

  test('drive_upload POSTs a multipart/related body with metadata + content', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({
      json: { id: 'new1', name: 'out.csv', mimeType: 'text/csv', webViewLink: 'https://drive/new1' },
    }))
    const client = buildGoogleWorkspaceClient({ accessToken: STATIC_TOKEN, fetchImpl })
    const res = await client.driveUpload({ name: 'out.csv', mime_type: 'text/csv', content: 'a,b\n1,2', folder_id: 'fold9' })
    expect(res.file).toMatchObject({ id: 'new1', name: 'out.csv', mime_type: 'text/csv' })
    const call = calls[0]!
    expect(call.method).toBe('POST')
    expect(call.url).toContain('/upload/drive/v3/files?')
    expect(new URL(call.url).searchParams.get('uploadType')).toBe('multipart')
    expect(call.headers['content-type']).toContain('multipart/related; boundary=')
    expect(call.body).toContain('"name":"out.csv"')
    expect(call.body).toContain('"parents":["fold9"]')
    expect(call.body).toContain('a,b\n1,2')
  })

  test('sheets_read GETs values/<range> and stringifies cells', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({
      json: { range: 'Sheet1!A1:B2', values: [['x', 1], ['y', 2]] },
    }))
    const client = buildGoogleWorkspaceClient({ accessToken: STATIC_TOKEN, fetchImpl })
    const res = await client.sheetsRead({ spreadsheet_id: 'sid', range: 'Sheet1!A1:B2' })
    expect(res.range).toBe('Sheet1!A1:B2')
    expect(res.values).toEqual([['x', '1'], ['y', '2']])
    expect(calls[0]!.method).toBe('GET')
    expect(calls[0]!.url).toContain('/v4/spreadsheets/sid/values/')
  })

  test('sheets_append POSTs :append with USER_ENTERED + INSERT_ROWS and the values body', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({
      json: { updates: { updatedRange: 'Sheet1!A3:B3', updatedRows: 1, updatedCells: 2 } },
    }))
    const client = buildGoogleWorkspaceClient({ accessToken: STATIC_TOKEN, fetchImpl })
    const res = await client.sheetsAppend({ spreadsheet_id: 'sid', range: 'Sheet1!A1', values: [['c', 'd']] })
    expect(res).toEqual({ updated_range: 'Sheet1!A3:B3', updated_rows: 1, updated_cells: 2 })
    const call = calls[0]!
    expect(call.method).toBe('POST')
    expect(call.url).toContain(':append?')
    const p = new URL(call.url).searchParams
    expect(p.get('valueInputOption')).toBe('USER_ENTERED')
    expect(p.get('insertDataOption')).toBe('INSERT_ROWS')
    expect(JSON.parse(call.body!)).toMatchObject({ values: [['c', 'd']] })
  })

  test('sheets_update PUTs values with USER_ENTERED', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({
      json: { updatedRange: 'Sheet1!A1:A1', updatedRows: 1, updatedCells: 1 },
    }))
    const client = buildGoogleWorkspaceClient({ accessToken: STATIC_TOKEN, fetchImpl })
    const res = await client.sheetsUpdate({ spreadsheet_id: 'sid', range: 'Sheet1!A1', values: [['z']] })
    expect(res).toEqual({ updated_range: 'Sheet1!A1:A1', updated_rows: 1, updated_cells: 1 })
    const call = calls[0]!
    expect(call.method).toBe('PUT')
    expect(new URL(call.url).searchParams.get('valueInputOption')).toBe('USER_ENTERED')
    expect(JSON.parse(call.body!)).toMatchObject({ values: [['z']] })
  })

  test('docs_read GETs the document and flattens the body to text', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({
      json: {
        documentId: 'doc1',
        title: 'Title',
        body: {
          content: [
            { paragraph: { elements: [{ textRun: { content: 'Hello ' } }, { textRun: { content: 'world\n' } }] } },
            { paragraph: { elements: [{ textRun: { content: 'Line 2\n' } }] } },
          ],
        },
      },
    }))
    const client = buildGoogleWorkspaceClient({ accessToken: STATIC_TOKEN, fetchImpl })
    const res = await client.docsRead({ document_id: 'doc1' })
    expect(res.document.title).toBe('Title')
    expect(res.document.body_text).toBe('Hello world\nLine 2')
    expect(calls[0]!.url).toContain('/v1/documents/doc1')
  })

  test('docs_read maps 404 to DocNotFoundError', async () => {
    const { fetchImpl } = mockFetch(() => ({ status: 404, text: 'gone' }))
    const client = buildGoogleWorkspaceClient({ accessToken: STATIC_TOKEN, fetchImpl })
    await expect(client.docsRead({ document_id: 'nope' })).rejects.toBeInstanceOf(DocNotFoundError)
  })

  test('docs_create POSTs title then batchUpdate inserts the body', async () => {
    const { fetchImpl, calls } = mockFetch((call) => {
      if (call.url.endsWith(':batchUpdate')) return { json: { replies: [{}] } }
      return { json: { documentId: 'docNew', title: 'Spec' } }
    })
    const client = buildGoogleWorkspaceClient({ accessToken: STATIC_TOKEN, fetchImpl })
    const res = await client.docsCreate({ title: 'Spec', body: 'Intro paragraph' })
    expect(res).toEqual({ document_id: 'docNew', title: 'Spec' })
    expect(calls[0]!.method).toBe('POST')
    expect(JSON.parse(calls[0]!.body!)).toEqual({ title: 'Spec' })
    const batch = calls.find((c) => c.url.endsWith(':batchUpdate'))!
    const payload = JSON.parse(batch.body!)
    expect(payload.requests[0].insertText.text).toBe('Intro paragraph')
    expect(payload.requests[0].insertText.location.index).toBe(1)
  })

  test('docs_update resolves the end index then batchUpdate inserts text', async () => {
    const { fetchImpl, calls } = mockFetch((call) => {
      if (call.url.endsWith(':batchUpdate')) return { json: { replies: [{}] } }
      // documents.get for end-index resolution.
      return { json: { documentId: 'doc1', body: { content: [{ endIndex: 25 }] } } }
    })
    const client = buildGoogleWorkspaceClient({ accessToken: STATIC_TOKEN, fetchImpl })
    const res = await client.docsUpdate({ document_id: 'doc1', text: ' appended' })
    expect(res).toEqual({ document_id: 'doc1', replies_count: 1 })
    const batch = calls.find((c) => c.url.endsWith(':batchUpdate'))!
    const payload = JSON.parse(batch.body!)
    expect(payload.requests[0].insertText.location.index).toBe(24)
    expect(payload.requests[0].insertText.text).toBe(' appended')
  })

  test('docs_update honors an explicit index without a documents.get round-trip', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ json: { replies: [{}] } }))
    const client = buildGoogleWorkspaceClient({ accessToken: STATIC_TOKEN, fetchImpl })
    await client.docsUpdate({ document_id: 'doc1', text: 'X', index: 5 })
    // Only the batchUpdate call — no preliminary GET.
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toEndWith(':batchUpdate')
    expect(JSON.parse(calls[0]!.body!).requests[0].insertText.location.index).toBe(5)
  })

  test('a null access token throws OAuthMissingError before any fetch', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ json: {} }))
    const client = buildGoogleWorkspaceClient({ accessToken: async () => null, fetchImpl })
    await expect(client.driveList({})).rejects.toBeInstanceOf(OAuthMissingError)
    expect(calls).toHaveLength(0)
  })

  test('non-404 API errors surface as GoogleWorkspaceApiError with the status', async () => {
    const { fetchImpl } = mockFetch(() => ({ status: 500, text: 'boom' }))
    const client = buildGoogleWorkspaceClient({ accessToken: STATIC_TOKEN, fetchImpl })
    const err = await client.sheetsRead({ spreadsheet_id: 's', range: 'A1' }).catch((e) => e)
    expect(err).toBeInstanceOf(GoogleWorkspaceApiError)
    expect((err as GoogleWorkspaceApiError).http_status).toBe(500)
  })
})

describe('Google Workspace Core — in-memory adapter', () => {
  test('drive list filters by folder + name query, newest-first', async () => {
    const client = buildInMemoryGoogleWorkspaceClient()
    client.seedDriveFile({ name: 'alpha report', mime_type: 'text/plain', parents: ['fA'], modified_time: '2026-01-01T00:00:00Z' })
    client.seedDriveFile({ name: 'beta report', mime_type: 'text/plain', parents: ['fA'], modified_time: '2026-03-01T00:00:00Z' })
    client.seedDriveFile({ name: 'gamma', mime_type: 'text/plain', parents: ['fB'], modified_time: '2026-02-01T00:00:00Z' })
    const all = await client.driveList({ folder_id: 'fA' })
    expect(all.files.map((f) => f.name)).toEqual(['beta report', 'alpha report'])
    const q = await client.driveList({ query: "name contains 'alpha'" })
    expect(q.files.map((f) => f.name)).toEqual(['alpha report'])
  })

  test('drive read/upload round-trip; native files report exported_as', async () => {
    const client = buildInMemoryGoogleWorkspaceClient()
    const up = await client.driveUpload({ name: 'x.txt', mime_type: 'text/plain', content: 'body' })
    const read = await client.driveRead({ file_id: up.file.id })
    expect(read.file.content_text).toBe('body')
    expect(read.file.exported_as).toBeNull()
    const nativeId = client.seedDriveFile({ name: 'doc', mime_type: 'application/vnd.google-apps.document', content_text: 'D' })
    const nativeRead = await client.driveRead({ file_id: nativeId })
    expect(nativeRead.file.exported_as).toBe('text/plain')
    await expect(client.driveRead({ file_id: 'missing' })).rejects.toBeInstanceOf(DriveFileNotFoundError)
  })

  test('sheets read/append/update round-trip', async () => {
    const client = buildInMemoryGoogleWorkspaceClient()
    client.seedSheet('sid', [['a', 'b'], ['c', 'd']])
    const read = await client.sheetsRead({ spreadsheet_id: 'sid', range: 'A1' })
    expect(read.values).toEqual([['a', 'b'], ['c', 'd']])
    const appended = await client.sheetsAppend({ spreadsheet_id: 'sid', range: 'A1', values: [['e', 'f']] })
    expect(appended.updated_rows).toBe(1)
    expect(appended.updated_cells).toBe(2)
    const afterAppend = await client.sheetsRead({ spreadsheet_id: 'sid', range: 'A1' })
    expect(afterAppend.values).toEqual([['a', 'b'], ['c', 'd'], ['e', 'f']])
    await client.sheetsUpdate({ spreadsheet_id: 'sid', range: 'A1', values: [['Z']] })
    const afterUpdate = await client.sheetsRead({ spreadsheet_id: 'sid', range: 'A1' })
    expect(afterUpdate.values[0]![0]).toBe('Z')
  })

  test('docs create/read/update round-trip (append + at-index)', async () => {
    const client = buildInMemoryGoogleWorkspaceClient()
    const created = await client.docsCreate({ title: 'T', body: 'Hello' })
    const read = await client.docsRead({ document_id: created.document_id })
    expect(read.document.title).toBe('T')
    expect(read.document.body_text).toBe('Hello')
    await client.docsUpdate({ document_id: created.document_id, text: ' world' })
    expect((await client.docsRead({ document_id: created.document_id })).document.body_text).toBe('Hello world')
    await client.docsUpdate({ document_id: created.document_id, text: 'X', index: 1 })
    expect((await client.docsRead({ document_id: created.document_id })).document.body_text).toBe('XHello world')
    await expect(client.docsUpdate({ document_id: 'nope', text: 'q' })).rejects.toBeInstanceOf(DocNotFoundError)
  })
})

describe('Google Workspace Core — pure helpers', () => {
  test('parseA1Range parses sheet name + anchor', () => {
    expect(parseA1Range('Sheet1!B3:D9')).toEqual({ sheetName: 'Sheet1', startRow: 2, startCol: 1 })
    expect(parseA1Range('A1')).toEqual({ startRow: 0, startCol: 0 })
    expect(parseA1Range('Sheet2!A1')).toEqual({ sheetName: 'Sheet2', startRow: 0, startCol: 0 })
  })

  test('flattenDocBody concatenates runs and trims the trailing newline', () => {
    expect(
      flattenDocBody({
        body: {
          content: [{ paragraph: { elements: [{ textRun: { content: 'a' } }, { textRun: { content: 'b\n' } }] } }],
        },
      }),
    ).toBe('ab')
  })
})
