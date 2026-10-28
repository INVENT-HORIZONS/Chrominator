// Chrominator link layer: request/reply matching, retries, heartbeat, link-lost detection and
// resynchronisation. Transport-agnostic and free of DOM APIs, so it runs under Node for tests.
//
// A transport is any object with `write(Uint8Array): Promise`. Incoming bytes are handed to
// `link.receive(bytes)`. See docs/PROTOCOL.md for the rules implemented here.

import {
  CMD, REPLY, FLAG, STATUS_TEXT, encodeFrame, FrameParser,
  decodePing, decodeHello, decodeCaps, decodeConfig, decodeReadAll, decodeCapture, PROTO_VERSION, MAX_DATA
} from './protocol.js';

export const LINK = Object.freeze({ CONNECTING: 'connecting', UP: 'up', LOST: 'lost', STOPPED: 'stopped' });

const DEFAULTS = {
  pingMs: 250,          // heartbeat period
  pollMs: 100,          // READ_ALL period
  lostMs: 1000,         // silence before the link is LOST
  timeoutMs: 400,       // per-request timeout
  retries: 2,           // extra attempts for user actions
  helloRetryMs: 300,    // HELLO period while connecting
  helloTimeoutMs: 5000  // give up connecting after this
};

export class ProtocolError extends Error {
  constructor(cmd, status) {
    super(STATUS_TEXT[status] || `Status ${status}`);
    this.cmd = cmd; this.status = status;
  }
}
export class TimeoutError extends Error {}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export class ChrominatorLink extends EventTarget {
  constructor(transport, options = {}) {
    super();
    this.transport = transport;
    this.opt = { ...DEFAULTS, ...options };
    this.parser = new FrameParser(f => this.#onFrame(f));
    this.pending = new Map();      // seq -> { cmd, resolve, reject, timer }
    this.seq = 0;
    this.state = LINK.STOPPED;
    this.lastRx = 0;
    this.board = null;             // { hello, caps[], config[] }
    this.stats = { tx: 0, rx: 0, timeouts: 0, retries: 0, rttMs: null, uptimeMs: null,
                   captureBlocks: 0, captureGaps: 0, captureOverruns: 0, captureDropped: 0 };
    this.capLastBlock = new Map();  // channel -> last block number seen (to count gaps)
    this.timers = [];
    this.resyncing = null;
    this.pollBusy = false;
  }

  // ---------------- public API ----------------
  receive(bytes) { this.parser.push(bytes); }

  async start() {
    this.#setState(LINK.CONNECTING);
    const deadline = Date.now() + this.opt.helloTimeoutMs;
    let hello = null;
    while (!hello && this.state === LINK.CONNECTING && Date.now() < deadline) {
      try { hello = await this.#hello(); }
      catch (e) { if (!(e instanceof TimeoutError)) throw e; await sleep(Math.max(0, this.opt.helloRetryMs - this.opt.timeoutMs)); }
    }
    if (this.state !== LINK.CONNECTING) return false;               // stopped meanwhile
    if (!hello) { this.stop(); throw new Error('No reply from the board. Is the Chrominator firmware loaded?'); }
    if (hello.proto !== PROTO_VERSION) {
      this.stop();
      throw new Error(`The board runs protocol v${hello.proto} but this extension needs v${PROTO_VERSION}. Re-upload the firmware from this version of Chrominator.`);
    }
    await this.#loadBoard(hello);
    this.lastRx = Date.now();
    this.#setState(LINK.UP);
    this.timers.push(setInterval(() => this.#heartbeat(), this.opt.pingMs));
    this.timers.push(setInterval(() => this.#poll(), this.opt.pollMs));
    return true;
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Link stopped')); }
    this.pending.clear();
    this.#setState(LINK.STOPPED);
  }

  async setMode(pin, mode) {
    await this.request(CMD.SET_MODE, [pin, mode], this.opt.retries);
    const ch = this.board.caps[pin]?.adcChannel;
    if (ch != null) this.capLastBlock.delete(ch);     // capture (re)starts: no gap to count
    this.board.config[pin] = { mode, value: 0 };
    this.#emit('config', this.board.config);
  }

  async write(pin, value) {
    await this.request(CMD.WRITE, [pin, value], this.opt.retries);
    this.board.config[pin].value = value;
  }

  // UART: baud and frame format (index into UART_FORMATS). Idempotent, so it is retried.
  async uartConfig(baud, format) {
    await this.request(CMD.UART_CONFIG, [baud & 0xFF, (baud >> 8) & 0xFF, (baud >> 16) & 0xFF, (baud >>> 24) & 0xFF, format], this.opt.retries);
  }

  // UART: send bytes on TX. Sent in frames of up to 48 bytes; NOT retried on a timeout (a retry
  // could send the bytes twice). If the board's queue is full (BUSY) it waits and tries again.
  async uartSend(bytes) {
    for (let i = 0; i < bytes.length; ) {
      const chunk = Array.from(bytes.slice(i, i + MAX_DATA));
      try { await this.request(CMD.UART_TX, chunk, 0); i += chunk.length; }
      catch (e) {
        if (e instanceof ProtocolError && e.status === 8) { await sleep(30); continue; }
        throw e;
      }
    }
  }

  // Speed test: the board streams full-size EVT_BENCH frames for `ms` milliseconds; this counts
  // what arrives. Resolves to { ms, frames, bytes, lost, kBps, boardFrames, boardBytes, boardMs, … }.
  // Throughput counts whole frames on the wire (data + 5 bytes of framing).
  async bench(ms = 3000) {
    if (this.benchRun) throw new Error('A speed test is already running');
    const b = this.benchRun = { frames: 0, bytes: 0, lost: 0, next: null, first: 0, last: 0, done: null };
    const finished = new Promise((resolve, reject) => {
      b.done = resolve;
      b.timer = setTimeout(() => reject(new Error('The board did not finish the speed test (firmware too old?)')), ms + 3000);
    });
    try {
      await this.request(CMD.BENCH, [ms & 0xFF, ms >> 8], this.opt.retries);
      const done = await finished;
      const span = Math.max(1, b.last - b.first);
      return {
        ms: span, frames: b.frames, bytes: b.bytes, lost: b.lost,
        kBps: b.bytes / span,                                   // bytes per ms = kB/s
        boardFrames: done.frames, boardBytes: done.bytes, boardMs: done.us / 1000,
        boardKBps: done.bytes / Math.max(1, done.us / 1000)
      };
    } finally { clearTimeout(b.timer); this.benchRun = null; }
  }

  async resetPins() {
    await this.request(CMD.RESET_PINS, [], this.opt.retries);
    this.board.config = decodeConfig(await this.request(CMD.GET_CONFIG));
    this.#emit('config', this.board.config);
  }

  // Send one request; resolves with the reply DATA (status OK) or throws.
  async request(cmd, data = [], retries = 0) {
    for (let attempt = 0; ; attempt++) {
      try { return await this.#once(cmd, data); }
      catch (e) {
        if (!(e instanceof TimeoutError) || attempt >= retries || this.state === LINK.STOPPED) throw e;
        this.stats.retries++;
      }
    }
  }

  // ---------------- internals ----------------
  #once(cmd, data) {
    return new Promise((resolve, reject) => {
      if (this.state === LINK.STOPPED) return reject(new Error('Link stopped'));
      let seq;
      do { seq = this.seq = (this.seq % 255) + 1; } while (this.pending.has(seq));
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        this.stats.timeouts++;
        reject(new TimeoutError(`No reply to command 0x${cmd.toString(16)}`));
      }, this.opt.timeoutMs);
      this.pending.set(seq, { cmd, resolve, reject, timer, sent: performance.now() });
      this.stats.tx++;
      Promise.resolve(this.transport.write(encodeFrame(seq, cmd, data))).catch(err => {
        clearTimeout(timer); this.pending.delete(seq); reject(err);
      });
    });
  }

  #onFrame({ seq, cmd, data }) {
    this.stats.rx++;
    this.lastRx = Date.now();
    if (this.state === LINK.LOST) {
      this.#setState(LINK.UP);
      this.#log('info', 'Link restored.');
      this.#resync(false);
    }
    if (seq === 0) return this.#onEvent(cmd, data);
    const p = this.pending.get(seq);
    if (!p || cmd !== (p.cmd | REPLY)) return;          // stale or unexpected reply
    this.pending.delete(seq);
    clearTimeout(p.timer);
    p.rtt = performance.now() - p.sent;
    if (data[0] !== 0) p.reject(new ProtocolError(p.cmd, data[0]));
    else { if (p.cmd === CMD.PING) this.stats.rttMs = p.rtt; p.resolve(data); }
  }

  #onEvent(cmd, data) {
    if (cmd === CMD.EVT_CAPTURE) {
      const c = decodeCapture(data);
      this.stats.captureBlocks++;
      const last = this.capLastBlock.get(c.channel);
      if (last != null && ((c.block - last) & 0xFFFF) > 1 && ((c.block - last) & 0xFFFF) < 0x8000) this.stats.captureGaps++;
      this.capLastBlock.set(c.channel, c.block);
      this.#emit('capture', c);
      return;
    }
    if (cmd === CMD.EVT_UART_RX) { this.#emit('uart-rx', data); return; }
    if (cmd === CMD.EVT_BENCH) {
      const b = this.benchRun; if (!b) return;
      const n = (data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24)) >>> 0;
      const now = performance.now();
      if (!b.frames) b.first = now;
      if (b.next != null && n > b.next) b.lost += n - b.next;
      b.next = n + 1; b.frames++; b.bytes += data.length + 5; b.last = now;
      return;
    }
    if (cmd === CMD.EVT_BENCH_DONE) {
      const u32 = i => (data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24)) >>> 0;
      const b = this.benchRun;
      if (b) { if (b.next != null && u32(0) > b.next) b.lost += u32(0) - b.next; b.done({ frames: u32(0), bytes: u32(4), us: u32(8) }); }
      return;
    }
    if (cmd === CMD.EVT_BOOT) {
      this.capLastBlock.clear();
      this.#log('warn', 'Board reset (boot message received).');
      if (this.state === LINK.UP) this.#resync(true);
    } else if (cmd === CMD.EVT_FAILSAFE) {
      this.#log('warn', 'Board failsafe: it lost contact with the extension and set all pins to inputs.');
    }
  }

  async #hello() { return decodeHello(await this.#once(CMD.HELLO, [])); }

  async #loadBoard(hello) {
    const caps = decodeCaps(await this.request(CMD.GET_CAPS, [], this.opt.retries));
    const config = decodeConfig(await this.request(CMD.GET_CONFIG, [], this.opt.retries));
    this.board = { hello, caps, config };
    this.#emit('board', this.board);
  }

