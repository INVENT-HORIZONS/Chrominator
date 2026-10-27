// UART terminal window (terminal.html). Shows the traffic of the board's UART: data sent on TX in
// red, data received on RX in green. The side panel owns the serial link; this window talks to it
// through the BroadcastChannel described in termbridge.js.
import { TERM_CHANNEL } from './termbridge.js';

const $ = id => document.getElementById(id);
const out = $('out');
const ch = new BroadcastChannel(TERM_CHANNEL);
const MAX_LINES = 5000;
const PREFS = 'chrominator.term';

let view = 'text';                 // 'text' | 'hex'
let entries = [];                  // { dir, bytes, t } — kept so the view can be switched
let entryBytes = 0;
let status = null, lastStatus = 0;
let line = null, lineDir = null, pendingCR = false;
let sendId = 0;
const pendingSends = new Map();

// ---------------- prefs ----------------
try {
  const p = JSON.parse(localStorage.getItem(PREFS)) || {};
  if (p.view === 'hex') view = 'hex';
  if (p.eol != null) $('eol').value = p.eol;
  $('sendHex').checked = !!p.hex;
} catch {}
const savePrefs = () => { try { localStorage.setItem(PREFS, JSON.stringify({ view, eol: $('eol').value, hex: $('sendHex').checked })); } catch {} };

// ---------------- rendering ----------------
const atBottom = () => out.scrollHeight - out.scrollTop - out.clientHeight < 24;

function newLine(dir) {
  line = document.createElement('div');
  line.className = `ln ${dir}`;
  out.append(line);
  lineDir = dir;
  while (out.childElementCount > MAX_LINES) out.firstElementChild.remove();
}

function ctlSpan(b) {
  const s = document.createElement('span');
  s.className = 'cc';
  s.textContent = `‹${b.toString(16).toUpperCase().padStart(2, '0')}›`;
  return s;
}

// Text view: printable ASCII as text, CR / LF / CR+LF end the line, other bytes as ‹XX›.
// A change of direction (TX <-> RX) always starts a new line, so the two never share one.
// A line is only created when something goes on it, so CR+LF doesn't leave an empty line behind;
// a second line break in a row does give a blank line.
let broke = false;                 // a line break was seen and the next line hasn't started yet
function lineBreak(dir) {
  if (broke) { newLine(dir); line.textContent = ''; }       // blank line: the data had two breaks
  line = null; broke = true;
}
function appendText(dir, bytes) {
  if (lineDir !== dir) { line = null; broke = false; pendingCR = false; lineDir = dir; }
  let text = '';
  const target = () => { if (!line) { newLine(dir); broke = false; } return line; };
  const flush = () => { if (text) { target().append(text); text = ''; } };
  for (const b of bytes) {
    if (b === 0x0A) { if (pendingCR) { pendingCR = false; continue; } flush(); lineBreak(dir); continue; }
    pendingCR = false;
    if (b === 0x0D) { flush(); lineBreak(dir); pendingCR = true; continue; }
    if (b === 0x09) text += '    ';
    else if (b >= 0x20 && b < 0x7F) text += String.fromCharCode(b);
    else { flush(); target().append(ctlSpan(b)); }
  }
  flush();
}

