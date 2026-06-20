/**
 * @neutronai/app — DTC Analytics Core dashboard view (v1).
 *
 * Bare-minimum surface per the sprint brief:
 *   - A table of the most recent N rows (date / revenue / units /
 *     new / repeat).
 *   - A sparkline-style revenue-over-time visual (pure SVG inside
 *     RNW — no chart-lib dep).
 *   - A "Paste CSV" textarea + Import button that POSTs to the Core's
 *     `dtc_analytics_import_csv` MCP tool via the gateway's per-instance
 *     tool surface.
 *
 * The Core ships at `cores/paid-staging/dtc-analytics/` as a Tier 2
 * staging Core. UI wiring lives here in `app/` because the Core
 * manifest does NOT declare a `ui_components[]` entry — the launcher
 * surface lands in a follow-up sprint when the launcher SPI is
 * frozen. Until then, the dashboard is reachable via direct route
 * (`/projects/<id>/cores/dtc-analytics`) and is intended for
 * smoke-testing by Sam against his own projects (topline / acme /
 * northwind).
 *
 * Data plumbing: this v1 view does NOT yet wire to a live backend.
 * It renders against an in-memory state seeded by what the user
 * pastes in the textarea — the CSV is parsed client-side via a thin
 * mirror of the Core's `parseDtcAnalyticsCsv` shape so the dashboard
 * is verifiable without a running gateway. When the gateway exposes
 * a per-Core HTTP surface (P5.x), the data fetch swaps to a real
 * GET. The parsing rules MUST stay in sync with
 * `cores/paid-staging/dtc-analytics/src/csv.ts` — divergence is a
 * P0 bug, called out in the file header in both places.
 */

import { useLocalSearchParams } from 'expo-router'
import { useMemo, useState } from 'react'
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'

interface DailySnapshotRow {
  date: string
  revenue: number
  units: number
  new_customers: number
  repeat_customers: number
}

const SAMPLE_CSV = `date,revenue,units,new_customers,repeat_customers
2026-05-13,420,11,4,3
2026-05-14,380,9,2,4
2026-05-15,510,14,6,2
2026-05-16,605,16,5,5
2026-05-17,725,19,7,6
2026-05-18,560,15,4,7
2026-05-19,810,22,8,9`

const EXPECTED_HEADER = [
  'date',
  'revenue',
  'units',
  'new_customers',
  'repeat_customers',
]
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

interface ParseSuccess {
  ok: true
  rows: DailySnapshotRow[]
}
interface ParseFailure {
  ok: false
  message: string
}
type ParseResult = ParseSuccess | ParseFailure

function parseCsvClientSide(input: string): ParseResult {
  if (input.trim().length === 0) return { ok: false, message: 'CSV input is empty' }
  const lines = input
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  if (lines.length === 0) return { ok: false, message: 'CSV has no rows' }
  const header = lines[0]!.split(',').map((c) => c.trim().toLowerCase())
  if (
    header.length !== EXPECTED_HEADER.length ||
    !EXPECTED_HEADER.every((h, i) => header[i] === h)
  ) {
    return {
      ok: false,
      message: `header must be: ${EXPECTED_HEADER.join(',')}`,
    }
  }
  const seen = new Set<string>()
  const rows: DailySnapshotRow[] = []
  for (let i = 1; i < lines.length; i += 1) {
    const cells = lines[i]!.split(',').map((c) => c.trim())
    if (cells.length !== EXPECTED_HEADER.length) {
      return { ok: false, message: `row ${i + 1} has ${cells.length} fields, expected ${EXPECTED_HEADER.length}` }
    }
    const [date, revStr, unitsStr, newStr, repStr] = cells as [string, string, string, string, string]
    if (!DATE_RE.test(date)) return { ok: false, message: `row ${i + 1}: bad date '${date}'` }
    if (seen.has(date)) return { ok: false, message: `row ${i + 1}: duplicate date '${date}'` }
    seen.add(date)
    const revenue = parseFloat(revStr)
    if (!Number.isFinite(revenue) || revenue < 0 || /[^\d.\-+eE]/.test(revStr)) {
      return { ok: false, message: `row ${i + 1}: revenue '${revStr}' invalid` }
    }
    const units = parseIntStrict(unitsStr)
    const new_customers = parseIntStrict(newStr)
    const repeat_customers = parseIntStrict(repStr)
    if (units === null) return { ok: false, message: `row ${i + 1}: units '${unitsStr}' invalid` }
    if (new_customers === null) return { ok: false, message: `row ${i + 1}: new_customers '${newStr}' invalid` }
    if (repeat_customers === null) return { ok: false, message: `row ${i + 1}: repeat_customers '${repStr}' invalid` }
    rows.push({ date, revenue, units, new_customers, repeat_customers })
  }
  if (rows.length === 0) return { ok: false, message: 'CSV has no data rows' }
  return { ok: true, rows }
}

