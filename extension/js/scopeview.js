// One channel's pop-out oscilloscope view. It builds its own markup into any document: the
// regular pop-out window (scope.html) or a Picture-in-Picture window, which Chrome keeps on top of
// all other windows. It runs its own Scope (own timebase, scale, pause and CSV) fed by the side
// panel through ScopeBridge (BroadcastChannel); the side panel keeps drawing the channel too.
import { Scope, TRACE_COLORS } from './scope.js';
import { SCOPE_CHANNEL } from './scopebridge.js';

const TB_KEY = 'chrominator.popoutTimebase';

const MARKUP = `
<header class="swbar">
  <span class="eye on" aria-hidden="true"></span>
  <b class="swtitle" data-id="title">Oscilloscope</b>
  <span class="spacer"></span>
  <div class="scopectl">
    <div class="timebase" title="Time across the screen">
      <button data-id="tbLess" type="button" aria-label="Shorter timebase">◀</button>
      <span data-id="tbValue">10 s</span>
      <button data-id="tbMore" type="button" aria-label="Longer timebase">▶</button>
    </div>
    <select data-id="window" hidden>
      <option value="1">1 s</option><option value="2">2 s</option><option value="5">5 s</option>
      <option value="10" selected>10 s</option><option value="30">30 s</option>
      <option value="60">60 s</option><option value="120">2 min</option>
    </select>
    <select data-id="range" title="Vertical scale">
      <option value="full">0–5 V</option><option value="auto">Auto</option>
    </select>
    <button data-id="run">Pause</button>
    <button data-id="pin" type="button" hidden title="Keep this scope on top of all other windows (Picture-in-Picture)">📌 Keep on top</button>
  </div>
</header>
<div class="banner" data-id="offline" hidden></div>
<canvas data-id="canvas" class="swcanvas"></canvas>
<footer class="swfoot">
  <div data-id="legend" class="legend"></div>
  <span class="note small" data-id="rate"></span>
  <span class="scopebtns">
    <button data-id="clear" class="link small">clear</button>
    <button data-id="save" class="link small">save CSV</button>
  </span>
</footer>`;

let nextId = 1;

export class ScopeView {
  // doc: the document to build into. onPin: if given, shows "Keep on top" and calls it on click.
  constructor(doc, ch, { onPin } = {}) {
    this.doc = doc; this.chNum = ch;
    this.id = `${Date.now().toString(36)}-${nextId++}-${Math.random().toString(36).slice(2, 6)}`;
    doc.body.classList.add('scopewin');
    doc.documentElement.style.setProperty('--c', TRACE_COLORS[ch % TRACE_COLORS.length]);
    const root = doc.createElement('div');
    root.className = 'swroot';
    root.innerHTML = MARKUP;
    doc.body.append(root);
    this.root = root;
    const $ = id => root.querySelector(`[data-id="${id}"]`);
    this.$ = $;

    this.scope = new Scope({
      canvas: $('canvas'), legend: $('legend'), rateLabel: $('rate'),
      windowSelect: $('window'), rangeSelect: $('range'),
      runButton: $('run'), clearButton: $('clear'), saveButton: $('save'), onStop: null
    });

    try { const v = localStorage.getItem(TB_KEY); if (v) $('window').value = v; } catch {}
    $('tbLess').onclick = () => this.#step(-1);
    $('tbMore').onclick = () => this.#step(1);
    this.#syncTb();
    if (onPin) { $('pin').hidden = false; $('pin').onclick = onPin; }

    this.boardKey = null; this.lastStatus = 0; this.active = false; this.haveHistory = false;
    this.bc = new BroadcastChannel(SCOPE_CHANNEL);
    this.bc.onmessage = ({ data: m }) => this.#onMessage(m);
    this.timer = setInterval(() => this.#showState(), 1000);
    this.onStorage = e => {
      if (e.key !== 'chrominator.theme') return;
      if (e.newValue === 'light' || e.newValue === 'dark') doc.documentElement.dataset.theme = e.newValue;
      this.scope.redraw();
    };
    addEventListener('storage', this.onStorage);
    this.bc.postMessage({ type: 'hello', ch, id: this.id });
    this.#showState();
  }

  destroy() {
    clearInterval(this.timer);
    removeEventListener('storage', this.onStorage);
    try { this.bc.postMessage({ type: 'bye', ch: this.chNum, id: this.id }); this.bc.close(); } catch {}
    this.root.remove();
  }

  #step(d) {
    const sel = this.$('window');
    const i = Math.min(sel.options.length - 1, Math.max(0, sel.selectedIndex + d));
    if (i !== sel.selectedIndex) { sel.selectedIndex = i; sel.dispatchEvent(new Event('change')); }
    try { localStorage.setItem(TB_KEY, sel.value); } catch {}
    this.#syncTb();
  }
  #syncTb() {
    const sel = this.$('window');
    this.$('tbValue').textContent = sel.options[sel.selectedIndex].text;
    this.$('tbLess').disabled = sel.selectedIndex === 0;
    this.$('tbMore').disabled = sel.selectedIndex === sel.options.length - 1;
  }

  #onMessage(m) {
    if (m?.ch !== this.chNum) return;
    if (m.type === 'status') {
      this.lastStatus = Date.now();
      if (m.hello) {
        const key = `${m.hello.boardName}|${m.hello.capturePeriodUs}|${m.hello.adcBits}`;
        if (key !== this.boardKey) { this.boardKey = key; this.scope.setBoard(m.hello); this.scope.setActive([this.chNum]); }
      }
      this.active = !!m.active;
      this.scope.setNames(m.name ? { [this.chNum]: m.name } : {});
      const title = `A${this.chNum}${m.name ? ' ' + m.name : ''}`;
      this.$('title').textContent = `${title} · Oscilloscope`;
      this.doc.title = `${title} — Chrominator Oscilloscope`;
      this.#showState();
    } else if (m.type === 'history' && m.id === this.id) {
      // Live blocks that came before the history are in it too; adding them first would look like a
      // board restart (block numbers going backwards), so they are ignored until the history is in.
      if (this.haveHistory) return;
      this.haveHistory = true;
      for (const b of m.blocks) this.scope.add(b);
    } else if (m.type === 'block' && this.haveHistory) {
      this.scope.add(m.block);
    }
  }

  #showState() {
    const live = Date.now() - this.lastStatus < 3000;
    const msg = !live ? 'Not connected. Open Chrominator\'s side panel and connect to the board.'
      : !this.active ? `A${this.chNum} is not in Oscilloscope mode, so nothing new is being drawn. Set it back to Oscilloscope in the side panel.` : '';
    this.$('offline').textContent = msg;
    this.$('offline').hidden = !msg;
    this.$('canvas').style.opacity = live && this.active ? '' : '.6';
  }
}

// Open a Picture-in-Picture window (always on top) showing channel ch. Must be called from a click.
// Chrome allows one Picture-in-Picture window at a time; opening another replaces it.
// Resolves to the PiP window, or throws if the browser refuses.
export async function openPipScope(ch, { width = 820, height = 440 } = {}) {
  const pip = await documentPictureInPicture.requestWindow({ width, height });
  const doc = pip.document;
  for (const href of ['sidepanel.css', 'scopewin.css']) {
    const l = doc.createElement('link');
    l.rel = 'stylesheet'; l.href = chrome.runtime.getURL(href);
    doc.head.append(l);
  }
  const t = document.documentElement.dataset.theme;
  if (t) doc.documentElement.dataset.theme = t;
  const view = new ScopeView(doc, ch);
  pip.addEventListener('pagehide', () => view.destroy());
  return pip;
}
