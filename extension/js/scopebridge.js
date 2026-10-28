// Side-panel end of the pop-out oscilloscope windows (scope.html?ch=N). The side panel owns the
// serial link; each pop-out gets its channel's capture blocks over a BroadcastChannel:
//
//   panel -> window: { type: 'status', ch, hello, active, name, color }   every second and on change
//                    { type: 'block', ch, block }                         each EVT_CAPTURE block
//                    { type: 'history', ch, blocks: [...] }               answer to 'hello'
//                    { type: 'close' }                                    disconnected: close every pop-out
//   window -> panel: { type: 'hello', ch, id }   a view opened (send history + status)
//                    { type: 'bye', ch, id }     a view closed
//
// The main Oscilloscope panel keeps drawing the channel as before; a pop-out is an extra view with
// its own timebase, scale, pause and CSV. A short history is kept so a new window starts filled.

export const SCOPE_CHANNEL = 'chrominator-scope';
const HISTORY_BLOCKS = 4096;                 // per channel: ~5.5 min at 80 ms blocks, ~2 min on the Uno

export class ScopeBridge {
  constructor({ status }) {
    this.getStatus = status;                 // ch -> { hello, active, name, color }
    this.history = new Map();                // ch -> blocks
    this.windows = new Map();                // ch -> id of a regular pop-out window (fallback)
    this.views = new Map();                  // view id -> ch: every open view, wherever it lives
    this.ch = new BroadcastChannel(SCOPE_CHANNEL);
    this.ch.onmessage = e => {
      const m = e.data;
      if (m?.type === 'hello') {
        this.views.set(m.id, m.ch);
        this.ch.postMessage({ type: 'history', ch: m.ch, id: m.id, blocks: this.history.get(m.ch) || [] });
        this.status(m.ch);
      } else if (m?.type === 'bye') this.views.delete(m.id);
    };
    setInterval(() => this.statusAll(), 1000);
    globalThis.chrome?.windows?.onRemoved.addListener(id => {
      for (const [ch, w] of this.windows) if (w === id) this.windows.delete(ch);
    });
  }

  async open(ch) {
    const id = this.windows.get(ch);
    if (id != null) {
      try { await chrome.windows.update(id, { focused: true }); return; } catch { this.windows.delete(ch); }
    }
    const w = await chrome.windows.create({ url: chrome.runtime.getURL(`scope.html?ch=${ch}`), type: 'popup', width: 820, height: 440 });
    this.windows.set(ch, w.id);
  }

  block(b) {
    let h = this.history.get(b.channel);
    if (!h) this.history.set(b.channel, h = []);
    h.push(b);
    if (h.length > HISTORY_BLOCKS) h.splice(0, h.length - HISTORY_BLOCKS);
    if (this.#watched(b.channel)) this.ch.postMessage({ type: 'block', ch: b.channel, block: b });
  }

  // Disconnected: close every pop-out window. Windows
  // this side panel opened are removed directly; 'close' also reaches any others (e.g. opened by an
  // earlier side panel session), which close themselves.
  closeAll() {
    for (const id of this.windows.values()) chrome.windows.remove(id).catch(() => {});
    this.windows.clear();
    this.views.clear();
    this.ch.postMessage({ type: 'close' });
  }

  // Forget a channel's history (it left capture mode, or the board changed).
  clear(ch) { if (ch == null) this.history.clear(); else this.history.delete(ch); }

  #watched(ch) { for (const c of this.views.values()) if (c === ch) return true; return false; }
  status(ch) { this.ch.postMessage({ type: 'status', ch, ...this.getStatus(ch) }); }
  statusAll() { for (const ch of new Set(this.views.values())) this.status(ch); }
}