function parseIntStrict(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : null
}

function formatRevenue(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
}

interface SparklineProps {
  values: number[]
  width: number
  height: number
}

function Sparkline({ values, width, height }: SparklineProps) {
  // Render a simple polyline + filled area inside a fixed-size View
  // using nested Views as "bars" — RNW renders Views, not SVG, so we
  // avoid pulling in `react-native-svg`. Each bar represents one day's
  // revenue scaled to the chart height. Newest day is on the right.
  if (values.length === 0) {
    return (
      <View style={[styles.sparkEmpty, { width, height }]}>
        <Text style={styles.sparkEmptyText}>No data yet</Text>
      </View>
    )
  }
  const max = Math.max(...values, 1)
  const barWidth = Math.max(2, Math.floor((width - (values.length - 1) * 4) / values.length))
  return (
    <View style={[styles.sparkRow, { width, height }]} accessibilityLabel="Revenue sparkline">
      {values.map((v, i) => {
        const h = Math.max(2, (v / max) * (height - 4))
        return (
          <View key={`${i}-${v}`} style={[styles.sparkBar, { width: barWidth, height: h }]} />
        )
      })}
    </View>
  )
}

export default function DtcAnalyticsDashboard() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const projectId = typeof id === 'string' ? id : 'unknown'

  const [csvInput, setCsvInput] = useState<string>(SAMPLE_CSV)
  const [rows, setRows] = useState<DailySnapshotRow[]>(parseCsvClientSide(SAMPLE_CSV).ok
    ? (parseCsvClientSide(SAMPLE_CSV) as ParseSuccess).rows
    : [])
  const [statusMessage, setStatusMessage] = useState<string>('')
  const [statusKind, setStatusKind] = useState<'ok' | 'err' | 'none'>('none')

  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
    [rows],
  )
  const trendValues = useMemo(
    () => [...rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)).map((r) => r.revenue),
    [rows],
  )
  const totalRevenue = useMemo(() => rows.reduce((acc, r) => acc + r.revenue, 0), [rows])
  const totalUnits = useMemo(() => rows.reduce((acc, r) => acc + r.units, 0), [rows])

  const onImport = (): void => {
    const result = parseCsvClientSide(csvInput)
    if (!result.ok) {
      setStatusKind('err')
      setStatusMessage(result.message)
      return
    }
    setRows(result.rows)
    setStatusKind('ok')
    setStatusMessage(`Imported ${result.rows.length} row${result.rows.length === 1 ? '' : 's'}.`)
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.headerBlock}>
        <Text style={styles.overline}>Core · DTC Analytics</Text>
        <Text style={styles.title}>Daily aggregates</Text>
        <Text style={styles.subtitle}>
          Project: <Text style={styles.subtitleEmph}>{projectId}</Text> · per-project install · v1
          manual CSV path
        </Text>
      </View>

      <View style={styles.statRow}>
        <StatCard label="Total revenue" value={formatRevenue(totalRevenue)} />
        <StatCard label="Total units" value={String(totalUnits)} />
        <StatCard label="Days loaded" value={String(rows.length)} />
      </View>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>Revenue trend</Text>
        <Sparkline values={trendValues} width={320} height={64} />
        <Text style={styles.cardFootnote}>
          One bar per day · oldest left, newest right · scaled to peak revenue.
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>Recent snapshots</Text>
        <View style={styles.tableHeader}>
          <Text style={[styles.cell, styles.cellDate, styles.cellHeader]}>Date</Text>
          <Text style={[styles.cell, styles.cellNum, styles.cellHeader]}>Revenue</Text>
          <Text style={[styles.cell, styles.cellNum, styles.cellHeader]}>Units</Text>
          <Text style={[styles.cell, styles.cellNum, styles.cellHeader]}>New</Text>
          <Text style={[styles.cell, styles.cellNum, styles.cellHeader]}>Repeat</Text>
        </View>
        {sortedRows.length === 0 ? (
          <Text style={styles.emptyTable}>No snapshots yet — paste a CSV below.</Text>
        ) : (
          sortedRows.map((r) => (
            <View key={r.date} style={styles.tableRow}>
              <Text style={[styles.cell, styles.cellDate]}>{r.date}</Text>
              <Text style={[styles.cell, styles.cellNum]}>{formatRevenue(r.revenue)}</Text>
              <Text style={[styles.cell, styles.cellNum]}>{r.units}</Text>
              <Text style={[styles.cell, styles.cellNum]}>{r.new_customers}</Text>
              <Text style={[styles.cell, styles.cellNum]}>{r.repeat_customers}</Text>
            </View>
          ))
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>Paste / upload CSV</Text>
        <Text style={styles.cardFootnote}>
          Header: <Text style={styles.mono}>{EXPECTED_HEADER.join(',')}</Text>
        </Text>
        <TextInput
          multiline
          value={csvInput}
          onChangeText={setCsvInput}
          style={styles.csvInput}
          accessibilityLabel="Paste CSV here"
        />
        <View style={styles.actionRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Import CSV"
            onPress={onImport}
            style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
          >
            <Text style={styles.primaryBtnText}>Import CSV</Text>
          </Pressable>
          {statusKind === 'ok' ? (
            <Text style={styles.statusOk}>{statusMessage}</Text>
          ) : statusKind === 'err' ? (
            <Text style={styles.statusErr}>{statusMessage}</Text>
          ) : null}
        </View>
      </View>

      <Text style={styles.footnote}>
        v1 surface — client-side parse mirrors the Core's CSV validator. Real backend wire-up lands
        when the per-Core HTTP surface ships (P5.x).
      </Text>
    </ScrollView>
  )
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.statCard}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  content: { padding: 16, gap: 16 },
  headerBlock: { gap: 4 },
  overline: {
    color: '#7a7a7a',
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  title: { color: '#fafafa', fontSize: 22, fontWeight: '700' },
  subtitle: { color: '#9a9a9a', fontSize: 13, lineHeight: 18 },
  subtitleEmph: { color: '#e0e0e0', fontWeight: '600' },
  statRow: { flexDirection: 'row', gap: 8 },
  statCard: {
    flex: 1,
    backgroundColor: '#121212',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#1f1f1f',
    padding: 12,
    gap: 4,
  },
  statLabel: {
    color: '#7a7a7a',
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  statValue: { color: '#fafafa', fontSize: 16, fontWeight: '700' },
  card: {
    backgroundColor: '#0f0f0f',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#1f1f1f',
    padding: 14,
    gap: 8,
  },
  cardLabel: {
    color: '#9a9a9a',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  cardFootnote: { color: '#5a5a5a', fontSize: 11, fontStyle: 'italic' },
  tableHeader: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
    paddingBottom: 6,
    marginTop: 4,
  },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1a1a1a',
  },
  cell: { color: '#cfcfcf', fontSize: 12 },
  cellHeader: {
    color: '#7a7a7a',
    fontWeight: '600',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  cellDate: { flex: 1.4 },
  cellNum: { flex: 1, textAlign: 'right' },
  emptyTable: {
    color: '#6a6a6a',
    fontSize: 12,
    fontStyle: 'italic',
    paddingVertical: 12,
    textAlign: 'center',
  },
  csvInput: {
    minHeight: 140,
    backgroundColor: '#0a0a0a',
    borderWidth: 1,
    borderColor: '#1f1f1f',
    borderRadius: 8,
    padding: 10,
    color: '#e0e0e0',
    fontSize: 12,
    fontFamily: 'monospace',
    textAlignVertical: 'top',
  },
  actionRow: { flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  primaryBtn: {
    backgroundColor: '#fafafa',
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 10,
  },
  primaryBtnText: { color: '#0a0a0a', fontSize: 14, fontWeight: '700' },
  pressed: { opacity: 0.7 },
  statusOk: { color: '#7ad27a', fontSize: 12 },
  statusErr: { color: '#e07070', fontSize: 12 },
  sparkRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 4,
  },
  sparkBar: {
    backgroundColor: '#7a8cff',
    borderRadius: 2,
  },
  sparkEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#1f1f1f',
    borderRadius: 6,
    borderStyle: 'dashed',
  },
  sparkEmptyText: { color: '#6a6a6a', fontSize: 11 },
  mono: { fontFamily: 'monospace', color: '#cfcfcf' },
  footnote: {
    color: '#5a5a5a',
    fontSize: 11,
    fontStyle: 'italic',
    marginTop: 4,
  },
})
