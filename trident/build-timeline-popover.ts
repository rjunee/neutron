export const PHASE_POPOVER_STYLE = `
.phase-picker{display:flex;align-items:center;justify-content:flex-end;gap:7px;min-height:44px;padding:0 3px;border:0;background:transparent;font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}.phase-picker:hover{background:#263446}.phase-picker .chevron{font-size:16px}.phase-picker:focus-visible{outline-offset:0}
.lifecycle-heading{font-size:12px;font-weight:600;letter-spacing:.035em;margin:24px 0 10px;color:#d5dfed}.lifecycle-heading:first-child{margin-top:12px}.pr-row[data-state=open]{background:#1b2b402b;box-shadow:inset 2px 0 #698fbe}.pr-row[data-state=open] .pr-label{padding-left:10px}
.status-pill{font-size:10px;line-height:18px;padding:0 6px;border:1px solid #465164;border-radius:4px;color:#bbc6d5;margin-left:auto;letter-spacing:.02em}.status-pill.open{color:#9dc5ff;border-color:#36577e;background:#172b42}.status-pill.merged{color:#ccb4fb;border-color:#574374;background:#281f38}.status-pill.closed{color:#edadaf;border-color:#6b4148;background:#321f28}.work-signal{display:block;font-size:10px;color:#9da9b9;margin-top:3px}.work-signal.running{color:#79dfbc}.work-signal.pending{color:#eac381}.work-signal.recent{color:#a5b8d0}.bar-piece{padding:0;min-height:0;border:0;border-radius:0}.bar-piece:hover{filter:brightness(1.2)}.bar:has(.bar-piece:focus-visible){overflow:visible}.bar-piece:focus-visible{z-index:2;outline-offset:2px}.overflow-button{position:absolute;right:0;top:-4px;height:32px;min-height:0;width:24px;padding:0;border-radius:3px;border:1px solid #5d7087;background:#273648;color:#e4efff;font-size:21px;line-height:28px;z-index:3}.scale-tools{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;color:#aebdce;font-size:11px}.scale-switch{display:flex;border:1px solid #35404e;border-radius:5px;padding:2px;gap:2px}.scale-switch button{min-height:25px;font-size:11px;padding:3px 9px;border:0;background:transparent}.scale-switch button[aria-pressed=true]{background:#35465d;color:white}.row-summary{min-height:83px}.phase-popover{position:fixed;z-index:20;width:350px;max-width:calc(100vw - 24px);max-height:min(430px,calc(100dvh - 24px));overflow:auto;background:#202a38;color:#eff4fb;border:1px solid #52647b;border-radius:12px;padding:18px;box-shadow:0 18px 60px #0009,0 2px 8px #0007;font-size:13px}.phase-popover[hidden]{display:none}.popover-top{display:flex;gap:12px;align-items:flex-start;padding-bottom:12px;border-bottom:1px solid #405067}.popover-heading{font-size:15px;font-weight:600;line-height:1.4;flex:1}.popover-close{padding:0;min-height:26px;width:26px;font-size:18px;line-height:24px;border:0;background:transparent;color:#c5d3e5}.popover-window{font-size:11px;color:#b1c1d6;margin:8px 0 0}.popover-action{padding:12px 0;border-bottom:1px solid #3b485b}.popover-action strong{display:block;font-size:13px;font-weight:600}.popover-metrics{display:flex;gap:12px;margin-top:5px;align-items:baseline;flex-wrap:wrap}.popover-duration{font-size:18px;font-weight:600;letter-spacing:-.02em}.popover-tokens{color:#d0dceb;font-size:12px}.popover-model,.popover-note{display:block;margin-top:4px;font-size:11px;color:#b2c1d3;overflow-wrap:anywhere}.popover-footer{display:block;width:100%;margin-top:14px;background:#2d4058;border:1px solid #536d8d;color:#dcecff;min-height:36px}.popover-gap{color:#c0cddd;margin:16px 0}.pr-details .detail-heading strong{display:block}@media(max-width:700px){.phase-popover{width:calc(100vw - 24px);max-height:52dvh;border-radius:14px;padding:16px}.popover-close{min-height:32px;width:32px}.popover-footer{min-height:42px}.scale-tools{align-items:flex-start;gap:10px}.scale-tools>span{max-width:190px}.detail-heading a{display:block}.tools select{font-size:12px}.row-summary{min-height:110px}.status-pill{font-size:10px}.work-signal{font-size:10px}}
`

