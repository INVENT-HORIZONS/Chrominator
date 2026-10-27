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
let line = null;
let sendId = 0;
const pendingSends = new Map();

// ---------------- prefs ----------------
try {
  const p = JSON.parse(localStorage.getItem(PREFS)) || {};
  if (p.view === 'hex') view = 'hex';
  if (p.eol != null) $('eol').value = p.eol;
  $('sendHex').checked = !!p.hex;
  $('sendLive').checked = !!p.live;
} catch {}
const savePrefs = () => { try { localStorage.setItem(PREFS, JSON.stringify({ view, eol: $('eol').value, hex: $('sendHex').checked, live: $('sendLive').checked })); } catch {} };

// ---------------- rendering ----------------
const atBottom = () => out.scrollHeight - out.scrollTop - out.clientHeight < 24;

function newLine(dir) {
  line = document.createElement('div');
  line.className = dir ? `ln ${dir}` : 'ln';
  out.append(line);
  while (out.childElementCount > MAX_LINES) out.firstElementChild.remove();
}

// Text view: one stream, like Tera Term. Each run of TX or RX bytes is a red or green span, and the
// two share a line until a CR, LF or CR+LF ends it, so live typing and its echo stay readable.
// Printable ASCII shows as text, other bytes as ‹XX›. Line breaks are tracked per direction, so a
// TX line break and its RX echo end the line once: a blank line appears only when the *same*
// direction sends two breaks in a row.
const crPending = { tx: false, rx: false };   // CR seen: a following LF of the same direction is part of it
const lastWasBreak = { tx: false, rx: false };
function lineBreak(dir) {
  if (!line && lastWasBreak[dir]) newLine();   // second break in a row from this direction: blank line
  line = null;
  lastWasBreak[dir] = true;
}
function appendText(dir, bytes) {
  let text = '';
  const target = () => { if (!line) newLine(); return line; };
  const span = cls => { const e = document.createElement('span'); e.className = cls; target().append(e); return e; };
  const run = () => { const last = target().lastElementChild; return last && last.className === dir ? last : span(dir); };
  const flush = () => { if (text) { run().append(text); text = ''; lastWasBreak[dir] = false; } };
  for (const b of bytes) {
    if (b === 0x0A) { if (crPending[dir]) { crPending[dir] = false; continue; } flush(); lineBreak(dir); continue; }
    crPending[dir] = false;
    if (b === 0x0D) { flush(); lineBreak(dir); crPending[dir] = true; continue; }
    if (b === 0x09) text += '    ';
    else if (b >= 0x20 && b < 0x7F) text += String.fromCharCode(b);
    else { flush(); span(`cc ${dir}`).textContent = `‹${b.toString(16).toUpperCase().padStart(2, '0')}›`; lastWasBreak[dir] = false; }
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
  out.replaceChildren(); line = null;
  crPending.tx = crPending.rx = lastWasBreak.tx = lastWasBreak.rx = false;
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
  $('line').disabled = !canSend; $('btnSend').disabled = !canSend || $('sendLive').checked;
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

const eolBytes = () => Array.from(new TextEncoder().encode($('eol').value.replace('\\r', '\r').replace('\\n', '\n')));

function post(bytes, text = null) {
  const id = ++sendId;
  pendingSends.set(id, text);
  ch.postMessage({ type: 'send', id, bytes });
}

// Live mode: each key is sent as it is pressed (the box stays empty), Tera Term style.
const LIVE_KEYS = {
  Backspace: [0x08], Tab: [0x09], Escape: [0x1B], Delete: [0x7F],
  ArrowUp: [0x1B, 0x5B, 0x41], ArrowDown: [0x1B, 0x5B, 0x42], ArrowRight: [0x1B, 0x5B, 0x43], ArrowLeft: [0x1B, 0x5B, 0x44]
};
function liveKey(e) {
  if (e.isComposing || e.metaKey || e.altKey) return;
  let bytes = null;
  if (e.key === 'Enter') { bytes = eolBytes(); if (!bytes.length) bytes = [0x0D]; }   // Enter always sends something
  else if (LIVE_KEYS[e.key]) bytes = LIVE_KEYS[e.key];
  else if (e.ctrlKey && /^[a-z]$/i.test(e.key)) {
    if (e.key.toLowerCase() === 'v') return;                                     // Ctrl+V: paste (sent below)
    bytes = [e.key.toUpperCase().charCodeAt(0) & 0x1F];                         // Ctrl+C = 0x03 …
  } else if (!e.ctrlKey && e.key.length === 1) bytes = Array.from(new TextEncoder().encode(e.key));
  if (!bytes) return;
  e.preventDefault();
  post(bytes);
}

function setLive() {
  const live = $('sendLive').checked;
  $('sendHex').disabled = live;
  $('eol').disabled = !live && $('sendHex').checked;
  $('line').value = '';
  $('line').placeholder = live ? 'Live: every key is sent as you type (Enter sends the line ending)' : 'Type and press Enter to send on TX';
  $('line').classList.toggle('live', live);
  savePrefs();
  showStatus();
  $('line').focus();
}

function send() {
  const text = $('line').value;
  let bytes;
  try {
    if ($('sendHex').checked) bytes = parseHex(text);
    else bytes = Array.from(new TextEncoder().encode(text + $('eol').value.replace('\\r', '\r').replace('\\n', '\n')));
  } catch (e) { hint(e.message, true); return; }
  if (!bytes.length) return;
  post(bytes, text);
  $('line').value = '';
}

// ---------------- channel ----------------
ch.onmessage = ({ data: m }) => {
  if (m?.type === 'status') { status = m; lastStatus = Date.now(); showStatus(); }
  else if (m?.type === 'data') append({ dir: m.dir, bytes: m.bytes, t: m.t });
  else if (m?.type === 'history') { entries = []; entryBytes = 0; for (const e of m.entries) { entries.push(e); entryBytes += e.bytes.length; } rerender(); }
  else if (m?.type === 'sent' && pendingSends.has(m.id)) {
    const text = pendingSends.get(m.id); pendingSends.delete(m.id);
    if (m.error) { hint(`Not sent: ${m.error}`, true); if (text != null && !$('line').value) $('line').value = text; }
  }
};

$('viewText').onclick = () => setView('text');
$('viewHex').onclick = () => setView('hex');
$('btnClear').onclick = () => { entries = []; entryBytes = 0; rerender(); ch.postMessage({ type: 'clear' }); };
$('btnSend').onclick = send;
$('line').addEventListener('keydown', e => {
  if ($('sendLive').checked) return liveKey(e);
  if (e.key === 'Enter') { e.preventDefault(); send(); }
});
$('line').addEventListener('paste', e => {
  if (!$('sendLive').checked) return;
  e.preventDefault();
  const t = e.clipboardData.getData('text');
  if (t) post(Array.from(new TextEncoder().encode(t)));
});
// Characters that arrive without a keydown we handled (e.g. from an IME) are sent too.
$('line').addEventListener('input', () => {
  if (!$('sendLive').checked || !$('line').value) return;
  post(Array.from(new TextEncoder().encode($('line').value)));
  $('line').value = '';
});
$('sendLive').onchange = setLive;
$('eol').onchange = savePrefs;
$('sendHex').onchange = () => { $('eol').disabled = $('sendHex').checked; savePrefs(); };
$('eol').disabled = $('sendHex').checked;
setLive();
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
