// Chrominator side panel UI: connection handling and the pin table.
import { MODE, MODE_NAME, CAP, UART_FORMATS, pinLabel } from './protocol.js';
import { TerminalBridge } from './termbridge.js';
import { ScopeBridge } from './scopebridge.js';
import { ChrominatorLink, LINK } from './link.js';
import { SerialTransport, choosePort, lastUsedPort, describePort } from './serial.js';
import { Scope, TRACE_COLORS } from './scope.js';

const $ = id => document.getElementById(id);
const MAX_LOG = 300;

let transport = null, link = null, port = null, busy = false;
let rows = [];                     // per pin: { el, select, ctl, kind, refs, lastWrite }

// ---------------- buses ----------------
// Pins each bus takes over, by board ID. The Uno R3/R4 and Nano R4 all put I²C on A4/A5 and SPI on
// D10-D13. (The Nano R4's Qwiic connector is a second, 3.3 V I²C bus on its own pins.)
const HEADER_BUSES = {
  i2c: { name: 'I²C', pins: [[18, 'SDA'], [19, 'SCL']] },
  spi: { name: 'SPI', pins: [[13, 'SCK'], [11, 'MOSI'], [12, 'MISO'], [10, 'SS']] }
};
const BOARD_BUSES = { 1: HEADER_BUSES, 2: HEADER_BUSES, 3: HEADER_BUSES, 4: HEADER_BUSES };
let buses = HEADER_BUSES;
// Digital-to-analog converter per board ID, for the Generator panel (Uno R4s and Nano R4: 12-bit on A0).
const BOARD_DAC = { 2: '12-bit DAC on A0', 3: '12-bit DAC on A0', 4: '12-bit DAC on A0' };
const busOn = { i2c: false, spi: false };     // UI state only for now; the board isn't told yet

// UART pins by board ID (Uno R4s and Nano R4: Serial1 on D0 RX / D1 TX; USB is native, so they're free).
// The board owns the state: a pin is in UART mode when its mode is UART_RX / UART_TX (protocol), and
// the board only accepts those modes on pins whose caps have CAP.UART (Nano R4 firmware 1.6+).
// RX and TX are independent: often only TX is used and RX's pin does something else.
const HEADER_UART = { rx: 0, tx: 1 };
const BOARD_UART = { 2: HEADER_UART, 3: HEADER_UART, 4: HEADER_UART };
let uart = null;                                    // { rx: pin, tx: pin } if this board can do UART, else null
const UART_ROLE = { rx: 'RX', tx: 'TX' };
const UART_ID = { rx: 'Rx', tx: 'Tx' };          // element ids: uartRxOn, uartTxRow, uartRxPin…
const UART_MODE = { rx: MODE.UART_RX, tx: MODE.UART_TX };
const UART_PREFS = 'chrominator.uart';            // { baud, format } remembered per viewer

function uartRole(pin) {
  const m = link?.board?.config[pin]?.mode;
  return m === MODE.UART_RX ? 'rx' : m === MODE.UART_TX ? 'tx' : null;
}
function uartIsOn(r) { return !!uart && link?.board?.config[uart[r]]?.mode === UART_MODE[r]; }

function busOwner(pin) {
  for (const [id, bus] of Object.entries(buses)) {
    if (!busOn[id]) continue;
    const hit = bus.pins.find(([p]) => p === pin);
    if (hit) return { id, name: bus.name, role: hit[1] };
  }
  return null;
}

// Timebase: ◀ / ▶ step through the (hidden) scopeWindow options, 1 s … 2 min across the screen.
function stepTimebase(d) {
  const sel = $('scopeWindow');
  const i = Math.min(sel.options.length - 1, Math.max(0, sel.selectedIndex + d));
  if (i !== sel.selectedIndex) { sel.selectedIndex = i; sel.dispatchEvent(new Event('change')); }
  syncTimebase();
}
function syncTimebase() {
  const sel = $('scopeWindow');
  $('tbValue').textContent = sel.options[sel.selectedIndex].text;
  $('tbLess').disabled = sel.selectedIndex === 0;
  $('tbMore').disabled = sel.selectedIndex === sel.options.length - 1;
}
$('tbLess').addEventListener('click', () => stepTimebase(-1));
$('tbMore').addEventListener('click', () => stepTimebase(1));
syncTimebase();

