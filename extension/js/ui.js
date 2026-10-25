// Chrominator side panel UI: connection handling and the pin table.
import { MODE, MODE_NAME, CAP, pinLabel } from './protocol.js';
import { ChrominatorLink, LINK } from './link.js';
import { SerialTransport, choosePort, lastUsedPort, describePort } from './serial.js';
import { Scope, TRACE_COLORS } from './scope.js';

const $ = id => document.getElementById(id);
const MAX_LOG = 300;

let transport = null, link = null, port = null, busy = false;
let rows = [];                     // per pin: { el, select, ctl, kind, refs, lastWrite }

const scope = new Scope({
  canvas: $('scopeCanvas'), legend: $('scopeLegend'), rateLabel: $('scopeRate'),
  windowSelect: $('scopeWindow'), rangeSelect: $('scopeRange'),
  runButton: $('scopeRun'), clearButton: $('scopeClear'), saveButton: $('scopeSave')
});

// ---------------- log & stats ----------------
function log(level, message) {
  const li = document.createElement('li');
  li.className = level;
  const t = document.createElement('time');
  t.textContent = new Date().toLocaleTimeString([], { hour12: false });
  li.append(t, message);
  const ol = $('log');
  ol.prepend(li);
  while (ol.children.length > MAX_LOG) ol.lastChild.remove();
}

function renderStats() {
  const s = link?.stats, p = link?.parser.stats;
  const rowsOut = s ? [
    ['Frames sent', s.tx], ['Frames received', s.rx], ['CRC errors', p.crcErrors],
    ['Junk bytes', p.junkBytes], ['Timeouts', s.timeouts], ['Retries', s.retries],
    ['Capture blocks', s.captureBlocks], ['Capture gaps', s.captureGaps],
    ['Board overruns / dropped', `${s.captureOverruns} / ${s.captureDropped}`],
    ['Heartbeat RTT', s.rttMs == null ? '—' : `${s.rttMs.toFixed(1)} ms`],
    ['Board uptime', s.uptimeMs == null ? '—' : formatUptime(s.uptimeMs)]
  ] : [['Status', 'Not connected']];
  $('stats').replaceChildren(...rowsOut.flatMap(([k, v]) => {
    const dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = k; dd.textContent = v; return [dt, dd];
  }));
}
const formatUptime = ms => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, '0')}m ${String(s % 60).padStart(2, '0')}s`;
};

// ---------------- connection ----------------
const STATE_TEXT = { stopped: 'Disconnected', connecting: 'Connecting…', up: 'Connected', lost: 'Link lost' };

function setState(state) {
  $('linkPill').dataset.state = state;
  $('linkPill').textContent = STATE_TEXT[state];
  $('eye').classList.toggle('on', state === LINK.UP);
  $('pinsSection').classList.toggle('offline', state !== LINK.UP);
  $('btnConnect').textContent = state === LINK.STOPPED ? 'Connect' : 'Disconnect';
  $('btnChoose').hidden = state !== LINK.STOPPED;
  if (state === LINK.STOPPED) { $('rtt').textContent = ''; }
}

async function connect(forceChoose = false) {
  if (busy) return;
  busy = true;
  $('btnConnect').disabled = true;
  try {
    port = forceChoose ? null : await lastUsedPort();
    if (!port) port = await choosePort(msg => log('error', msg));
    if (!port) { log('info', 'No port selected.'); return; }
    $('portName').textContent = describePort(port);

    transport = new SerialTransport(port);
    try {
      await transport.open(bytes => link?.receive(bytes), err => portLost(err));
    } catch (e) {
      log('error', `Could not open ${describePort(port)}: ${e.message}. Close the Arduino IDE's Serial Monitor or any other program using it.`);
      transport = null;
      return;
    }
    log('info', `Port opened: ${describePort(port)}. Waiting for the board…`);

    link = new ChrominatorLink(transport);
    link.addEventListener('state', e => setState(e.detail));
    link.addEventListener('log', e => log(e.detail.level, e.detail.message));
    link.addEventListener('board', e => buildPins(e.detail));
    link.addEventListener('config', e => renderAllPins(e.detail));
    link.addEventListener('inputs', e => updateInputs(e.detail));
    link.addEventListener('ping', e => onPing(e.detail));
    link.addEventListener('capture', e => scope.add(e.detail));
    try {
      await link.start();
    } catch (e) {
      log('error', e.message);
      await disconnect(false);
    }
  } catch (e) {
    log('error', 'Connect failed: ' + e.message);
  } finally {
    busy = false;
    $('btnConnect').disabled = false;
  }
}

