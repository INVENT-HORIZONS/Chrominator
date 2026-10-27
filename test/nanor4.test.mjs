// End-to-end test for the Arduino Nano R4 pin map: the real firmware built with
// -DCHROMINATOR_SIM_NANOR4 against test/sim, talking to the extension's protocol.js and link.js.
// Run with test/run.sh.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { MODE, CAP, pinLabel } from '../extension/js/protocol.js';
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

await test('HELLO identifies a Nano R4: 22 pins, 14-bit ADC, no capture', async () => {
  await link.start();
  const { hello } = link.board;
  assert.equal(hello.boardId, 4);
  assert.equal(hello.boardName, 'Arduino Nano R4');
  assert.equal(hello.numPins, 22);
  assert.equal(hello.adcBits, 14);
  assert.equal(hello.vrefMv, 5000);
  assert.equal(hello.capturePeriodUs, 0);
  assert.equal(link.state, LINK.UP);
});

await test('caps: D0/D1 usable, PWM on D3/5/6/9/10/11, A0-A7 on pins 14-21', () => {
  const { caps } = link.board;
  assert.equal(caps.length, 22);
  for (let p = 0; p < 22; p++) {
    assert.ok(!(caps[p].caps & CAP.RESERVED), `pin ${p} not reserved`);
    assert.ok(!(caps[p].caps & CAP.CAPTURE), `pin ${p} has no capture`);
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

await test('Capture is refused on a board without a capture engine', async () => {
  await assert.rejects(link.setMode(14, MODE.CAPTURE), e => e instanceof ProtocolError);
});

await test('All pins safe returns every pin to Input', async () => {
  await link.resetPins();
  assert.ok(link.board.config.every(c => c.mode === MODE.INPUT));
});

link.stop();
tr.kill();
console.log(`\n${passed} Nano R4 tests passed.`);
