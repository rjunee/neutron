import type { TimelineSnapshot, TimelineUsage } from './build-timeline.ts'

export function escapeTimelineHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
}

export function durationLabel(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`
  return `${(ms / 3_600_000).toFixed(2)}h`
}

export function usageLabel(usage: TimelineUsage): string {
  if (usage.tokens === null) return 'Tokens unknown'
  return `${usage.tokens.toLocaleString('en-US')} observed tokens${usage.coverage === 'partial' ? ' · partial' : ''}`
}

function tone(label: string): string {
  if (/plan/i.test(label)) return 'plan'
  if (/fix/i.test(label)) return 'fix'
  if (/cross/i.test(label)) return 'cross'
  if (/review|synth/i.test(label)) return 'review'
  if (/test|CI/i.test(label)) return 'test'
  if (/deploy/i.test(label)) return 'deploy'
  return 'build'
}

/** Data enters HTML only through escaping; bar dimensions come from validated timestamps. */
export function renderTimeline(snapshot: TimelineSnapshot): string {
  const h = escapeTimelineHtml
  const pct = (duration: number) => (100 * duration / snapshot.maxDurationMs).toFixed(5)
  return `<p class="refreshed" data-page="${snapshot.page ?? 0}" data-pages="${snapshot.totalPages ?? 1}">Observed ${h(new Date(snapshot.observedAt).toISOString())} · newest first · ${snapshot.prCount.toLocaleString('en-US')} PRs · ${snapshot.runOnlyCount.toLocaleString('en-US')} run-only groups · ${snapshot.cards.length} groups shown</p>
  ${snapshot.warnings.map(warning => `<p class="warning" role="status">${h(warning)}</p>`).join('')}
  <p class="scope">Recorded build activity. Gaps mean unattributed time, not idle time. Overlapping work uses separate lanes. Dashed spans have no recorded end; elapsed time is not proof of liveness. Tokens are provider observations, never estimates.</p>
  <div class="legend"><span class="plan">Planning</span><span class="build">Building</span><span class="review">Review</span><span class="cross">Cross-model</span><span class="fix">Fixing</span><span class="test">Tests / CI</span><span class="deploy">Deploy</span><span class="gap">Unattributed</span></div>
  <p class="scale">Shared time scale: full width = ${h(durationLabel(snapshot.maxDurationMs))}. Each row starts at its own first recorded timestamp.</p>
  ${snapshot.cards.length === 0 ? '<p class="empty">No PR or run records in the configured sources.</p>' : snapshot.cards.map(card => {
    const elapsed = card.start === null || card.end === null ? null : card.end - card.start
    return `<article class="card" data-card="${h(card.key)}">
      <header><h2>${h(card.repository)} · ${card.url ? `<a href="${h(card.url)}" rel="noreferrer">PR #${card.pr}</a>` : card.pr === null ? 'Unpublished run' : `PR #${card.pr}`} <span>${h(card.title)}</span></h2>
      <strong>${elapsed === null ? 'Duration unknown' : h(durationLabel(elapsed))}</strong></header>
      <p class="meta">${h(card.lifecycle)} · ${card.active ? 'Elapsed through refresh' : 'Recorded end'} · ${card.start === null ? 'Start unknown' : h(new Date(card.start).toISOString())} · ${card.runs.map(run => h(run.phase)).join(', ')}</p>
      ${elapsed === null ? '' : `<div class="timeline" style="height:${card.lanes * 42 + 18}px" aria-label="Elapsed timeline">
        <div class="extent" style="width:${pct(elapsed)}%"></div>
        ${card.gaps.map(gap => `<div class="unattributed" style="left:${pct(gap.start - card.start!)}%;width:${pct(gap.end - gap.start)}%" title="Unattributed: ${h(durationLabel(gap.end - gap.start))}"></div>`).join('')}
        ${card.segments.map(segment => `<div tabindex="0" class="segment ${tone(segment.label)} ${segment.timing}" data-segment="${h(segment.id)}" data-duration-ms="${segment.end - segment.start}" style="left:${pct(segment.start - card.start!)}%;width:${pct(segment.end - segment.start)}%;top:${segment.lane * 42 + 9}px" title="${h(`${segment.label} · ${durationLabel(segment.end - segment.start)} · ${segment.model ?? 'model unknown'} · ${usageLabel(segment.usage)} · ${segment.detail}${segment.timing === 'open' ? ' · end unrecorded' : ''}`)}"><b>${h(segment.label)}</b><small>${h(usageLabel(segment.usage))}</small></div>`).join('')}
      </div>`}
      <details><summary>Phase details, models and coverage (${card.segments.length} spans)</summary>
        <div class="table-wrap"><table><thead><tr><th>Phase</th><th>Wall time</th><th>Model</th><th>Observed tokens</th><th>Evidence</th></tr></thead><tbody>
        ${card.segments.map(segment => `<tr><td>${h(segment.label)}</td><td>${h(durationLabel(segment.end - segment.start))}${segment.timing === 'open' ? ' · end unknown' : ''}</td><td>${h(segment.model ?? 'Unknown')}</td><td>${h(usageLabel(segment.usage))}<small>Input ${h(segment.usage.input ?? '?')} · output ${h(segment.usage.output ?? '?')} · cache read ${h(segment.usage.cacheRead ?? '?')} · cache create ${h(segment.usage.cacheCreation ?? '?')} · USD ${h(segment.usage.costUsd ?? '?')}</small></td><td>${h(segment.detail)}<small>${h(segment.usage.source ?? 'No usage report')}${segment.usage.observedAt === null ? '' : ` · ${h(new Date(segment.usage.observedAt).toISOString())}`}</small></td></tr>`).join('')}
        </tbody></table></div>
        ${card.segments.length === 0 ? '<p>No attributable phase spans. Phase timing, models and tokens remain unknown.</p>' : ''}
        ${card.warnings.map(warning => `<p class="warning">${h(warning)}</p>`).join('')}
        ${card.phaseTotals.length ? `<h3>Legacy phase snapshots</h3><p>Cumulative run/phase totals. Cannot allocate to individual spans; never added to attempt receipts.</p><ul>${card.phaseTotals.map(row => `<li>${h(row.phase)} · ${h(usageLabel(row.usage))} · run ${h(row.runId)}</li>`).join('')}</ul>` : ''}
        ${card.events.length ? `<h3>Recorded stage events</h3><ul>${card.events.map(event => `<li>${h(new Date(event.at).toISOString())} · ${h(event.stage)}</li>`).join('')}</ul>` : ''}
      </details>
    </article>`
  }).join('')}`
}

export const TIMELINE_STYLE = `
:root{color-scheme:dark;font:15px/1.5 system-ui,sans-serif;background:#0c1220;color:#e5edf9}*{box-sizing:border-box}body{margin:0}main{max-width:1440px;margin:auto;padding:24px}h1{font-size:28px;margin:0}h2{font-size:16px;margin:0}h2 span{font-weight:400;color:#bfcade}h3{font-size:15px}.subtitle,.scope,.meta,.refreshed,.scale{color:#a8b7d0}.subtitle{margin-top:4px}.scope{max-width:1000px}.refreshed,.meta{font-size:12px}.legend{display:flex;flex-wrap:wrap;gap:8px}.legend span{padding:3px 9px;border-radius:5px;font-size:12px}.plan{background:#3e377c}.build{background:#164a6e}.review{background:#365880}.cross{background:#633976}.fix{background:#784727}.test{background:#225c56}.deploy{background:#475927}.gap{background:repeating-linear-gradient(45deg,#253047,#253047 3px,#172136 3px,#172136 7px)}.card{border:1px solid #29344b;border-radius:10px;margin:16px 0;padding:16px;background:#111b2d}.card header{display:flex;gap:16px;justify-content:space-between;align-items:baseline}.card header strong{white-space:nowrap;font-size:18px}.timeline{position:relative;margin:12px 0;overflow:hidden}.extent{position:absolute;inset:0 auto 0 0;background:#162136;border:1px solid #34425b}.unattributed{position:absolute;top:0;bottom:0;background:repeating-linear-gradient(45deg,transparent,transparent 4px,#2e3e5755 4px,#2e3e5755 7px)}.segment{position:absolute;height:34px;overflow:hidden;white-space:nowrap;border:1px solid #ffffff35;border-radius:3px;padding:0 5px;line-height:16px;font-size:11px}.segment small{display:block;font-size:10px}.segment.open{border:2px dashed #d3dbe9;opacity:.7}.segment:focus{outline:2px solid white;z-index:1}details{font-size:13px}summary{cursor:pointer;color:#c4d8f8}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;margin:12px 0}th,td{text-align:left;padding:8px;border-bottom:1px solid #2a354b;vertical-align:top}td small{display:block;color:#a8b7d0;white-space:normal}td{min-width:90px}#error,.warning{color:#ffd29a}#error{border:1px solid #9b7046;padding:12px}#error[hidden]{display:none}button{background:#263954;border:1px solid #527297;color:white;padding:7px 12px;border-radius:6px;cursor:pointer}.top{display:flex;justify-content:space-between;gap:12px}.empty{padding:40px;text-align:center}a{color:#b8d8ff}@media(max-width:600px){main{padding:12px}.card{padding:10px}.card header{align-items:flex-start}h1{font-size:22px}h2{font-size:14px}h2 span{display:block}.segment{padding:0 2px}.card header strong{font-size:15px}.scale,.scope{font-size:12px}}
`

export const TIMELINE_SCRIPT = `
let inFlight = false;
async function refresh() {
  if (inFlight) return;
  inFlight = true;
  const error = document.getElementById('error');
  try {
    const response = await fetch('/timeline' + location.search, {cache:'no-store', signal:AbortSignal.timeout(10000)});
    if (!response.ok) throw new Error('HTTP ' + response.status);
    document.getElementById('timeline').innerHTML = await response.text();
    error.hidden = true;
  } catch (failure) {
    error.textContent = 'Refresh failed. Displayed data may be stale. ' + failure.message + '. Retrying within 30 seconds.';
    error.hidden = false;
  } finally { inFlight = false; }
}
document.getElementById('refresh').addEventListener('click', refresh);
document.getElementById('mode').value = new URLSearchParams(location.search).get('mode') || 'lifecycle';
document.getElementById('mode').addEventListener('change', event => {
  const url = new URL(location.href); url.searchParams.set('mode', event.target.value); url.searchParams.set('page', '0');
  history.replaceState(null, '', url); refresh();
});
for (const [id, delta] of [['previous', -1], ['next', 1]]) document.getElementById(id).addEventListener('click', () => {
  const rendered = document.querySelector('[data-page]');
  const current = Number(rendered?.dataset.page) || 0, pages = Number(rendered?.dataset.pages) || 1;
  const url = new URL(location.href); url.searchParams.set('page', String(Math.max(0, Math.min(pages - 1, current + delta))));
  history.replaceState(null, '', url); refresh();
});
setInterval(refresh, 30000);
refresh();
`

export const TIMELINE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Build timelines</title><style>${TIMELINE_STYLE}</style></head><body><main><div class="top"><div><h1>Build timelines</h1><p class="subtitle">Wall-clock time · observed phases · model and token coverage</p></div><button id="refresh" type="button">Refresh</button></div><nav aria-label="Timeline view"><label>Time window <select id="mode"><option value="lifecycle">PR lifecycle</option><option value="work">Observed work</option></select></label> <button id="previous" type="button">Previous 50</button> <button id="next" type="button">Next 50</button></nav><p id="error" role="alert" hidden></p><section id="timeline" aria-live="polite"><p>Loading recorded activity…</p></section></main><script>${TIMELINE_SCRIPT}</script></body></html>`