// Terminal window: TX (red) and RX (green) traffic of the UART. The side panel owns the serial link;
// the window talks to it through TerminalBridge (BroadcastChannel).
const term = new TerminalBridge({
  status: () => ({
    connected: !!(link?.board && uart),
    rx: uartIsOn('rx'), tx: uartIsOn('tx'),
    rxPin: uart ? pinLabel(uart.rx, rows[uart.rx]?.caps) : 'D0',
    txPin: uart ? pinLabel(uart.tx, rows[uart.tx]?.caps) : 'D1',
    baud: +$('uartBaud').value, format: UART_FORMATS[+$('uartFormat').value] || '8N1'
  }),
  send: async bytes => {
    if (!uartIsOn('tx')) throw new Error('UART TX is off');
    await link.uartSend(bytes);
  }
});

// Pop-out oscilloscope windows (experiment: only A0 has the button for now). The channel keeps
// drawing in the side panel too; the window gets its blocks through ScopeBridge.
const POPOUT_CHANNELS = [0, 1];
const adcPin = ch => rows.findIndex(r => r?.caps.adcChannel === ch);
const scopeBridge = new ScopeBridge({
  status: ch => {
    const pin = adcPin(ch);
    return {
      hello: link?.board?.hello || null,
      active: pin >= 0 && link?.board?.config[pin]?.mode === MODE.CAPTURE,
      name: pin >= 0 ? netNames[pin] || '' : ''
    };
  }
});

// Pop out: the channel in its own regular window (scope.html); it keeps drawing here too.
function popOut(ch) {
  scopeBridge.open(ch)
    .then(() => log('info', `A${ch} popped out.`))
    .catch(e => log('error', `Pop out: ${e.message}`));
}

