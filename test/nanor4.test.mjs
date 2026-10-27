// End-to-end test for the Arduino Nano R4 pin map: the real firmware built with
// -DCHROMINATOR_SIM_NANOR4 against test/sim, talking to the extension's protocol.js and link.js.
// Run with test/run.sh.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { MODE, CAP, CMD, pinLabel, decodeCapture } from '../extension/js/protocol.js';
import { ChrominatorLink, LINK, ProtocolError } from '../extension/js/link.js';

const SIM = process.argv[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0;
async function test(name, fn) {
  const t = performance.now();
  await fn();
  passed++;
  console.log(`  ok  ${name}  (${Math.round(performance.now() - t)} ms)`);
}
async function waitFor(cond, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return; await sleep(20); }
  throw new Error(`Timed out waiting for ${what}`);
}

class SimTransport {
  constructor() { this.pinLog = []; }
  start(onData) {
    this.proc = spawn(SIM, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.on('data', b => onData(new Uint8Array(b)));
    this.proc.stderr.on('data', b => this.pinLog.push(...b.toString().trim().split('\n')));
    this.proc.stdin.on('error', () => {});
  }
  write(bytes) { this.proc.stdin.write(bytes); return Promise.resolve(); }
  kill() { this.proc.kill('SIGKILL'); }
}

const nextInputs = () => new Promise(r => link.addEventListener('inputs', e => r(e.detail), { once: true }));
const PWM_PINS = [3, 5, 6, 9, 10, 11];

console.log('Nano R4 firmware + link tests');
const tr = new SimTransport();
const link = new ChrominatorLink(tr);
tr.start(b => link.receive(b));

await test('HELLO identifies a Nano R4: 22 pins, 14-bit ADC, capture at 100 samples/s', async () => {
  await link.start();
  const { hello } = link.board;
  assert.equal(hello.boardId, 4);
  assert.equal(hello.boardName, 'Arduino Nano R4');
  assert.equal(hello.numPins, 22);
  assert.equal(hello.adcBits, 14);
  assert.equal(hello.vrefMv, 5000);
  assert.equal(hello.capturePeriodUs, 10000);
  assert.equal(link.state, LINK.UP);
});

await test('caps: D0/D1 usable, PWM on D3/5/6/9/10/11, A0-A7 on pins 14-21', () => {
  const { caps } = link.board;
  assert.equal(caps.length, 22);
  for (let p = 0; p < 22; p++) {
    assert.ok(!(caps[p].caps & CAP.RESERVED), `pin ${p} not reserved`);
    assert.equal(!!(caps[p].caps & CAP.CAPTURE), p >= 14, `pin ${p} capture`);
    assert.equal(!!(caps[p].caps & CAP.PWM), PWM_PINS.includes(p), `pin ${p} PWM`);
  }
  const labels = caps.map((c, p) => pinLabel(p, c));
  assert.deepEqual(labels.slice(0, 14), Array.from({ length: 14 }, (_, i) => `D${i}`));
  assert.deepEqual(labels.slice(14), ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7']);
});

await test('D0 works as an output (USB is native, so it is free)', async () => {
  await link.setMode(0, MODE.OUTPUT);
  await link.write(0, 1);
  await waitFor(() => tr.pinLog.includes('WRITE 0 1'), 500, 'WRITE 0 1');
  await nextInputs();
  const r = await nextInputs();
  assert.ok(r.levels & 1, 'D0 reads HIGH');
});

await test('A6 and A7 read in Analog mode; READ_ALL carries 8 channels', async () => {
  await link.setMode(20, MODE.ANALOG);
  await link.setMode(21, MODE.ANALOG);
  await nextInputs();
  const r = await nextInputs();
  assert.equal(r.adc.length, 8);
  assert.ok([99, 100, 101].includes((r.adc[7] - r.adc[6] + 16384) % 1024), `A7-A6 ${r.adc[7] - r.adc[6]}`);
});

await test('an A-pin used as a digital output is not converted (no analogRead on it)', async () => {
  await link.setMode(18, MODE.OUTPUT);          // A4
  await link.write(18, 1);
  await nextInputs();
  const r = await nextInputs();
  assert.ok(r.levels & (1 << 18), 'A4 still drives HIGH');
  assert.equal(r.adc[4], 0, 'channel 4 not sampled while A4 is digital');
});

await test('14-bit capture block packing round-trips (8 samples, LSB-first)', () => {
  const vals = [0, 16383, 1, 8192, 12345, 777, 16000, 3];
  const packed = new Uint8Array(14);
  vals.forEach((v, k) => {
    const bit = k * 14, w = v << (bit & 7);
    packed[bit >> 3] |= w & 0xFF; packed[(bit >> 3) + 1] |= (w >> 8) & 0xFF; packed[(bit >> 3) + 2] |= (w >> 16) & 0xFF;
  });
  const c = decodeCapture(Uint8Array.from([5, 0, 7, 8, 14, ...packed]));
  assert.equal(c.channel, 7); assert.deepEqual([...c.samples], vals);
});

await test('capture: A0 and A2 stream aligned 8-sample, 14-bit blocks at 100 samples/s', async () => {
  const got = [];
  const onCap = e => got.push(e.detail);
  link.addEventListener('capture', onCap);
  await link.setMode(14, MODE.CAPTURE);
  await link.setMode(16, MODE.CAPTURE);
  const t0 = performance.now();
  await sleep(1000);
  link.removeEventListener('capture', onCap);
  const secs = (performance.now() - t0) / 1000;
  const a0 = got.filter(c => c.channel === 0), a2 = got.filter(c => c.channel === 2);
  assert.ok(a0.every(c => c.samples.length === 8), 'blocks of 8');
  const rate = a0.length * 8 / secs;
  assert.ok(rate > 85 && rate < 115, `A0 rate ${rate.toFixed(1)} samples/s`);
  // The simulated signal ramps 1 count per ms, so consecutive samples are 10 counts apart...
  for (const c of a0) for (let k = 1; k < 8; k++) assert.equal((c.samples[k] - c.samples[k - 1] + 1024) % 1024, 10);
  // ...and A2, sampled at the same instants, reads 200 counts above A0.
  const byBlock = new Map(a2.map(c => [c.block, c]));
  let compared = 0;
  for (const c of a0) {
    const m = byBlock.get(c.block); if (!m) continue;
    for (let k = 0; k < 8; k++) assert.equal((m.samples[k] - c.samples[k] + 1024) % 1024, 200);
    compared++;
  }
  assert.ok(compared >= 8, `aligned blocks compared: ${compared}`);
  assert.equal(link.stats.captureGaps, 0);
});

await test('capture: all eight channels at once, no drops, link healthy', async () => {
  for (let p = 14; p < 22; p++) await link.setMode(p, MODE.CAPTURE);
  const blocks = link.stats.captureBlocks, t0 = performance.now();
  await sleep(1000);
  const perSec = (link.stats.captureBlocks - blocks) / ((performance.now() - t0) / 1000);
  assert.ok(perSec > 8 * 10.5, `blocks/s ${perSec.toFixed(1)}`);     // 8 ch x 12.5 blocks/s nominal
  const ping = await link.request(CMD.PING);
  assert.equal(ping[8] | (ping[9] << 8), 0, 'board dropped no blocks');
  assert.equal(link.stats.captureGaps, 0);
  assert.equal(link.state, LINK.UP);
});

await test('capture stops on All pins safe', async () => {
  await link.resetPins();
  await sleep(150);
  const n = link.stats.captureBlocks;
  await sleep(300);
  assert.equal(link.stats.captureBlocks, n);
});

await test('All pins safe returns every pin to Input', async () => {
  await link.resetPins();
  assert.ok(link.board.config.every(c => c.mode === MODE.INPUT));
});

link.stop();
tr.kill();
console.log(`\n${passed} Nano R4 tests passed.`);
