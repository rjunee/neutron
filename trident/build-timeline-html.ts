import type { TimelineCard, TimelineSegment, TimelineSnapshot, TimelineUsage } from './build-timeline.ts'

export function escapeTimelineHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
}
export function durationLabel(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  return `${(ms / 3_600_000).toFixed(1)}h`
}
export function usageLabel(usage: TimelineUsage): string {
  return usage.tokens === null ? 'Tokens unknown' : `${usage.tokens.toLocaleString('en-US')} observed tokens${usage.coverage === 'partial' ? ' · partial' : ''}`
}
function tone(segment: TimelineSegment): string {
  const label = `${segment.phase} ${segment.label}`
  if (/plan/i.test(label)) return 'plan'
  if (/fix/i.test(label)) return 'fix'
  if (/review|synth|cross/i.test(label)) return 'review'
  if (/test|\bCI\b|suite|probe/i.test(label)) return 'test'
  if (/deploy/i.test(label)) return 'deploy'
  return 'build'
}
const colors: Record<string, string> = { plan: '#a78bfa', build: '#5b9df5', review: '#e7ae55', fix: '#ed7d94', test: '#5ac8ad', deploy: '#a8cb73', gap: '#303945' }
const names: Record<string, string> = { plan: 'Plan', build: 'Build', review: 'Review', fix: 'Fix', test: 'Tests / CI', deploy: 'Deploy', gap: 'Unattributed' }

/** Partition time instead of adding concurrent durations: one horizontal bar per PR. */
export function barIntervals(card: TimelineCard): Array<{ start: number; end: number; tones: string[]; segments: TimelineSegment[] }> {
  if (card.start === null || card.end === null) return []
  const boundaries = [...new Set([card.start, card.end, ...card.segments.flatMap(s => [Math.max(card.start!, s.start), Math.min(card.end!, s.end)])])]
    .filter(at => at >= card.start! && at <= card.end!).sort((a, b) => a - b)
  return boundaries.slice(0, -1).map((start, i) => {
    const end = boundaries[i + 1]!
    const segments = card.segments.filter(s => s.start < end && s.end > start)
    return { start, end, segments, tones: [...new Set(segments.filter(s => s.timing === 'recorded').map(tone))].sort() }
  })
}