const scope = new Scope({
  canvas: $('scopeCanvas'), legend: $('scopeLegend'), rateLabel: $('scopeRate'),
  windowSelect: $('scopeWindow'), rangeSelect: $('scopeRange'),
  runButton: $('scopeRun'), clearButton: $('scopeClear'), saveButton: $('scopeSave'),
  onStop: ch => {                           // ✕ on a trace: stop capturing, pin goes back to Analog
    const pin = rows.findIndex(r => r?.caps.adcChannel === ch);
    if (pin >= 0 && link) changeMode(pin, MODE.ANALOG);
  }
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

// Speed test: board -> Chrome throughput over the real link (Diagnostics panel).
const BENCH_MS = 3000;
async function runBench() {
  if (!link?.board) return;
  const btn = $('btnBench'), out = $('benchResult');
  btn.disabled = true;
  out.textContent = `Running for ${BENCH_MS / 1000} s…`;
  try {
    const r = await link.bench(BENCH_MS);
    const kB = r.kBps >= 100 ? r.kBps.toFixed(0) : r.kBps.toFixed(1);
    out.innerHTML = '';
    const b = document.createElement('b'); b.textContent = `${kB} kB/s`;
    out.append(b, ` board → Chrome · ${r.frames.toLocaleString()} frames of 53 bytes in ${(r.ms / 1000).toFixed(2)} s · ${r.lost ? `${r.lost} lost` : 'none lost'}`);
    log('info', `Speed test: ${kB} kB/s board → Chrome (${r.frames} frames, ${r.lost} lost; board sent ${r.boardFrames} in ${r.boardMs.toFixed(0)} ms).`);
  } catch (e) {
    out.textContent = `Speed test failed: ${e.message}`;
    log('error', `Speed test failed: ${e.message}`);
  } finally { btn.disabled = !link?.board; }
}
$('btnBench').addEventListener('click', runBench);

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
// ADC channels put on the Oscilloscope when the extension connects (A0 and A1), on boards that can
// capture. Only done at connect: after that, the user's choices stand.
const STARTUP_SCOPE_CHANNELS = [0, 1];

async function startupScope() {
  if (!link?.board?.hello.capturePeriodUs) return;
  const { caps, config } = link.board;
  for (const ch of STARTUP_SCOPE_CHANNELS) {
    const pin = caps.findIndex(c => c.adcChannel === ch);
    if (pin < 0 || !(caps[pin].caps & CAP.CAPTURE) || config[pin].mode === MODE.CAPTURE) continue;
    if (config[pin].mode !== MODE.INPUT || busOwner(pin) || uartRole(pin)) continue;   // in use: leave it
    await changeMode(pin, MODE.CAPTURE);
  }
}
const STATE_TEXT = { stopped: 'Disconnected', connecting: 'Connecting…', up: 'Connected', lost: 'Link lost' };

function setState(state) {
  $('linkPill').dataset.state = state;
  $('linkPill').textContent = STATE_TEXT[state];
  $('eye').classList.toggle('on', state === LINK.UP);
  $('pinsSection').classList.toggle('offline', state !== LINK.UP);
  for (const sec of document.querySelectorAll('section.buses')) sec.classList.toggle('offline', state !== LINK.UP);
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
    link.addEventListener('capture', e => { scope.add(e.detail); scopeBridge.block(e.detail); });
    link.addEventListener('uart-rx', e => term.data('rx', e.detail));
    try {
      await link.start();
    } catch (e) {
      log('error', e.message);
      await disconnect(false);
      return;
    }
    await startupScope();
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
  for (const sec of document.querySelectorAll('section.buses')) sec.hidden = true;
  $('genSection').hidden = true;
  uart = null;
  syncUartControls();
  $('scopeSection').hidden = true;
  $('btnBench').disabled = true;
  // Close every pop-out: oscilloscope windows and the terminal.
  scopeBridge.closeAll();
  term.closeAll();
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
// ---------------- net names ----------------
// A short name per pin for the circuit net it is wired to, saved per board ID in localStorage.
const NET_KEY = id => `chrominator.netNames.${id}`;
let netNames = {}, netBoardId = null;
function loadNetNames(boardId) {
  netBoardId = boardId;
  try { netNames = JSON.parse(localStorage.getItem(NET_KEY(boardId))) || {}; } catch { netNames = {}; }
}
function setNetName(pin, name) {
  name = name.trim().slice(0, 16);
  if (name) netNames[pin] = name; else delete netNames[pin];
  try { localStorage.setItem(NET_KEY(netBoardId), JSON.stringify(netNames)); } catch {}
  if (rows[pin]) rows[pin].el.querySelector('.net').value = name;
  scope.setNames(adcNames());
  scopeBridge.statusAll();
}
// ADC channel -> net name, for the Oscilloscope legend and CSV.
function adcNames() {
  const m = {};
  rows.forEach((r, pin) => { if (r?.caps.adcChannel != null && netNames[pin]) m[r.caps.adcChannel] = netNames[pin]; });
  return m;
}

function buildPins({ hello, caps, config }) {
  loadNetNames(hello.boardId);
  $('btnBench').disabled = false;
  scopeBridge.clear();
  $('boardInfo').textContent = `${hello.boardName} · firmware ${hello.fwMajor}.${hello.fwMinor} · ${hello.adcBits}-bit ADC`;
  scope.setBoard(hello);
  const tpl = $('pinRow');
  rows = caps.map((c, pin) => {
    const el = tpl.content.firstElementChild.cloneNode(true);
    const label = el.querySelector('.label');
    label.textContent = pinLabel(pin, c);
    if (c.caps & CAP.PWM) label.insertAdjacentHTML('beforeend', '<sup>~</sup>');
    // A-pins carry their channel's colour, the same one their trace uses on the Capture panel.
    if (c.adcChannel != null) { label.classList.add('adc'); label.style.setProperty('--c', TRACE_COLORS[c.adcChannel % TRACE_COLORS.length]); }
    const select = el.querySelector('select');
    const ctl = el.querySelector('.ctl');
    // Net name: remembered per board type (same pin numbers on the same board mean the same wiring).
    const net = el.querySelector('.net');
    net.value = netNames[pin] || '';
    net.title = `Name for ${pinLabel(pin, c)}: what it's connected to, e.g. VBAT or LED_EN`;
    net.addEventListener('change', () => setNetName(pin, net.value));
    net.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === 'Escape') { if (e.key === 'Escape') net.value = netNames[pin] || ''; net.blur(); } });
    const row = { el, select, ctl, caps: c, kind: null, refs: {}, lastWrite: 0 };
    if (c.caps & CAP.RESERVED) {
      el.classList.add('reserved');
      select.replaceWith(Object.assign(document.createElement('span'), { className: 'note', textContent: 'Serial' }));
      ctl.innerHTML = '<span class="note">Used by the USB link</span>';
    } else {
      const allowed = [[MODE.INPUT, CAP.DIN], [MODE.PULLUP, CAP.PULLUP], [MODE.OUTPUT, CAP.DOUT],
                       [MODE.PWM, CAP.PWM], [MODE.ANALOG, CAP.ADC], [MODE.CAPTURE, CAP.CAPTURE]];
      for (const [m, need] of allowed) if (c.caps & need) select.add(new Option(MODE_NAME[m], m));
      const ub = BOARD_UART[hello.boardId];
      if (ub && (c.caps & CAP.UART)) for (const r of ['rx', 'tx']) if (ub[r] === pin) select.add(new Option(MODE_NAME[UART_MODE[r]], UART_MODE[r]));
      select.addEventListener('change', () => changeMode(pin, +select.value));
    }
    return row;
  });
  $('pinList').replaceChildren(...rows.map(r => r.el));
  scope.setNames(adcNames());
  $('pinsSection').hidden = false;
  buses = BOARD_BUSES[hello.boardId] || HEADER_BUSES;
  for (const [id, bus] of Object.entries(buses)) {
    $(`${id}Pins`).textContent = bus.pins.map(([p, role]) => `${role}\u00A0${pinLabel(p, caps[p])}`).join(' · ');
    syncBusControls(id);
  }
  uart = BOARD_UART[hello.boardId] && caps[BOARD_UART[hello.boardId].rx]?.caps & CAP.UART ? BOARD_UART[hello.boardId] : null;
  for (const r of ['rx', 'tx']) {
    $(`uart${UART_ID[r]}Pin`).textContent = uart ? pinLabel(uart[r], caps[uart[r]]) : '—';
  }
  $('uartNote').textContent = uart
    ? 'RX and TX are independent: turn on just TX and RX\'s pin stays free for anything else. Open the terminal to see the traffic: TX in red, RX in green.'
    : BOARD_UART[hello.boardId]
      ? `${hello.boardName} firmware ${hello.fwMajor}.${hello.fwMinor} has no UART bridge. Upload the sketch from this version of Chrominator.`
      : `${hello.boardName}: D0/D1 carry the USB link, so there is no free UART.`;
  if (uart) sendUartConfig();
  syncUartControls();
  for (const sec of document.querySelectorAll('section.buses')) sec.hidden = false;
  // Generator (DAC) panel: a placeholder for now; nothing drives the DAC yet.
  const dac = BOARD_DAC[hello.boardId];
  $('genInfo').textContent = dac
    ? `Output: ${dac}. Generator controls aren't wired up yet.`
    : `${hello.boardName} has no DAC.`;
  $('genSection').hidden = false;
  renderAllPins(config);
}