// Hex view: 16 bytes per row with the direction and an ASCII column.
function appendHex(dir, bytes) {
  for (let i = 0; i < bytes.length; i += 16) {
    const row = bytes.slice(i, i + 16);
    newLine(dir);
    const d = document.createElement('span'); d.className = 'dir'; d.textContent = dir.toUpperCase();
    const a = document.createElement('span'); a.className = 'asc';
    a.textContent = row.map(b => (b >= 0x20 && b < 0x7F ? String.fromCharCode(b) : '.')).join('');
    line.append(d, row.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ').padEnd(47), a);
  }
  line = null;                                   // next chunk starts its own row
}

function append(entry, keep = true) {
  if (keep) {
    entries.push(entry); entryBytes += entry.bytes.length;
    while (entryBytes > 256 * 1024 && entries.length > 1) entryBytes -= entries.shift().bytes.length;
  }
  const stick = atBottom();
  (view === 'hex' ? appendHex : appendText)(entry.dir, entry.bytes);
  if (stick) out.scrollTop = out.scrollHeight;
}

function rerender() {
  out.replaceChildren(); line = null; lineDir = null; pendingCR = false; broke = false;
  for (const e of entries) append(e, false);
  out.scrollTop = out.scrollHeight;
}

function setView(v) {
  view = v;
  $('viewText').setAttribute('aria-pressed', String(v === 'text'));
  $('viewHex').setAttribute('aria-pressed', String(v === 'hex'));
  savePrefs();
  rerender();
}

// ---------------- status ----------------
function showStatus() {
  const live = status && Date.now() - lastStatus < 3000;
  const s = live ? status : null;
  $('offline').hidden = !!(s && s.connected);
  $('chipTx').classList.toggle('on', !!s?.tx);
  $('chipRx').classList.toggle('on', !!s?.rx);
  $('chipTx').textContent = `TX ${s?.txPin || 'D1'} ${s?.tx ? 'on' : 'off'}`;
  $('chipRx').textContent = `RX ${s?.rxPin || 'D0'} ${s?.rx ? 'on' : 'off'}`;
  $('cfg').textContent = s ? `${s.baud} ${s.format}` : '—';
  const canSend = !!(s && s.connected && s.tx);
  $('line').disabled = !canSend; $('btnSend').disabled = !canSend;
  if (!$('hint').classList.contains('err')) {
    $('hint').textContent = !s || !s.connected ? '' : !s.tx
      ? `Turn on UART TX (${s.txPin}) in the side panel to send.`
      : `Sending on ${s.txPin} at ${s.baud} ${s.format}.${s.rx ? '' : ` RX (${s.rxPin}) is off, so nothing is received.`}`;
  }
}
setInterval(showStatus, 1000);

// ---------------- sending ----------------
function parseHex(str) {
  const parts = str.trim().split(/[\s,]+/).filter(Boolean).map(p => p.replace(/^0x/i, ''));
  if (!parts.every(p => /^[0-9a-f]{1,2}$/i.test(p))) throw new Error('Hex bytes look like: 48 65 6C 6C 6F');
  return parts.map(p => parseInt(p, 16));
}

function hint(msg, err = false) {
  $('hint').textContent = msg;
  $('hint').classList.toggle('err', err);
  if (err) setTimeout(() => { $('hint').classList.remove('err'); showStatus(); }, 4000);
}

function send() {
  const text = $('line').value;
  let bytes;
  try {
    if ($('sendHex').checked) bytes = parseHex(text);
    else bytes = Array.from(new TextEncoder().encode(text + $('eol').value.replace('\\r', '\r').replace('\\n', '\n')));
  } catch (e) { hint(e.message, true); return; }
  if (!bytes.length) return;
  const id = ++sendId;
  pendingSends.set(id, text);
  ch.postMessage({ type: 'send', id, bytes });
  $('line').value = '';
}

// ---------------- channel ----------------
ch.onmessage = ({ data: m }) => {
  if (m?.type === 'status') { status = m; lastStatus = Date.now(); showStatus(); }
  else if (m?.type === 'data') append({ dir: m.dir, bytes: m.bytes, t: m.t });
  else if (m?.type === 'history') { entries = []; entryBytes = 0; for (const e of m.entries) { entries.push(e); entryBytes += e.bytes.length; } rerender(); }
  else if (m?.type === 'sent' && pendingSends.has(m.id)) {
    const text = pendingSends.get(m.id); pendingSends.delete(m.id);
    if (m.error) { hint(`Not sent: ${m.error}`, true); if (!$('line').value) $('line').value = text; }
  }
};

$('viewText').onclick = () => setView('text');
$('viewHex').onclick = () => setView('hex');
$('btnClear').onclick = () => { entries = []; entryBytes = 0; rerender(); ch.postMessage({ type: 'clear' }); };
$('btnSend').onclick = send;
$('line').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
$('eol').onchange = savePrefs;
$('sendHex').onchange = () => { $('eol').disabled = $('sendHex').checked; savePrefs(); };
$('eol').disabled = $('sendHex').checked;
// Follow the light/dark choice made in the side panel.
addEventListener('storage', e => {
  if (e.key !== 'chrominator.theme') return;
  if (e.newValue === 'light' || e.newValue === 'dark') document.documentElement.dataset.theme = e.newValue;
  else delete document.documentElement.dataset.theme;
});

setView(view);
showStatus();
ch.postMessage({ type: 'hello' });
$('line').focus();