  // Re-read the board's state. full = also redo HELLO and capabilities (after a reboot).
  #resync(full) {
    if (this.resyncing) return this.resyncing;
    this.resyncing = (async () => {
      try {
        if (full) await this.#loadBoard(decodeHello(await this.request(CMD.HELLO, [], this.opt.retries)));
        else {
          this.board.config = decodeConfig(await this.request(CMD.GET_CONFIG, [], this.opt.retries));
          this.#emit('config', this.board.config);
        }
      } catch (e) {
        if (this.state !== LINK.STOPPED) this.#log('error', 'Resync failed: ' + e.message);
      } finally { this.resyncing = null; }
    })();
    return this.resyncing;
  }

  async #heartbeat() {
    if (this.state === LINK.UP && Date.now() - this.lastRx > this.opt.lostMs) {
      this.#setState(LINK.LOST);
      this.#log('error', `Link lost: no reply from the board for ${this.opt.lostMs} ms.`);
    }
    try {
      const ping = decodePing(await this.#once(CMD.PING, []));
      this.stats.uptimeMs = ping.uptimeMs;
      this.stats.captureOverruns = ping.captureOverruns;
      this.stats.captureDropped = ping.captureDropped;
      this.#emit('ping', { rttMs: this.stats.rttMs, uptimeMs: ping.uptimeMs, flags: ping.flags });
      if (ping.flags & FLAG.NEEDS_HELLO) { this.#log('warn', 'Board restarted; reloading its state.'); this.#resync(true); }
      else if (ping.flags & FLAG.FAILSAFE) this.#resync(false);
    } catch { /* missed heartbeat: counted in stats.timeouts; LOST is decided above */ }
  }

  async #poll() {
    if (this.state !== LINK.UP || this.pollBusy || this.resyncing) return;
    this.pollBusy = true;
    try { this.#emit('inputs', decodeReadAll(await this.#once(CMD.READ_ALL, []))); }
    catch { /* a missed poll is harmless */ }
    finally { this.pollBusy = false; }
  }

  #setState(s) { if (this.state !== s) { this.state = s; this.#emit('state', s); } }
  #emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  #log(level, message) { this.#emit('log', { level, message }); }
}