function syncBusControls(id) {
  $(`${id}On`).checked = busOn[id];
  $(id === 'i2c' ? 'busI2c' : 'busSpi').classList.toggle('on', busOn[id]);
  document.querySelectorAll(`#${id === 'i2c' ? 'busI2c' : 'busSpi'} .busopts select`).forEach(sel => { sel.disabled = !busOn[id]; });
}

function syncUartControls() {
  for (const r of ['rx', 'tx']) {
    $(`uart${UART_ID[r]}On`).checked = uartIsOn(r);
    $(`uart${UART_ID[r]}On`).disabled = !uart;
    $(`uart${UART_ID[r]}Row`).classList.toggle('on', uartIsOn(r));
  }
  $('uartBaud').disabled = !uart; $('uartFormat').disabled = !uart;
  $('uartTerm').disabled = !uart;
  term.status();
}

function loadUartPrefs() {
  try { const p = JSON.parse(localStorage.getItem(UART_PREFS)); if (p) { $('uartBaud').value = p.baud; $('uartFormat').value = p.format; } } catch {}
  if (!$('uartBaud').value) $('uartBaud').value = '9600';
  if (!$('uartFormat').value) $('uartFormat').value = '0';
}
async function sendUartConfig() {
  const baud = +$('uartBaud').value, format = +$('uartFormat').value;
  try { localStorage.setItem(UART_PREFS, JSON.stringify({ baud, format })); } catch {}
  term.status();
  if (!uart || !link?.board) return;
  try { await link.uartConfig(baud, format); }
  catch (e) { log('error', `UART: could not set ${baud} ${UART_FORMATS[format]}: ${e.message}`); }
}

