// Web Serial transport and port selection for the side panel.
//
// Chrome cannot show its serial port picker inside the side panel (requestPort() rejects at once
// with NotFoundError) or in a popup-type window. So port selection falls back to chooser.html in a
// normal tab. This was found the hard way in the htmlSerialPort project; don't remove it.

export const SERIAL_OPTIONS = { baudRate: 115200, dataBits: 8, parity: 'none', stopBits: 1, flowControl: 'none', bufferSize: 1024 };

const LAST_PORT_KEY = 'chrominator.lastPort';

const VENDORS = {
  0x2341: 'Arduino', 0x2A03: 'Arduino', 0x1A86: 'CH340 (Arduino clone)', 0x0403: 'FTDI',
  0x10C4: 'Silicon Labs CP210x', 0x067B: 'Prolific'
};

export function describePort(port) {
  const { usbVendorId: v, usbProductId: p } = port.getInfo();
  if (v === undefined) return 'Serial port';
  const hex = n => n.toString(16).toUpperCase().padStart(4, '0');
  return `${VENDORS[v] || 'USB serial'} (${hex(v)}:${hex(p ?? 0)})`;
}

const sameDevice = (a, b) => a.usbVendorId === b.usbVendorId && a.usbProductId === b.usbProductId;

function rememberPort(port, ports) {
  try { localStorage.setItem(LAST_PORT_KEY, JSON.stringify({ info: port.getInfo(), index: ports.indexOf(port) })); } catch {}
}

// The port used last time, if it is plugged in and still permitted; otherwise null.
export async function lastUsedPort() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(LAST_PORT_KEY)); } catch {}
  if (!saved) return null;
  const ports = await navigator.serial.getPorts();
  const byIndex = ports[saved.index];
  if (byIndex && sameDevice(byIndex.getInfo(), saved.info)) return byIndex;
  return ports.find(p => sameDevice(p.getInfo(), saved.info)) || null;
}

// Ask the user for a port. Resolves to a SerialPort, or null if they cancelled.
// onError(message) reports a picker failure while the chooser tab stays open.
export async function choosePort(onError) {
  const t0 = performance.now();
  let port = null;
  try {
    port = await navigator.serial.requestPort();
  } catch (e) {
    if (e.name !== 'NotFoundError') throw e;
    if (performance.now() - t0 > 700) return null;     // a real picker was shown and cancelled
    port = await chooseInTab(onError);
  }
  if (port) rememberPort(port, await navigator.serial.getPorts());
  return port;
}

function chooseInTab(onError) {
  return new Promise(resolve => {
    let tabId = null, done = false;
    const finish = port => {
      if (done) return;
      done = true;
      chrome.runtime.onMessage.removeListener(onMsg);
      chrome.tabs.onRemoved.removeListener(onClosed);
      resolve(port);
    };
    const onMsg = async msg => {
      if (msg?.type === 'port-chosen') {
        const ports = await navigator.serial.getPorts();
        const byIndex = ports[msg.index];
        finish(byIndex && sameDevice(byIndex.getInfo(), msg.info) ? byIndex
               : ports.find(p => sameDevice(p.getInfo(), msg.info)) || null);
      } else if (msg?.type === 'port-cancelled') finish(null);
      else if (msg?.type === 'port-error') onError?.(msg.message);
    };
    const onClosed = id => { if (id === tabId) setTimeout(() => finish(null), 300); };
    chrome.runtime.onMessage.addListener(onMsg);
    chrome.tabs.onRemoved.addListener(onClosed);
    chrome.tabs.create({ url: 'chooser.html', active: true })
      .then(t => { tabId = t.id; })
      .catch(e => { onError?.('Could not open the port chooser: ' + e.message); finish(null); });
  });
}

// Owns one open SerialPort: a read loop feeding onData, and write().
export class SerialTransport {
  constructor(port) { this.port = port; this.reader = null; this.writer = null; this.reading = false; }

  async open(onData, onClosed) {
    await this.port.open(SERIAL_OPTIONS);
    this.writer = this.port.writable.getWriter();
    this.reading = true;
    this.loop = this.#readLoop(onData, onClosed);
  }

  write(bytes) {
    if (!this.writer) return Promise.reject(new Error('Port not open'));
    return this.writer.write(bytes);
  }

  async #readLoop(onData, onClosed) {
    let error = null;
    // The outer loop recovers from non-fatal errors (framing, overrun): Chrome supplies a new readable.
    while (this.reading && this.port.readable) {
      this.reader = this.port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value?.length) onData(value);
        }
      } catch (e) {
        error = e;
      } finally {
        this.reader.releaseLock();
        this.reader = null;
      }
    }
    if (this.reading) onClosed?.(error);      // the port went away on its own (e.g. unplugged)
  }

  async close() {
    this.reading = false;
    if (this.reader) { try { await this.reader.cancel(); } catch {} }
    if (this.loop) { try { await this.loop; } catch {} }
    if (this.writer) { try { this.writer.releaseLock(); } catch {} this.writer = null; }
    try { await this.port.close(); } catch {}
  }
}