async function disconnect(say = true) {
  link?.stop();
  const t = transport;
  link = null; transport = null;
  if (t) await t.close();
  setState(LINK.STOPPED);
  $('boardInfo').textContent = 'No board connected';
  $('pinsSection').hidden = true;
  $('scopeSection').hidden = true;
  renderStats();
  if (say) log('info', 'Disconnected.');
}

function portLost(err) {
  if (!transport) return;
  log('error', 'The serial port closed' + (err ? `: ${err.message}` : '') + '. Was the USB cable unplugged?');
  disconnect(false);
}

function onPing({ rttMs }) {
  const eye = $('eye');
  eye.classList.remove('beat'); void eye.offsetWidth; eye.classList.add('beat');
  $('rtt').textContent = rttMs == null ? '' : `${rttMs.toFixed(0)} ms`;
  if ($('diag').open) renderStats();
}

// ---------------- pin table ----------------
function buildPins({ hello, caps, config }) {
  $('boardInfo').textContent = `${hello.boardName} · firmware ${hello.fwMajor}.${hello.fwMinor} · ${hello.adcBits}-bit ADC`;
  scope.setBoard(hello);
  const tpl = $('pinRow');
  rows = caps.map((c, pin) => {
    const el = tpl.content.firstElementChild.cloneNode(true);
    const label = el.querySelector('.label');
    label.textContent = pinLabel(pin, c);
    if (c.caps & CAP.PWM) label.insertAdjacentHTML('beforeend', '<sup>~</sup>');
    const select = el.querySelector('select');
    const ctl = el.querySelector('.ctl');
    const row = { el, select, ctl, caps: c, kind: null, refs: {}, lastWrite: 0 };
    if (c.caps & CAP.RESERVED) {
      el.classList.add('reserved');
      select.replaceWith(Object.assign(document.createElement('span'), { className: 'note', textContent: 'Serial' }));
      ctl.innerHTML = '<span class="note">Used by the USB link</span>';
    } else {
      const allowed = [[MODE.INPUT, CAP.DIN], [MODE.PULLUP, CAP.PULLUP], [MODE.OUTPUT, CAP.DOUT],
                       [MODE.PWM, CAP.PWM], [MODE.ANALOG, CAP.ADC], [MODE.CAPTURE, CAP.CAPTURE]];
      for (const [m, need] of allowed) if (c.caps & need) select.add(new Option(MODE_NAME[m], m));
      select.addEventListener('change', () => changeMode(pin, +select.value));
    }
    return row;
  });
  $('pinList').replaceChildren(...rows.map(r => r.el));
  $('pinsSection').hidden = false;
  renderAllPins(config);
}

function renderAllPins(config) {
  config.forEach((cfg, pin) => { if (rows[pin] && !(rows[pin].caps.caps & CAP.RESERVED)) renderPin(pin, cfg); });
  // The scope shows every ADC channel in Capture mode, overlaid.
  const capturing = config.flatMap((cfg, pin) =>
    cfg.mode === MODE.CAPTURE && rows[pin]?.caps.adcChannel != null ? [rows[pin].caps.adcChannel] : []);
  scope.setActive(capturing);
  $('scopeSection').hidden = capturing.length === 0;
}

function renderPin(pin, { mode, value }) {
  const row = rows[pin];
  row.select.value = mode;
  if (row.kind === mode) { syncValue(row, mode, value); return; }
  row.kind = mode;
  row.refs = {};
  const ctl = row.ctl;
  ctl.replaceChildren();
  if (mode === MODE.INPUT || mode === MODE.PULLUP) {
    row.refs.level = el('span', 'level', '—');
    ctl.append(row.refs.level);
  } else if (mode === MODE.OUTPUT) {
    const sw = el('label', 'switch');
    const cb = Object.assign(document.createElement('input'), { type: 'checkbox' });
    sw.append(cb, document.createElement('span'));
    cb.addEventListener('change', () => writePin(pin, cb.checked ? 1 : 0, () => { cb.checked = !cb.checked; }));
    row.refs.cb = cb;
    row.refs.state = el('span', 'note', '');
    row.refs.mismatch = el('span', 'mismatch', '');
    ctl.append(sw, row.refs.state, row.refs.mismatch);
  } else if (mode === MODE.PWM) {
    const r = Object.assign(document.createElement('input'), { type: 'range', min: 0, max: 255, step: 1 });
    const num = el('span', 'num', '');
    r.addEventListener('input', () => { num.textContent = pwmText(+r.value); pwmSend(pin, +r.value); });
    row.refs.range = r; row.refs.num = num;
    ctl.append(r, num);
  } else if (mode === MODE.ANALOG || mode === MODE.CAPTURE) {
    const bar = el('span', 'bar'); bar.append(document.createElement('i'));
    if (mode === MODE.CAPTURE) {
      const color = TRACE_COLORS[row.caps.adcChannel % TRACE_COLORS.length];
      const sw = el('span', 'swatch'); sw.style.setProperty('--c', color); sw.title = 'Trace colour on the scope';
      bar.firstChild.style.background = color;
      ctl.append(sw);
    }
    row.refs.bar = bar.firstChild;
    row.refs.volts = el('span', 'volts', '—');
    row.refs.raw = el('span', 'raw', '');
    ctl.append(bar, row.refs.volts, row.refs.raw);
  }
  syncValue(row, mode, value);
}