// Switch the UART's RX or TX on or off. Only that one pin is affected.
// (The board switches the UART itself when the pin's mode changes; off means back to a plain input.)
async function setUart(r, on) {
  if (!uart || !link?.board) return;
  const pin = uart[r], label = pinLabel(pin, rows[pin]?.caps);
  try {
    await link.setMode(pin, on ? UART_MODE[r] : MODE.INPUT);
    log('info', on ? `UART ${UART_ROLE[r]} on (${label}).` : `UART ${UART_ROLE[r]} off: ${label} is a plain input again.`);
  } catch (e) {
    log('error', `UART ${UART_ROLE[r]}: could not switch ${on ? 'on' : 'off'}: ${e.message}`);
    syncUartControls();
  }
}

async function setBus(id, on) {
  const bus = buses[id];
  if (on && link?.board) {
    // Hand the pins over in a known state: anything driving or capturing goes back to a plain input.
    for (const [pin] of bus.pins) {
      if (link.board.config[pin].mode === MODE.INPUT) continue;
      try { await link.setMode(pin, MODE.INPUT); }
      catch (e) { log('error', `${bus.name}: could not release ${pinLabel(pin, rows[pin].caps)}: ${e.message}`); }
    }
  }
  busOn[id] = on;
  syncBusControls(id);
  for (const [pin] of bus.pins) if (rows[pin]) rows[pin].kind = null;     // force the rows to redraw
  if (link?.board) renderAllPins(link.board.config);
  const list = bus.pins.map(([p, role]) => `${pinLabel(p, rows[p]?.caps)} (${role})`).join(', ');
  log('info', on ? `${bus.name} on: ${list} reserved for the bus.` : `${bus.name} off: ${list} available again.`);
}

function renderAllPins(config) {
  config.forEach((cfg, pin) => { if (rows[pin] && !(rows[pin].caps.caps & CAP.RESERVED)) renderPin(pin, cfg); });
  syncUartControls();
  // The Capture panel shows every ADC channel in Capture mode, overlaid. It is always visible while
  // connected: with a hint until a pin is set to Capture, or a note if the firmware can't capture.
  const capturing = config.flatMap((cfg, pin) =>
    cfg.mode === MODE.CAPTURE && rows[pin]?.caps.adcChannel != null ? [rows[pin].caps.adcChannel] : []);
  scope.setActive(capturing);
  scopeBridge.statusAll();
  $('scopeSection').hidden = !link?.board;
}

function renderPin(pin, { mode, value }) {
  const row = rows[pin];
  // A UART pin: label and badge turn TX red / RX green (same colours as the terminal); the dropdown
  // stays usable to switch it back to GPIO.
  const ur = mode === MODE.UART_RX ? 'rx' : mode === MODE.UART_TX ? 'tx' : null;
  const label = row.el.querySelector('.label');
  label.classList.toggle('uart-rx', ur === 'rx');
  label.classList.toggle('uart-tx', ur === 'tx');
  if (ur) {
    row.el.classList.remove('onbus');
    row.select.disabled = false;
    row.select.value = mode;
    if (row.kind === mode) return;
    row.kind = mode;
    row.refs = {};
    row.ctl.replaceChildren(el('span', `busrole uart-${ur}`, `UART ${UART_ROLE[ur]}`));
    return;
  }
  row.select.value = mode;
  const owner = busOwner(pin);
  row.el.classList.toggle('onbus', !!owner);
  row.select.disabled = !!owner;
  // A capturing pin belongs to the Capture panel: greyed out here, stopped from its legend.
  if (!owner && mode === MODE.CAPTURE) {
    row.el.classList.add('onbus');
    row.select.disabled = true;
    if (row.kind === 'capture') return;
    row.kind = 'capture';
    row.refs = {};
    const ch = row.caps.adcChannel;
    const badge = el('span', 'busrole capture', 'Oscilloscope');     // the colour square shows its trace
    badge.style.setProperty('--c', TRACE_COLORS[ch % TRACE_COLORS.length]);
    badge.title = 'Drawn on the Oscilloscope panel. Stop it with the ✕ next to this trace there.';
    row.ctl.replaceChildren(badge);
    if (POPOUT_CHANNELS.includes(ch)) {
      // Room is tight: the button replaces the word, keeping the colour square.
      badge.textContent = '';
      badge.classList.add('dot');
      const pop = el('button', 'popout', 'Pop out');
      pop.type = 'button';
      pop.title = `Open A${ch} in its own oscilloscope window (it keeps showing here too)`;
      pop.addEventListener('click', () => popOut(ch));
      row.ctl.append(pop);
    }
    return;
  }
  if (owner) {
    const kind = `bus:${owner.id}`;
    if (row.kind === kind) return;
    row.kind = kind;
    row.refs = {};
    row.ctl.replaceChildren(el('span', 'busrole', `${owner.name} ${owner.role}`));
    return;
  }
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
  } else if (mode === MODE.ANALOG) {
    const bar = el('span', 'bar'); bar.append(document.createElement('i'));
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
    } else if (cfg.mode === MODE.ANALOG && row.caps.adcChannel != null) {
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
    if (mode === MODE.CAPTURE) { scope.clearChannel(rows[pin].caps.adcChannel); scopeBridge.clear(rows[pin].caps.adcChannel); }   // start a fresh trace
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

// ---------------- light / dark theme ----------------
// The ☀/☾ switch sets html[data-theme] and remembers it (js/theme.js applies it at load).
// Dark is the default until the user picks one.
const THEME_KEY = 'chrominator.theme';
const systemDark = matchMedia('(prefers-color-scheme: dark)');
function currentTheme() { return document.documentElement.dataset.theme || (systemDark.matches ? 'dark' : 'light'); }
function syncThemeSwitch() {
  const t = currentTheme();
  $('themeLight').setAttribute('aria-pressed', String(t === 'light'));
  $('themeDark').setAttribute('aria-pressed', String(t === 'dark'));
}
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem(THEME_KEY, t); } catch {}
  syncThemeSwitch();
  scope.redraw();
}
$('themeLight').addEventListener('click', () => setTheme('light'));
$('themeDark').addEventListener('click', () => setTheme('dark'));
systemDark.addEventListener('change', syncThemeSwitch);
syncThemeSwitch();

