// Chrominator scope: stores EVT_CAPTURE blocks per ADC channel on a common sample clock and
// draws all capturing channels overlaid on one canvas.
//
// Roll mode: the newest sample is at the right edge and the trace moves left as samples arrive.
// Time comes from the board, not the PC: sample k of block b is tick b*N + k, where N is the
// samples per block (32 on the Uno, 8 on the Nano R4, taken from each frame), and a tick is
// hello.capturePeriodUs. Block numbers are 16-bit on the wire and unwrapped here.

const CAPACITY = 1 << 17;                 // samples kept per channel (~134 s at 1.024 ms, ~22 min at 10 ms)
const METER_KEY = 'chrominator.scopeMeterOn';    // channels whose live voltage readout is shown (default: none)

function loadMeterOn() {
  try { return new Set(JSON.parse(localStorage.getItem(METER_KEY)) || []); } catch { return new Set(); }
}
// One colour per ADC channel A0..A7; the pin list uses the same colour for each A-pin label.
export const TRACE_COLORS = ['#2f81f7', '#e5534b', '#3fb950', '#d29922', '#a371f7', '#39c5cf', '#db61a2', '#f0883e'];

export class Scope {
  constructor({ canvas, legend, rateLabel, windowSelect, rangeSelect, runButton, clearButton, saveButton, onStop }) {
    Object.assign(this, { canvas, legend, rateLabel, windowSelect, rangeSelect, runButton, onStop });
    this.ctx = canvas.getContext('2d');
    this.channels = new Map();            // ch -> { raw: Uint16Array, tick: Int32Array, latest }
    this.active = [];                     // channels currently in capture mode, display order
    this.periodUs = 1024; this.vrefMv = 5000; this.full = 1023;
    this.lastSeq = null; this.lastBlock = 0; this.endTick = -1;
    this.paused = false; this.pausedEnd = 0; this.dirty = true; this.lastDraw = 0;
    this.meterOn = loadMeterOn();         // per channel, remembered across sessions; hidden by default

    windowSelect.addEventListener('change', () => this.#touch());
    rangeSelect.addEventListener('change', () => this.#touch());
    runButton.addEventListener('click', () => this.setPaused(!this.paused));
    clearButton.addEventListener('click', () => this.clearAll());
    saveButton.addEventListener('click', () => this.saveCsv());
    new ResizeObserver(() => this.#touch()).observe(canvas);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.#touch());
    const frame = t => { if (this.dirty && t - this.lastDraw > 40) { this.lastDraw = t; this.dirty = false; this.#draw(); } requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
  }

  setBoard(hello) {
    this.periodUs = hello.capturePeriodUs || 1024;
    this.vrefMv = hello.vrefMv;
    this.full = (1 << hello.adcBits) - 1;
    this.rateLabel.textContent = `${(1e6 / this.periodUs).toFixed(1)} samples/s per channel · ${hello.adcBits}-bit`;
    this.clearAll();
  }

  setActive(channels) { this.active = channels; this.#renderLegend(); this.#touch(); }

  clearChannel(ch) { this.channels.delete(ch); this.#touch(); }

  clearAll() {
    this.channels.clear();
    this.lastSeq = null; this.endTick = -1;
    this.#renderLegend(); this.#touch();
  }

  setPaused(p) {
    this.paused = p;
    this.pausedEnd = this.endTick;
    this.runButton.textContent = p ? 'Run' : 'Pause';
    this.runButton.classList.toggle('paused', p);
    this.#touch();
  }

  add({ block, channel, samples }) {
    // Unwrap the 16-bit block number. Blocks only ever move forward; a big jump backwards
    // means the board restarted, so start over.
    if (this.lastSeq == null) this.lastBlock = block;
    else {
      const delta = (block - this.lastSeq) & 0xFFFF;
      if (delta >= 0x8000) { this.clearAll(); this.lastBlock = block; }
      else this.lastBlock += delta;
    }
    this.lastSeq = block;

    let c = this.channels.get(channel);
    if (!c) {
      c = { raw: new Uint16Array(CAPACITY), tick: new Int32Array(CAPACITY).fill(-1), latest: null };
      this.channels.set(channel, c);
    }
    const t0 = this.lastBlock * samples.length;
    for (let k = 0; k < samples.length; k++) {
      const t = t0 + k, i = t & (CAPACITY - 1);
      c.raw[i] = samples[k]; c.tick[i] = t;
    }
    c.latest = samples[samples.length - 1];
    this.endTick = Math.max(this.endTick, t0 + samples.length - 1);
    this.#touch();
    this.#updateLegendValues();
  }

  volts(raw) { return raw * this.vrefMv / this.full / 1000; }

  // ---------- drawing ----------
  #touch() { this.dirty = true; }

  #draw() {
    const { canvas, ctx } = this;
    const dpr = devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const css = getComputedStyle(canvas);
    const col = name => css.getPropertyValue(name).trim();
    ctx.fillStyle = col('--scope-bg'); ctx.fillRect(0, 0, w, h);

    const windowTicks = Math.round(+this.windowSelect.value * 1e6 / this.periodUs);
    const end = this.paused ? this.pausedEnd : this.endTick;
    const start = end - windowTicks + 1;
    const padL = 34 * dpr, padB = 16 * dpr, padT = 6 * dpr, padR = 6 * dpr;
    const pw = w - padL - padR, ph = h - padT - padB;

    // Vertical range: fixed 0..Vref, or fitted to what is on screen.
    let vMin = 0, vMax = this.vrefMv / 1000;
    if (this.rangeSelect.value === 'auto' && end >= 0) {
      let lo = Infinity, hi = -Infinity;
      for (const ch of this.active) {
        const c = this.channels.get(ch); if (!c) continue;
        for (let t = Math.max(start, end - CAPACITY + 1); t <= end; t++) {
          const i = t & (CAPACITY - 1); if (c.tick[i] !== t) continue;
          const r = c.raw[i]; if (r < lo) lo = r; if (r > hi) hi = r;
        }
      }
      if (lo <= hi) {
        lo = this.volts(lo); hi = this.volts(hi);
        const span = Math.max(hi - lo, 0.05), pad = span * 0.1;
        vMin = lo - pad; vMax = lo + span + pad;
        if ((hi - lo) < 0.05) { const mid = (hi + lo) / 2; vMin = mid - 0.03; vMax = mid + 0.03; }
      }
    }
    const yOf = v => padT + ph - (v - vMin) / (vMax - vMin) * ph;

    // Grid and labels
    ctx.strokeStyle = col('--scope-grid'); ctx.lineWidth = 1; ctx.fillStyle = col('--scope-text');
    ctx.font = `${10 * dpr}px Consolas, monospace`;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let i = 0; i <= 5; i++) {
      const v = vMin + (vMax - vMin) * i / 5, y = Math.round(yOf(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.fillText(v.toFixed(vMax - vMin < 0.5 ? 3 : vMax - vMin < 5 ? 2 : 1), padL - 4 * dpr, y);
    }
    const secs = +this.windowSelect.value;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let i = 0; i <= 10; i++) {
      const x = Math.round(padL + pw * i / 10) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ph); ctx.stroke();
      if (i % 2 === 0) {
        const s = -secs * (10 - i) / 10;
        ctx.fillText(i === 10 ? '0 s' : `${+s.toFixed(2)}`, Math.min(x, w - 12 * dpr), padT + ph + 3 * dpr);
      }
    }
    if (!this.active.length || end < 0) {
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(this.active.length ? 'Waiting for samples…' : 'Set an analog pin (A0–A7) to Capture to draw it here',
                   padL + pw / 2, padT + ph / 2);
      return;
    }

    // Traces: one point per sample when zoomed in, min/max per pixel column when zoomed out.
    ctx.save();
    ctx.beginPath(); ctx.rect(padL, padT, pw, ph); ctx.clip();
    ctx.lineWidth = 1.5 * dpr; ctx.lineJoin = 'round';
    const perPx = windowTicks / pw;
    for (const ch of this.active) {
      const c = this.channels.get(ch); if (!c) continue;
      ctx.strokeStyle = TRACE_COLORS[ch % TRACE_COLORS.length];
      ctx.beginPath();
      let pen = false;
      const first = Math.max(start, end - CAPACITY + 1);
      if (perPx <= 1) {
        for (let t = first; t <= end; t++) {
          const i = t & (CAPACITY - 1);
          if (c.tick[i] !== t) { pen = false; continue; }
          const x = padL + (t - start) / windowTicks * pw, y = yOf(this.volts(c.raw[i]));
          pen ? ctx.lineTo(x, y) : ctx.moveTo(x, y); pen = true;
        }
      } else {
        for (let px = 0; px < pw; px++) {
          const a = Math.max(first, Math.floor(start + px * perPx)), b = Math.min(end, Math.floor(start + (px + 1) * perPx) - 1);
          let lo = Infinity, hi = -Infinity;
          for (let t = a; t <= b; t++) {
            const i = t & (CAPACITY - 1); if (c.tick[i] !== t) continue;
            const r = c.raw[i]; if (r < lo) lo = r; if (r > hi) hi = r;
          }
          if (lo > hi) { pen = false; continue; }
          const x = padL + px + 0.5, y1 = yOf(this.volts(lo)), y2 = yOf(this.volts(hi));
          if (pen) ctx.lineTo(x, y2); else ctx.moveTo(x, y2);
          ctx.lineTo(x, y1); pen = true;
        }
      }
      ctx.stroke();
    }
    ctx.restore();
    if (this.paused) {
      ctx.fillStyle = col('--scope-text'); ctx.textAlign = 'right'; ctx.textBaseline = 'top';
      ctx.fillText('PAUSED', w - padR - 4 * dpr, padT + 4 * dpr);
    }
  }

  // ---------- legend ----------
  #renderLegend() {
    this.legend.replaceChildren(...this.active.map(ch => {
      const item = document.createElement('span');
      item.className = 'trace';
      item.style.setProperty('--c', TRACE_COLORS[ch % TRACE_COLORS.length]);
      item.innerHTML = `<i></i>A${ch} <b data-ch="${ch}">—</b>`;
      // V toggle: hide the live voltage for fast signals where the number just flickers.
      const on = this.meterOn.has(ch);
      const v = Object.assign(document.createElement('button'), { type: 'button', className: 'meter', textContent: 'V' });
      v.setAttribute('aria-pressed', String(on));
      v.title = on ? `Hide A${ch}'s live voltage` : `Show A${ch}'s live voltage`;
      item.querySelector('b').hidden = !on;
      v.addEventListener('click', () => this.toggleMeter(ch));
      item.append(v);
      if (this.onStop) {
        const x = Object.assign(document.createElement('button'), { type: 'button', className: 'stop', textContent: '✕',
                                                                    title: `Stop capturing A${ch}` });
        x.addEventListener('click', () => this.onStop(ch));
        item.append(x);
      }
      return item;
    }));
    this.#updateLegendValues();
  }

  toggleMeter(ch) {
    if (this.meterOn.has(ch)) this.meterOn.delete(ch); else this.meterOn.add(ch);
    try { localStorage.setItem(METER_KEY, JSON.stringify([...this.meterOn])); } catch {}
    this.#renderLegend();
  }

  #updateLegendValues() {
    for (const b of this.legend.querySelectorAll('b[data-ch]')) {
      if (b.hidden) continue;
      const c = this.channels.get(+b.dataset.ch);
      b.textContent = c?.latest == null ? '—' : `${this.volts(c.latest).toFixed(3)} V`;
    }
  }

  // ---------- export ----------
  saveCsv() {
    const chans = this.active.filter(ch => this.channels.has(ch));
    if (!chans.length || this.endTick < 0) return;
    const first = Math.max(0, this.endTick - CAPACITY + 1);
    let t0 = null;
    const lines = ['time_s,' + chans.map(ch => `A${ch}_V`).join(',')];
    for (let t = first; t <= this.endTick; t++) {
      const i = t & (CAPACITY - 1);
      const vals = chans.map(ch => { const c = this.channels.get(ch); return c.tick[i] === t ? this.volts(c.raw[i]).toFixed(4) : ''; });
      if (vals.every(v => v === '')) continue;
      if (t0 == null) t0 = t;
      lines.push(`${((t - t0) * this.periodUs / 1e6).toFixed(6)},${vals.join(',')}`);
    }
    const url = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], { type: 'text/csv' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `chrominator-capture-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
}
