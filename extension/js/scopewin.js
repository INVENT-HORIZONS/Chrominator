// Pop-out oscilloscope window for one channel (scope.html?ch=N). Same drawing code as the side
// panel's Oscilloscope (Scope), fed by the side panel through ScopeBridge; its timebase, scale,
// pause and CSV are its own. The side panel keeps showing the channel too.
import { Scope, TRACE_COLORS } from './scope.js';
import { SCOPE_CHANNEL } from './scopebridge.js';

const $ = id => document.getElementById(id);
const CH = +new URLSearchParams(location.search).get('ch') || 0;
const color = TRACE_COLORS[CH % TRACE_COLORS.length];
document.documentElement.style.setProperty('--c', color);

const scope = new Scope({
  canvas: $('scopeCanvas'), legend: $('scopeLegend'), rateLabel: $('scopeRate'),
  windowSelect: $('scopeWindow'), rangeSelect: $('scopeRange'),
  runButton: $('scopeRun'), clearButton: $('scopeClear'), saveButton: $('scopeSave'), onStop: null
});

// Timebase arrows (same steps as the side panel), remembered for pop-outs.
const TB_KEY = 'chrominator.popoutTimebase';
try { const v = localStorage.getItem(TB_KEY); if (v) $('scopeWindow').value = v; } catch {}
function stepTimebase(d) {
  const sel = $('scopeWindow');
  const i = Math.min(sel.options.length - 1, Math.max(0, sel.selectedIndex + d));
  if (i !== sel.selectedIndex) { sel.selectedIndex = i; sel.dispatchEvent(new Event('change')); }
  try { localStorage.setItem(TB_KEY, sel.value); } catch {}
  syncTimebase();
}
function syncTimebase() {
  const sel = $('scopeWindow');
  $('tbValue').textContent = sel.options[sel.selectedIndex].text;
  $('tbLess').disabled = sel.selectedIndex === 0;
  $('tbMore').disabled = sel.selectedIndex === sel.options.length - 1;
}
$('tbLess').onclick = () => stepTimebase(-1);
$('tbMore').onclick = () => stepTimebase(1);
syncTimebase();

let boardKey = null, lastStatus = 0, active = false, haveHistory = false;
const bc = new BroadcastChannel(SCOPE_CHANNEL);
bc.onmessage = ({ data: m }) => {
  if (m?.ch !== CH) return;
  if (m.type === 'status') {
    lastStatus = Date.now();
    if (m.hello) {
      const key = `${m.hello.boardName}|${m.hello.capturePeriodUs}|${m.hello.adcBits}`;
      if (key !== boardKey) { boardKey = key; scope.setBoard(m.hello); scope.setActive([CH]); }
    }
    active = !!m.active;
    scope.setNames(m.name ? { [CH]: m.name } : {});
    const title = `A${CH}${m.name ? ' ' + m.name : ''}`;
    $('swTitle').textContent = `${title} · Oscilloscope`;
    document.title = `${title} — Chrominator Oscilloscope`;
    showState();
  } else if (m.type === 'history') {
    // Live blocks that came before the history are in it too; adding them first would look like a
    // board restart (block numbers going backwards), so they are ignored until the history is in.
    if (haveHistory) return;
    haveHistory = true;
    for (const b of m.blocks) scope.add(b);
  } else if (m.type === 'block' && haveHistory) {
    scope.add(m.block);
  }
};

function showState() {
  const live = Date.now() - lastStatus < 3000;
  const msg = !live ? 'Not connected. Open Chrominator\'s side panel and connect to the board.'
    : !active ? `A${CH} is not in Oscilloscope mode, so nothing new is being drawn. Set it back to Oscilloscope in the side panel.` : '';
  $('offline').textContent = msg;
  $('offline').hidden = !msg;
  $('scopeCanvas').style.opacity = live && active ? '' : '.6';
}
setInterval(showState, 1000);

// Follow the light/dark choice made in the side panel.
addEventListener('storage', e => {
  if (e.key !== 'chrominator.theme') return;
  if (e.newValue === 'light' || e.newValue === 'dark') document.documentElement.dataset.theme = e.newValue;
  scope.redraw();
});

bc.postMessage({ type: 'hello', ch: CH });
showState();