export function renderTimeline(snapshot: TimelineSnapshot): string {
  const h = escapeTimelineHtml
  const pct = (ms: number) => (100 * ms / snapshot.maxDurationMs).toFixed(5)
  const time = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('.000Z', ' UTC')
  const warnings = snapshot.warnings.filter(w => !w.startsWith('Showing '))
  return `<div class="chart-meta" data-page="${snapshot.page ?? 0}" data-pages="${snapshot.totalPages ?? 1}"><span>${snapshot.prCount.toLocaleString('en-US')} PRs <span class="muted">· latest activity first</span></span><span class="muted">Updated ${h(new Date(snapshot.observedAt).toISOString().slice(11, 16))} UTC</span></div>
  ${warnings.length ? `<details class="source-note"><summary>Source coverage notes</summary>${warnings.map(w => `<p>${h(w)}</p>`).join('')}</details>` : ''}
  <div class="chart-axis"><span>Pull request</span><div><span>0</span><span>${h(durationLabel(snapshot.maxDurationMs / 2))}</span><span>${h(durationLabel(snapshot.maxDurationMs))}</span></div><span>Wall time</span></div>
  <div class="rows">${snapshot.cards.length === 0 ? '<p class="empty">No pull requests match this view.</p>' : snapshot.cards.map(card => {
    const elapsed = card.start === null || card.end === null ? null : card.end - card.start
    const status = /\bmerged\b/i.test(card.lifecycle) ? 'merged' : /\bclosed\b/i.test(card.lifecycle) ? 'closed' : 'open'
    return `<details class="pr-row" data-card="${h(card.key)}"><summary class="row-summary" title="Click for phase details">
      <span class="pr-label"><span class="pr-id"><span class="status ${status}" aria-label="${status}"></span>${h(card.repository.split('/').pop())} <b>${card.pr === null ? 'Unpublished run' : `PR #${card.pr}`}</b></span><span class="pr-title">${h(card.title)}</span></span>
      <span class="bar-track" aria-label="${elapsed === null ? 'Duration unknown' : `${h(durationLabel(elapsed))} wall-clock timeline`}">${elapsed === null ? '<span class="unknown">No phase timing recorded</span>' : `<span class="bar" style="width:${pct(elapsed)}%">${barIntervals(card).map(interval => {
        const tones = interval.tones.length ? interval.tones : ['gap']
        const background = !interval.tones.length && interval.segments.length ? `repeating-linear-gradient(135deg,${colors.gap},${colors.gap} 4px,#58616f 4px,#58616f 6px)` : tones.length === 1 ? colors[tones[0]!] : `linear-gradient(to bottom,${tones.flatMap((t, i) => [`${colors[t]} ${i * 100 / tones.length}%`, `${colors[t]} ${(i + 1) * 100 / tones.length}%`]).join(',')})`
        const detail = interval.segments.length ? interval.segments.map(s => `${s.label} · ${durationLabel(s.end - s.start)} · ${s.model ?? 'Model unknown'} · ${usageLabel(s.usage)}${s.timing === 'open' ? ' · end unrecorded' : ''}`).join('\n') : `Unattributed · ${durationLabel(interval.end - interval.start)}`
        return `<span class="bar-piece${interval.segments.some(s => s.timing === 'open') ? ' unfinished' : ''}" style="left:${100 * (interval.start - card.start!) / Math.max(1, elapsed)}%;width:${100 * (interval.end - interval.start) / Math.max(1, elapsed)}%;background:${background}" title="${h(detail)}"></span>`
      }).join('')}</span>`}</span><span class="duration">${elapsed === null ? '—' : h(durationLabel(elapsed))}<span class="chevron" aria-hidden="true">⌄</span></span></summary>
      <div class="pr-details"><div class="detail-heading"><strong>${h(card.title)}</strong>${card.url ? `<a href="${h(card.url)}" rel="noreferrer" target="_blank">Open PR ↗</a>` : ''}</div>
      <p class="muted">${h(card.repository)} · ${h(card.lifecycle)}</p><p class="muted">${card.start === null ? 'No phase timing recorded.' : `${h(time(card.start))} → ${h(time(card.end!))}`}</p>
      <p class="muted">Overlapping phases share the same time; different colors stack inside the bar. Unattributed time is unknown, not idle. Dashed spans have no recorded end.</p>
      <div class="phase-list">${card.segments.map(s => `<div class="phase-detail" data-segment="${h(s.id)}" data-duration-ms="${s.end - s.start}"><div><span class="phase-dot" style="background:${colors[tone(s)]}"></span><strong>${h(s.label)}</strong><span>${h(durationLabel(s.end - s.start))}${s.timing === 'open' ? ' · end unrecorded' : ''}</span></div><p>${h(s.model ?? 'Model unknown')} · ${h(usageLabel(s.usage))}</p><small>${h(time(s.start))} → ${h(time(s.end))}</small><small>Input ${h(s.usage.input ?? '?')} · output ${h(s.usage.output ?? '?')} · cache read ${h(s.usage.cacheRead ?? '?')} · cache create ${h(s.usage.cacheCreation ?? '?')} · USD ${h(s.usage.costUsd ?? '?')}</small><small>${h(s.detail)} · ${h(s.usage.source ?? 'No usage report')}</small></div>`).join('')}</div>
      ${card.warnings.map(w => `<p class="muted">${h(w)}</p>`).join('')}
      ${card.phaseTotals.length ? `<details><summary>Unallocated phase totals</summary><p>Legacy cumulative totals cannot be allocated to spans or added to attempt receipts.</p>${card.phaseTotals.map(p => `<p>${h(p.phase)} · ${h(usageLabel(p.usage))} · ${h(p.runId)}</p>`).join('')}</details>` : ''}
      ${card.events.length ? `<details><summary>Recorded events</summary>${card.events.map(e => `<p>${h(time(e.at))} · ${h(e.stage)}</p>`).join('')}</details>` : ''}</div></details>`
  }).join('')}</div><div class="chart-footer"><span>Recorded work · one shared time scale · ${snapshot.cards.length} shown</span><span>${snapshot.prCount} PRs · ${snapshot.runOnlyCount} run-only groups in source</span></div>`
}

export const TIMELINE_STYLE = `
:root{color-scheme:dark;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#11151b;color:#e9edf3;--muted:#9da9b9;--line:#29313c}*{box-sizing:border-box}body{margin:0}button,input,select{font:inherit}main{max-width:1500px;margin:0 auto;padding:44px 48px 28px}header{display:flex;justify-content:space-between;align-items:center;gap:20px;margin-bottom:28px}.eyebrow{font-size:11px;letter-spacing:.16em;color:var(--muted);text-transform:uppercase;margin:0 0 6px}h1{font-size:28px;letter-spacing:-.035em;font-weight:600;margin:0}.subtitle{margin:5px 0 0;color:var(--muted);font-size:13px}.tools{display:flex;align-items:center;gap:8px}input,select,button{background:#1a2029;color:#dfe6ef;border:1px solid #35404e;border-radius:6px;min-height:36px;padding:7px 10px}input{width:190px}button,select,summary{cursor:pointer}button:hover{background:#293342}button:disabled{opacity:.4;cursor:default}a{color:#9ec5ff;text-decoration:none}a:hover{text-decoration:underline}:focus-visible{outline:2px solid #a6cbff;outline-offset:3px}.legend{display:flex;flex-wrap:wrap;gap:18px;margin:0 0 24px;color:#bdc7d5;font-size:12px}.legend span{display:inline-flex;gap:7px;align-items:center}.legend i,.phase-dot{display:inline-block;width:8px;height:8px;border-radius:2px;flex-shrink:0}.chart-meta{display:flex;justify-content:space-between;gap:12px;padding-bottom:16px;font-size:12px}.muted{color:var(--muted)}.chart-axis,.row-summary{display:grid;grid-template-columns:340px minmax(0,1fr) 72px;gap:22px;align-items:center}.chart-axis{color:var(--muted);font-size:11px;padding-bottom:10px}.chart-axis>div{display:flex;justify-content:space-between}.chart-axis>span:last-child{text-align:right}.rows{border-top:1px solid var(--line)}.pr-row{border-bottom:1px solid var(--line)}.row-summary{min-height:70px;padding:13px 0;list-style:none}.row-summary::-webkit-details-marker{display:none}.row-summary:hover{background:#19202a}.pr-label{min-width:0}.pr-id{display:flex;align-items:center;gap:7px;color:var(--muted);font-size:11px;margin-bottom:3px}.pr-id b{font-weight:600;color:#d4deed}.status{width:6px;height:6px;border-radius:50%;background:#65c9a5}.status.merged{background:#ae91e2}.status.closed{background:#e98585}.pr-title{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px}.bar-track{display:block;position:relative;height:24px;background:linear-gradient(to right,transparent calc(50% - .5px),#303947 50%,transparent calc(50% + .5px));border-left:1px solid #303947;border-right:1px solid #303947}.bar{display:block;position:relative;height:24px;border-radius:3px;overflow:hidden}.bar-piece{position:absolute;height:100%;display:block}.bar-piece.unfinished{border-top:2px dashed #ecf1f9;border-bottom:2px dashed #ecf1f9}.duration{display:flex;align-items:center;justify-content:flex-end;gap:12px;font-variant-numeric:tabular-nums;font-size:13px;font-weight:600}.chevron{color:var(--muted);font-weight:400}.pr-row[open] .chevron{transform:rotate(180deg)}.unknown{font-size:11px;color:var(--muted);padding-left:8px;white-space:nowrap}.pr-details{padding:22px 24px;margin:0 0 18px;background:#191f28;border:1px solid #303a47;border-radius:6px;font-size:13px}.detail-heading{display:flex;justify-content:space-between;gap:15px}.detail-heading a{white-space:nowrap}.pr-details p{margin:8px 0}.phase-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px;margin:20px 0}.phase-detail{padding:14px;background:#111820;border:1px solid #2b3644;border-radius:5px;min-width:0}.phase-detail>div{display:flex;gap:8px;align-items:center}.phase-detail>div>span:last-child{margin-left:auto;white-space:nowrap;color:#c6d1e1}.phase-detail small{display:block;color:var(--muted);overflow-wrap:anywhere}.source-note{font-size:12px;color:#deb889;margin-bottom:14px}.source-note p{margin:6px 0}.chart-footer{display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;font-size:11px;color:var(--muted);padding:16px 0}.pagination{display:flex;align-items:center;justify-content:center;gap:14px;margin-top:12px;font-size:12px}.pagination button{min-width:78px}#error{padding:12px;border:1px solid #a37b45;color:#efcda0;border-radius:5px}.empty{padding:48px;text-align:center;color:var(--muted)}@media(min-width:1600px){main{padding-top:56px}}@media(max-width:1000px){main{padding:28px 24px}.chart-axis,.row-summary{grid-template-columns:260px minmax(0,1fr) 64px;gap:16px}.tools input{width:140px}}@media(max-width:700px){main{padding:24px 18px}header{align-items:flex-start;flex-direction:column;gap:18px;margin-bottom:20px}h1{font-size:26px}.tools{width:100%}.tools input{flex:1;min-width:0}.tools select{max-width:130px}.legend{gap:10px 14px;margin-bottom:20px;font-size:11px}.chart-meta{font-size:11px}.chart-meta .muted{display:none}.chart-axis{display:flex;justify-content:space-between}.chart-axis>span:first-child{display:none}.chart-axis>div{flex:1;margin-right:70px}.chart-axis>span:last-child{position:absolute;right:18px}.row-summary{grid-template-columns:minmax(0,1fr) 60px;gap:10px 12px;padding:14px 0;min-height:100px}.pr-label{grid-column:1 / -1}.pr-title{font-size:13px}.bar-track{height:20px}.bar{height:20px}.duration{font-size:12px;gap:8px}.pr-details{padding:15px 12px}.detail-heading{display:block}.detail-heading a{display:inline-block;margin-top:8px}.phase-list{grid-template-columns:1fr}.phase-detail>div{flex-wrap:wrap}.chart-footer>span:last-child{display:none}.unknown{font-size:10px}}
`

export const TIMELINE_SCRIPT = `
let inFlight = false;
let pending = false;
async function refresh() {
  if (inFlight) { pending = true; return; }
  inFlight = true;
  const error = document.getElementById('error');
  const open = new Set(Array.from(document.querySelectorAll('.pr-row[open]')).map(el => el.dataset.card));
  try {
    const response = await fetch('/timeline' + location.search, {cache:'no-store', signal:AbortSignal.timeout(10000)});
    if (!response.ok) throw new Error('HTTP ' + response.status);
    document.getElementById('timeline').innerHTML = await response.text();
    document.querySelectorAll('.pr-row').forEach(el => { if (open.has(el.dataset.card)) el.open = true; });
    const rendered = document.querySelector('[data-page]');
    const page = Number(rendered?.dataset.page) || 0, pages = Number(rendered?.dataset.pages) || 1;
    document.getElementById('page-label').textContent = (page + 1) + ' / ' + pages;
    document.getElementById('previous').disabled = page === 0;
    document.getElementById('next').disabled = page + 1 >= pages;
    error.hidden = true;
  } catch (failure) {
    error.textContent = 'Refresh failed. Displayed data may be stale. Retrying within 30 seconds.';
    error.hidden = false;
  } finally { inFlight = false; if (pending) { pending = false; refresh(); } }
}
document.getElementById('refresh').addEventListener('click', refresh);
for (const [id, delta] of [['previous', -1], ['next', 1]]) document.getElementById(id).addEventListener('click', () => {
  const rendered = document.querySelector('[data-page]');
  const current = Number(rendered?.dataset.page) || 0, pages = Number(rendered?.dataset.pages) || 1;
  const url = new URL(location.href); url.searchParams.set('page', String(Math.max(0, Math.min(pages - 1, current + delta))));
  history.replaceState(null, '', url); refresh(); window.scrollTo({top:0});
});
let searchTimer;
for (const id of ['search', 'repository']) {
  document.getElementById(id).value = new URLSearchParams(location.search).get(id) || '';
  document.getElementById(id).addEventListener(id === 'search' ? 'input' : 'change', event => {
    clearTimeout(searchTimer); searchTimer = setTimeout(() => {
      const url = new URL(location.href);
      for (const key of ['search', 'repository']) url.searchParams.set(key, document.getElementById(key).value);
      url.searchParams.set('page', '0');
      history.replaceState(null, '', url); refresh();
    }, id === 'search' ? 220 : 0);
  });
}
setInterval(refresh, 30000);
refresh();
`

export const TIMELINE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PR timeline</title><style>${TIMELINE_STYLE}</style></head><body><main><header><div><p class="eyebrow">Engineering</p><h1>PR timeline</h1><p class="subtitle">Build phases, measured in wall-clock time.</p></div><div class="tools"><input id="search" type="search" placeholder="Search PRs…" aria-label="Search pull requests"><select id="repository" aria-label="Repository"><option value="">All repositories</option><option value="open">Open</option><option value="managed">Managed</option></select><button id="refresh" type="button" aria-label="Refresh timeline">↻</button></div></header><div class="legend" aria-label="Phase colors">${Object.entries(names).map(([key, name]) => `<span><i style="background:${colors[key]}"></i>${name}</span>`).join('')}</div><p id="error" role="alert" hidden></p><section id="timeline" aria-label="Pull request timelines"><p class="empty">Loading pull requests…</p></section><nav class="pagination" aria-label="Timeline pages"><button id="previous" type="button">Previous</button><span id="page-label"></span><button id="next" type="button">Next</button></nav></main><script>${TIMELINE_SCRIPT}</script></body></html>`
