// Chrominator Burst panel: arms a fast single-channel capture on the board, waits for the
// trigger, and draws the result with the trigger point at t = 0.
import { BURST_RATES, TRIGGER, pinLabel } from './protocol.js';

const $ = id => document.getElementById(id);

export class BurstPanel {
  // ctx: { getLink(), log(level, msg), isUsable(pin) -> bool }
  constructor(ctx) {
    this.ctx = ctx;
    this.canvas = $('burstCanvas');
    this.g = this.canvas.getContext('2d');
    this.last = null;            // last good burst
    this.armed = false;          // a burst is armed or running on the board
    this.repeat = false;
    this.adcPins = [];           // [{ pin, ch, label }]

    for (const r of BURST_RATES) $('burstRate').add(new Option(r.label, r.code));
    $('burstArm').addEventListener('click', () => this.arm());
    $('burstStop').addEventListener('click', () => this.stop());
    $('burstTrig').addEventListener('change', () => this.#syncTrigControls());
    $('burstRange').addEventListener('change', () => this.draw());
    $('burstSave').addEventListener('click', () => this.saveCsv());
    new ResizeObserver(() => this.draw()).observe(this.canvas);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.draw());
    this.#syncTrigControls();
  }

  // ---------- board lifecycle ----------
  setBoard({ hello, caps }) {
    this.hello = hello;
    this.adcPins = caps.flatMap((c, pin) => c.adcChannel != null ? [{ pin, ch: c.adcChannel, label: pinLabel(pin, c) }] : []);
    const sel = $('burstCh');
    const keep = sel.value;
    sel.replaceChildren(...this.adcPins.map(p => new Option(p.label, p.ch)));
    if (keep !== '' && this.adcPins.some(p => String(p.ch) === keep)) sel.value = keep;
    $('burstLevel').max = (hello.vrefMv / 1000).toFixed(2);
    this.armed = false; this.repeat = false;
    this.#setStatus('Ready.');
    this.#syncButtons();
    this.draw();
  }

  // Disable channels whose pin is driving an output or belongs to a bus.
  refreshChannels() {
    for (const opt of $('burstCh').options) {
      const p = this.adcPins.find(a => String(a.ch) === opt.value);
      opt.disabled = !p || !this.ctx.isUsable(p.pin);
    }
  }

  disconnected() {
    this.armed = false; this.repeat = false;
    this.#syncButtons();
    this.#setStatus('Not connected.');
  }

  // ---------- arming ----------
  async arm() {
    const link = this.ctx.getLink();
    if (!link?.board) return;
    const opts = this.#options();
    this.repeat = $('burstRepeat').checked;
    this.armed = true;
    this.#syncButtons();
    const rate = BURST_RATES.find(r => r.code === opts.rate);
    const what = opts.trigger === TRIGGER.NONE ? 'capturing' :
      `armed: waiting for a ${opts.trigger === TRIGGER.RISING ? 'rising' : 'falling'} edge through ${(+$('burstLevel').value).toFixed(2)} V`;
    this.#setStatus(`A${opts.channel} ${what}…`, 'busy');
    try {
      await link.startBurst(opts);
      this.armedOpts = { ...opts, rate };
    } catch (e) {
      this.armed = false; this.repeat = false;
      this.#syncButtons();
      this.#setStatus('Could not start: ' + e.message, 'err');
      this.ctx.log('error', 'Burst: ' + e.message);
    }
  }

  async stop() {
    this.repeat = false;
    if (!this.armed) return;
    this.armed = false;
    this.#syncButtons();
    try { await this.ctx.getLink()?.cancelBurst(); } catch {}
    this.#setStatus('Stopped.');
  }