/** All phase text is assigned through textContent, never interpreted as markup. */
export const PHASE_POPOVER_SCRIPT = `
const popover = document.getElementById('phase-popover');
let phaseTrigger = null, phasePinned = false, phaseHideTimer, suppressPhaseFocus = false;
function hidePhasePopover() {
  clearTimeout(phaseHideTimer);
  if (phaseTrigger) phaseTrigger.setAttribute('aria-expanded', 'false');
  phaseTrigger = null; phasePinned = false; popover.hidden = true;
}
function phaseNode(tag, className, text) {
  const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
}
function dismissPhasePopover() {
  const original = phaseTrigger; hidePhasePopover(); suppressPhaseFocus = true;
  original?.focus({preventScroll:true}); suppressPhaseFocus = false;
}
function capturePhasePopover() {
  return phaseTrigger ? { key: phaseTrigger.dataset.phaseKey, pinned: phasePinned, scroll: popover.scrollTop,
    focusedTrigger: document.activeElement === phaseTrigger, focusedControl: popover.contains(document.activeElement) ? document.activeElement.className : null } : null;
}
function restorePhasePopover(state) {
  if (!state) return;
  const trigger = Array.from(document.querySelectorAll('[data-phase-key]')).find(el => el.dataset.phaseKey === state.key);
  if (!trigger) return;
  showPhasePopover(trigger, state.pinned); popover.scrollTop = state.scroll;
  suppressPhaseFocus = true;
  if (state.focusedTrigger) trigger.focus({preventScroll:true});
  else if (state.focusedControl === 'popover-close' || state.focusedControl === 'popover-footer') popover.querySelector('.' + state.focusedControl)?.focus({preventScroll:true});
  suppressPhaseFocus = false;
}
function restorePhaseFocus(key) {
  if (!key) return;
  suppressPhaseFocus = true;
  Array.from(document.querySelectorAll('[data-phase-key]')).find(el => el.dataset.phaseKey === key)?.focus({preventScroll:true});
  suppressPhaseFocus = false;
}
function showPhasePopover(trigger, pinned = false) {
  clearTimeout(phaseHideTimer);
  if (phaseTrigger && phaseTrigger !== trigger) phaseTrigger.setAttribute('aria-expanded', 'false');
  phaseTrigger = trigger; phasePinned = pinned;
  trigger.setAttribute('aria-expanded', 'true');
  const info = JSON.parse(trigger.dataset.phaseInfo);
  popover.replaceChildren();
  const top = phaseNode('div', 'popover-top', '');
  top.append(phaseNode('div', 'popover-heading', info.title));
  const close = phaseNode('button', 'popover-close', '×'); close.type = 'button'; close.setAttribute('aria-label', 'Close phase details');
  close.addEventListener('click', dismissPhasePopover); top.append(close); popover.append(top);
  popover.append(phaseNode('p', 'popover-window', info.windowLabel || info.duration + ' of wall-clock time in this interval'));
  if (!info.actions.length) popover.append(phaseNode('p', 'popover-gap', 'No phase evidence recorded here. This time is unattributed, not proven idle.'));
  for (const action of info.actions) {
    const row = phaseNode('div', 'popover-action', ''); row.append(phaseNode('strong', '', action.label));
    const metrics = phaseNode('div', 'popover-metrics', '');
    metrics.append(phaseNode('span', 'popover-duration', action.duration), phaseNode('span', 'popover-tokens', action.tokens)); row.append(metrics);
    row.append(phaseNode('small', 'popover-model', action.model));
    if (action.crossesWindow) row.append(phaseNode('small', 'popover-note', 'Full action duration · crosses the focus-window boundary'));
    if (action.open) row.append(phaseNode('small', 'popover-note', 'End unrecorded · elapsed time is not proof of running work'));
    popover.append(row);
  }
  const more = phaseNode('button', 'popover-footer', 'Open full PR details'); more.type = 'button';
  more.addEventListener('click', () => { const row = phaseTrigger?.closest('.pr-row'); hidePhasePopover(); if (row) { row.open = true; row.querySelector('summary').focus(); } }); popover.append(more);
  popover.hidden = false;
  positionPhasePopover();
}
function positionPhasePopover() {
  if (!phaseTrigger || popover.hidden) return;
  const box = phaseTrigger.getBoundingClientRect(); const size = popover.getBoundingClientRect();
  const left = window.innerWidth <= 700 ? 12 : Math.max(12, Math.min(window.innerWidth - size.width - 12, box.left));
  const topPos = window.innerWidth <= 700 ? window.innerHeight - size.height - 12 : box.bottom + size.height + 12 < window.innerHeight ? box.bottom + 9 : Math.max(12, box.top - size.height - 9);
  popover.style.left = left + 'px'; popover.style.top = topPos + 'px';
}
document.addEventListener('pointerover', event => {
  const trigger = event.target.closest('[data-phase-info]');
  if (trigger && event.pointerType !== 'touch' && !phasePinned) showPhasePopover(trigger);
  if (popover.contains(event.target)) clearTimeout(phaseHideTimer);
});
document.addEventListener('pointerout', event => {
  if (phasePinned) return;
  const related = event.relatedTarget;
  if (related && (popover.contains(related) || phaseTrigger?.contains(related))) return;
  if (popover.contains(event.target) || phaseTrigger?.contains(event.target)) phaseHideTimer = setTimeout(hidePhasePopover, 160);
});
document.addEventListener('focusin', event => { const trigger = event.target.closest('[data-phase-info]'); if (trigger && !suppressPhaseFocus) showPhasePopover(trigger); });
document.addEventListener('focusout', event => {
  if (!phasePinned && !popover.contains(event.relatedTarget) && !phaseTrigger?.contains(event.relatedTarget)) phaseHideTimer = setTimeout(hidePhasePopover, 160);
});
document.addEventListener('click', event => {
  const trigger = event.target.closest('[data-phase-info]');
  if (trigger) { event.preventDefault(); event.stopPropagation(); if (phasePinned && phaseTrigger === trigger) hidePhasePopover(); else showPhasePopover(trigger, true); }
  else if (!popover.contains(event.target)) hidePhasePopover();
});
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !popover.hidden) { event.preventDefault(); dismissPhasePopover(); } });
window.addEventListener('resize', positionPhasePopover);
window.addEventListener('scroll', positionPhasePopover, {passive:true});
`