// ---------------- wiring ----------------
$('btnConnect').onclick = () => (link || transport) ? disconnect() : connect(false);
$('btnChoose').onclick = () => connect(true);
$('btnSafe').onclick = async () => {
  try { await link.resetPins(); log('info', 'All pins set to safe inputs.'); }
  catch (e) { log('error', 'Reset failed: ' + e.message); }
};
// ---------------- collapsible panels ----------------
// Oscilloscope, Generator, Pins, UART, I²C Port and SPI Port fold up from their heading; Diagnostics and Event log are <details>.
// Header controls (All pins safe, scope settings) stay usable while a panel is folded.
// Folded/open state is remembered per viewer in localStorage.
const FOLD_KEY = 'chrominator.folded';
function loadFolds() { try { return JSON.parse(localStorage.getItem(FOLD_KEY)) || {}; } catch { return {}; } }
function saveFold(id, folded) {
  const f = loadFolds(); f[id] = folded;
  try { localStorage.setItem(FOLD_KEY, JSON.stringify(f)); } catch {}
}
function initCollapsibles() {
  const folds = loadFolds();
  for (const sec of document.querySelectorAll('section.buses, section.pins, section.scope, section.gen')) {
    const h2 = sec.querySelector('.sectionhead h2');
    const btn = Object.assign(document.createElement('button'), { type: 'button', className: 'fold' });
    btn.title = 'Show or hide this panel';
    h2.replaceWith(btn);
    btn.append(h2);
    const apply = folded => {
      sec.classList.toggle('folded', folded);
      btn.setAttribute('aria-expanded', String(!folded));
    };
    apply(!!folds[sec.id]);
    btn.addEventListener('click', () => { const f = !sec.classList.contains('folded'); apply(f); saveFold(sec.id, f); });
  }
  for (const d of document.querySelectorAll('details.diag, details.logbox')) {
    const id = d.id || d.className;
    if (id in folds) d.open = !folds[id];
    d.addEventListener('toggle', () => saveFold(id, !d.open));
  }
}
initCollapsibles();

loadUartPrefs();
$('uartBaud').addEventListener('change', sendUartConfig);
$('uartFormat').addEventListener('change', sendUartConfig);
$('uartTerm').addEventListener('click', () => term.open());
$('uartRxOn').addEventListener('change', e => setUart('rx', e.target.checked));
$('uartTxOn').addEventListener('change', e => setUart('tx', e.target.checked));
$('i2cOn').addEventListener('change', e => setBus('i2c', e.target.checked));
$('spiOn').addEventListener('change', e => setBus('spi', e.target.checked));
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