  // 'burst' event from the link
  onBurst(b) {
    if (!this.armed) return;                          // stopped meanwhile
    this.armed = false;
    if (b.ok) {
      this.last = { ...b, level: this.armedOpts?.level, trigger: this.armedOpts?.trigger, when: new Date() };
      const ms = b.samples.length * b.periodNs / 1e6;
      const stats = this.#stats();
      this.#setStatus(`A${b.channel}: ${b.samples.length} samples over ${ms.toFixed(1)} ms at ` +
        `${(1e9 / b.periodNs / 1000).toFixed(1)} kS/s · ${this.last.when.toLocaleTimeString([], { hour12: false })}`);
      $('burstStats').textContent = stats;
      this.draw();
    } else {
      const why = { timeout: 'No trigger before the timeout.', incomplete: 'Some data was lost on the way; try again.',
                    cancelled: 'Cancelled.' }[b.reason] || b.reason;
      this.#setStatus(why, b.reason === 'timeout' ? '' : 'err');
    }
    if (this.repeat && this.ctx.getLink()?.board) setTimeout(() => { if (this.repeat) this.arm(); }, 150);
    else this.#syncButtons();
  }

  #options() {
    const vref = (this.hello?.vrefMv ?? 5000) / 1000;
    const volts = Math.min(Math.max(+$('burstLevel').value || 0, 0), vref);
    return {
      channel: +$('burstCh').value,
      rate: +$('burstRate').value,
      trigger: +$('burstTrig').value,
      level: Math.round(volts / vref * 1023),
      prePercent: +$('burstPre').value,
      timeoutMs: +$('burstTimeout').value
    };
  }

  #syncTrigControls() {
    const none = +$('burstTrig').value === TRIGGER.NONE;
    $('burstLevel').disabled = none; $('burstPre').disabled = none; $('burstTimeout').disabled = none;
  }

  #syncButtons() {
    $('burstArm').disabled = this.armed;
    $('burstStop').disabled = !this.armed && !this.repeat;
    $('burstArm').textContent = this.armed ? 'Armed' : 'Single';
  }

  #setStatus(text, cls = '') {
    const el = $('burstStatus');
    el.textContent = text;
    el.className = 'burststatus ' + cls;
  }

  #volts(raw, bits) { return raw * (this.hello?.vrefMv ?? 5000) / 1000 / ((1 << bits) - 1); }

  #stats() {
    const b = this.last; if (!b) return '';
    let lo = Infinity, hi = -Infinity, sum = 0;
    for (const v of b.samples) { if (v < lo) lo = v; if (v > hi) hi = v; sum += v; }
    const f = v => `${this.#volts(v, b.bits).toFixed(3)} V`;
    return `min ${f(lo)} · max ${f(hi)} · mean ${f(sum / b.samples.length)} · p-p ${f(hi - lo)}`;
  }

  // ---------- drawing ----------
  draw() {
    const { canvas, g } = this;
    const dpr = devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const css = getComputedStyle(canvas), col = n => css.getPropertyValue(n).trim();
    g.fillStyle = col('--scope-bg'); g.fillRect(0, 0, w, h);
    const padL = 34 * dpr, padB = 16 * dpr, padT = 6 * dpr, padR = 6 * dpr;
    const pw = w - padL - padR, ph = h - padT - padB;
    g.font = `${10 * dpr}px Consolas, monospace`;
    const b = this.last;
    const vref = (this.hello?.vrefMv ?? 5000) / 1000;

    let vMin = 0, vMax = vref;
    if (b && $('burstRange').value === 'auto') {
      let lo = Infinity, hi = -Infinity;
      for (const v of b.samples) { if (v < lo) lo = v; if (v > hi) hi = v; }
      lo = this.#volts(lo, b.bits); hi = this.#volts(hi, b.bits);
      const span = Math.max(hi - lo, 0.05);
      vMin = (lo + hi) / 2 - span * 0.6; vMax = (lo + hi) / 2 + span * 0.6;
    }
    const yOf = v => padT + ph - (v - vMin) / (vMax - vMin) * ph;

    g.strokeStyle = col('--scope-grid'); g.lineWidth = 1; g.fillStyle = col('--scope-text');
    g.textAlign = 'right'; g.textBaseline = 'middle';
    for (let i = 0; i <= 5; i++) {
      const v = vMin + (vMax - vMin) * i / 5, y = Math.round(yOf(v)) + 0.5;
      g.beginPath(); g.moveTo(padL, y); g.lineTo(w - padR, y); g.stroke();
      g.fillText(v.toFixed(vMax - vMin < 0.5 ? 3 : vMax - vMin < 5 ? 2 : 1), padL - 4 * dpr, y);
    }
    const n = b?.samples.length ?? 1024, periodMs = (b?.periodNs ?? 13000) / 1e6, t0 = -(b?.triggerIndex ?? 0) * periodMs;
    const spanMs = n * periodMs;
    const xOf = t => padL + (t - t0) / spanMs * pw;
    // Round tick spacing (1, 2, 5 x 10^k ms), so t = 0 (the trigger) always gets a grid line.
    const raw = spanMs / 6, mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 5, 10].map(m => m * mag).find(st => st >= raw);
    const dec = Math.max(0, -Math.floor(Math.log10(step)));
    g.textAlign = 'center'; g.textBaseline = 'top';
    for (let t = Math.ceil(t0 / step) * step; t <= t0 + spanMs + 1e-9; t += step) {
      const x = Math.round(xOf(t)) + 0.5;
      g.beginPath(); g.moveTo(x, padT); g.lineTo(x, padT + ph); g.stroke();
      if (b) g.fillText((Math.abs(t) < 1e-9 ? 0 : t).toFixed(dec), Math.min(Math.max(x, padL + 8 * dpr), w - 12 * dpr), padT + ph + 3 * dpr);
    }
    if (b) { g.textAlign = 'right'; g.fillText('ms', w - padR - 3 * dpr, padT + 3 * dpr); }
    if (!b) {
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('Press Single to capture a burst', padL + pw / 2, padT + ph / 2);
      return;
    }

    g.save();
    g.beginPath(); g.rect(padL, padT, pw, ph); g.clip();
    // Trigger marker and level
    if (b.trigger !== TRIGGER.NONE) {
      g.setLineDash([4 * dpr, 3 * dpr]); g.strokeStyle = col('--warn'); g.lineWidth = 1;
      const xt = padL + b.triggerIndex / n * pw;
      g.beginPath(); g.moveTo(xt, padT); g.lineTo(xt, padT + ph); g.stroke();
      if (b.level != null) {
        const yl = yOf(b.level / 1023 * vref);
        g.beginPath(); g.moveTo(padL, yl); g.lineTo(padL + pw, yl); g.stroke();
      }
      g.setLineDash([]);
    }
    g.strokeStyle = col('--accent'); g.lineWidth = 1.5 * dpr; g.lineJoin = 'round';
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const x = padL + (i + 0.5) / n * pw, y = yOf(this.#volts(b.samples[i], b.bits));
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
    g.restore();
  }

  saveCsv() {
    const b = this.last; if (!b) return;
    const periodMs = b.periodNs / 1e6;
    const lines = [`time_ms,A${b.channel}_V,raw_${b.bits}bit`];
    for (let i = 0; i < b.samples.length; i++) {
      lines.push(`${((i - b.triggerIndex) * periodMs).toFixed(3)},${this.#volts(b.samples[i], b.bits).toFixed(4)},${b.samples[i]}`);
    }
    const url = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `chrominator-burst-A${b.channel}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
}