function syncValue(row, mode, value) {
  if (mode === MODE.OUTPUT) { row.refs.cb.checked = !!value; row.refs.state.textContent = value ? 'HIGH' : 'LOW'; }
  if (mode === MODE.PWM && document.activeElement !== row.refs.range) {
    row.refs.range.value = value; row.refs.num.textContent = pwmText(value);
  }
}

const pwmText = v => `${v} · ${Math.round(v / 2.55)}%`;
function el(tag, cls, text) { const e = document.createElement(tag); e.className = cls; if (text != null) e.textContent = text; return e; }

function updateInputs({ levels, adc }) {
  if (!link?.board) return;
  const { adcBits, vrefMv } = link.board.hello;
  const full = (1 << adcBits) - 1;
  const now = performance.now();
  link.board.config.forEach((cfg, pin) => {
    const row = rows[pin];
    if (!row || row.kind !== cfg.mode) return;
    const high = (levels >>> pin) & 1;
    if (cfg.mode === MODE.INPUT || cfg.mode === MODE.PULLUP) {
      row.refs.level.textContent = high ? 'HIGH' : 'LOW';
      row.refs.level.classList.toggle('high', !!high);
    } else if (cfg.mode === MODE.OUTPUT) {
      // Read-back check: an output that reads the opposite level is probably shorted or overloaded.
      const bad = now - row.lastWrite > 300 && high !== (cfg.value ? 1 : 0);
      row.refs.mismatch.textContent = bad ? `reads ${high ? 'HIGH' : 'LOW'}!` : '';
    } else if ((cfg.mode === MODE.ANALOG || cfg.mode === MODE.CAPTURE) && row.caps.adcChannel != null) {
      const raw = adc[row.caps.adcChannel];
      if (raw == null) return;
      row.refs.volts.textContent = `${(raw * vrefMv / full / 1000).toFixed(3)} V`;
      row.refs.raw.textContent = raw;
      row.refs.bar.style.width = `${(raw / full) * 100}%`;
    }
  });
}

async function changeMode(pin, mode) {
  try {
    if (mode === MODE.CAPTURE) scope.clearChannel(rows[pin].caps.adcChannel);   // start a fresh trace
    await link.setMode(pin, mode);
  } catch (e) {
    log('error', `${pinLabel(pin, rows[pin].caps)}: could not set ${MODE_NAME[mode]}: ${e.message}`);
    if (link?.board) renderPin(pin, link.board.config[pin]);
  }
}

async function writePin(pin, value, revert) {
  rows[pin].lastWrite = performance.now();
  try {
    await link.write(pin, value);
    if (rows[pin].kind === MODE.OUTPUT) rows[pin].refs.state.textContent = value ? 'HIGH' : 'LOW';
  } catch (e) {
    revert?.();
    log('error', `${pinLabel(pin, rows[pin].caps)}: write failed: ${e.message}`);
  }
}

// PWM slider: send at most one write at a time, always ending on the latest value.
const pwmPending = new Map();
async function pwmSend(pin, value) {
  if (pwmPending.has(pin)) { pwmPending.set(pin, value); return; }
  pwmPending.set(pin, value);
  let last = null;
  while (pwmPending.get(pin) !== last) {
    last = pwmPending.get(pin);
    await writePin(pin, last);
  }
  pwmPending.delete(pin);
}

// ---------------- wiring ----------------
$('btnConnect').onclick = () => (link || transport) ? disconnect() : connect(false);
$('btnChoose').onclick = () => connect(true);
$('btnSafe').onclick = async () => {
  try { await link.resetPins(); log('info', 'All pins set to safe inputs.'); }
  catch (e) { log('error', 'Reset failed: ' + e.message); }
};
$('btnClearLog').onclick = e => { e.preventDefault(); $('log').replaceChildren(); };
$('diag').addEventListener('toggle', renderStats);

if (!('serial' in navigator)) {
  $('noSerial').hidden = false;
  $('btnConnect').disabled = true;
} else {
  navigator.serial.addEventListener('disconnect', e => { if (e.target === port && transport) portLost(null); });
  lastUsedPort().then(p => { if (p) $('portName').textContent = `Last used: ${describePort(p)}`; });
  window.addEventListener('pagehide', () => { link?.stop(); transport?.close(); });
}
setState(LINK.STOPPED);
renderStats();
