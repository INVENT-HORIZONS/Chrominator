// Side-panel end of the UART terminal. The side panel owns the serial link, so the terminal window
// (terminal.html) talks to it over a BroadcastChannel:
//
//   panel -> window: { type: 'status', ...status }   every second and on any change
//                    { type: 'data', dir: 'rx'|'tx', bytes: [...], t }
//                    { type: 'history', entries: [{ dir, bytes, t }, ...] }   answer to 'hello'
//   window -> panel: { type: 'hello' }                 window opened: send history + status
//                    { type: 'send', id, bytes: [...] } -> { type: 'sent', id, error? }
//                    { type: 'clear' }                 forget the history
//
// TX data is shown once the board has accepted it; RX data as it arrives. A short history is kept
// here so the window shows recent traffic when it is opened (or reopened).

export const TERM_CHANNEL = 'chrominator-uart';
const HISTORY_BYTES = 256 * 1024;

export class TerminalBridge {
  constructor({ status, send }) {
    this.getStatus = status;
    this.sendBytes = send;
    this.history = [];
    this.historyBytes = 0;
    this.windowId = null;
    this.ch = new BroadcastChannel(TERM_CHANNEL);
    this.ch.onmessage = e => this.#onMessage(e.data);
    setInterval(() => this.status(), 1000);
    globalThis.chrome?.windows?.onRemoved.addListener(id => { if (id === this.windowId) this.windowId = null; });
  }

  // Open the terminal window, or bring it to the front if it is already open.
  async open() {
    if (this.windowId != null) {
      try { await chrome.windows.update(this.windowId, { focused: true }); return; }
      catch { this.windowId = null; }
    }
    const w = await chrome.windows.create({ url: chrome.runtime.getURL('terminal.html'), type: 'popup', width: 760, height: 520 });
    this.windowId = w.id;
  }

  data(dir, bytes) {
    const entry = { dir, bytes: Array.from(bytes), t: Date.now() };
    this.history.push(entry);
    this.historyBytes += entry.bytes.length;
    while (this.historyBytes > HISTORY_BYTES && this.history.length > 1) this.historyBytes -= this.history.shift().bytes.length;
    this.ch.postMessage({ type: 'data', ...entry });
  }

  status() { this.ch.postMessage({ type: 'status', ...this.getStatus() }); }

  async #onMessage(m) {
    if (m?.type === 'hello') {
      this.ch.postMessage({ type: 'history', entries: this.history });
      this.status();
    } else if (m?.type === 'clear') {
      this.history = []; this.historyBytes = 0;
    } else if (m?.type === 'send') {
      // One send at a time, in arrival order: in live mode every key is its own message, and a
      // send that has to wait (board queue BUSY) must not let a later key overtake it.
      this.queue = (this.queue || Promise.resolve()).then(async () => {
        try {
          await this.sendBytes(Uint8Array.from(m.bytes));
          this.data('tx', m.bytes);
          this.ch.postMessage({ type: 'sent', id: m.id });
        } catch (e) {
          this.ch.postMessage({ type: 'sent', id: m.id, error: e.message });
        }
      });
    }
  }
}
