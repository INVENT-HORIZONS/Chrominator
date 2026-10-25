// End-to-end test: the real firmware (compiled for the PC against test/sim) talking to the
// extension's real protocol.js and link.js. Run with test/run.sh.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { crc8, encodeFrame, FrameParser, CMD, MODE, CAP, decodeCapture, TRIGGER } from '../extension/js/protocol.js';
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

// Transport over a simulator process. Can drop outgoing bytes and swap processes (board reboot).
class SimTransport {
  constructor() { this.dropWrites = false; this.pinLog = []; }
  start(onData) {
    this.onData = onData;
    this.proc = spawn(SIM, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.on('data', b => this.onData(new Uint8Array(b)));
    this.proc.stderr.on('data', b => this.pinLog.push(...b.toString().trim().split('\n')));
    this.proc.stdin.on('error', () => {});
  }
  write(bytes) { if (!this.dropWrites) this.proc.stdin.write(bytes); return Promise.resolve(); }
  kill() { this.proc.kill('SIGKILL'); }
}

console.log('Protocol unit tests');
await test('CRC-8 check value', () => assert.equal(crc8([...'123456789'].map(c => c.charCodeAt(0))), 0xF4));
await test('parser: junk, good frame, bad CRC, split frame', () => {
  const got = [];
  const p = new FrameParser(f => got.push(f));
  const good = encodeFrame(7, 0x81, [0, 1, 2]);
  const bad = Uint8Array.from(good); bad[bad.length - 1] ^= 0xFF;
  p.push([0x00, 0x13, 0xA5, 0xFF]);           // junk incl. a false SOF with an impossible LEN
  p.push(good); p.push(bad);
  p.push(good.slice(0, 3)); p.push(good.slice(3));
  assert.equal(got.length, 2);
  assert.equal(got[0].seq, 7); assert.deepEqual([...got[0].data], [0, 1, 2]);
  assert.equal(p.stats.crcErrors, 1);
});

await test('capture block unpacking (10-bit, LSB-first)', () => {
  const vals = Array.from({ length: 32 }, (_, k) => (k * 97 + 5) & 0x3FF);
  const packed = new Uint8Array(40);
  vals.forEach((v, k) => { const bit = k * 10, w = v << (bit & 7); packed[bit >> 3] |= w & 0xFF; packed[(bit >> 3) + 1] |= w >> 8; });
  const c = decodeCapture(Uint8Array.from([0x34, 0x12, 3, 32, 10, ...packed]));
  assert.equal(c.block, 0x1234); assert.equal(c.channel, 3);
  assert.deepEqual([...c.samples], vals);
});

console.log('Firmware + link tests');
const tr = new SimTransport();
const link = new ChrominatorLink(tr);
const logs = [], states = [];
link.addEventListener('log', e => logs.push(e.detail.message));
link.addEventListener('state', e => states.push(e.detail));
tr.start(b => link.receive(b));

await test('connect: HELLO, caps and config', async () => {
  await link.start();
  const { hello, caps, config } = link.board;
  assert.equal(link.state, LINK.UP);
  assert.equal(hello.boardName, 'Arduino Uno R3');
  assert.equal(hello.numPins, 20); assert.equal(hello.adcBits, 10); assert.equal(hello.vrefMv, 5000);
  assert.ok(caps[0].caps & 0x80, 'D0 reserved');
  assert.ok(caps[3].caps & 0x04, 'D3 has PWM');
  assert.ok(!(caps[2].caps & 0x04), 'D2 has no PWM');
  assert.equal(caps[14].adcChannel, 0); assert.equal(caps[19].adcChannel, 5);
  assert.ok(config.every(c => c.mode === MODE.INPUT));
});

await test('digital output and read-back', async () => {
  await link.setMode(13, MODE.OUTPUT);
  await link.write(13, 1);
  await waitFor(() => tr.pinLog.includes('WRITE 13 1'), 500, 'WRITE 13 1');
  const r = await nextInputs();
  assert.equal((r.levels >>> 13) & 1, 1, 'D13 reads HIGH');
  assert.equal((r.levels >>> 2) & 1, 1, 'D2 (tied high in sim) reads HIGH');
  assert.equal(r.adc.length, 6);
});

await test('PWM and analog modes', async () => {
  await link.setMode(3, MODE.PWM);
  await link.write(3, 200);
  await waitFor(() => tr.pinLog.includes('PWM 3 200'), 500, 'PWM 3 200');
  await link.setMode(14, MODE.ANALOG);
  const cfg = await link.request(CMD.GET_CONFIG);
  assert.equal(cfg[2 + 3 * 2], MODE.PWM); assert.equal(cfg[2 + 3 * 2 + 1], 200);
  assert.equal(cfg[2 + 14 * 2], MODE.ANALOG);
});

await test('board rejects invalid requests with the right status', async () => {
  const expectStatus = async (p, status) => {
    await assert.rejects(p, e => e instanceof ProtocolError && e.status === status);
  };
  await expectStatus(link.setMode(0, MODE.OUTPUT), 6);      // reserved
  await expectStatus(link.setMode(2, MODE.PWM), 4);         // no PWM on D2
  await expectStatus(link.setMode(25, MODE.INPUT), 3);      // bad pin
  await expectStatus(link.write(4, 1), 7);                  // D4 is an input
  await expectStatus(link.write(13, 5), 5);                 // output value must be 0/1
  await expectStatus(link.request(0x7E), 1);                // unknown command
  await expectStatus(link.request(CMD.SET_MODE, [13]), 2);  // bad length
});

await test('heartbeat runs and measures RTT', async () => {
  const pings = link.stats.tx;
  await sleep(800);
  assert.ok(link.stats.rttMs != null && link.stats.rttMs < 50, `rtt ${link.stats.rttMs}`);
  assert.ok(link.stats.uptimeMs > 0);
  assert.ok(link.stats.tx - pings >= 8, 'pings and polls kept flowing');
  assert.equal(link.stats.timeouts, 0);
});

await test('line noise and corrupted frames are ignored', async () => {
  const before = link.parser.stats.crcErrors;
  await tr.write(Uint8Array.from([0xA5, 0x02, 0x55, 0x10, 0x0D, 0x02, 0x00]));  // bad CRC
  await tr.write(Uint8Array.from([0x13, 0x37, 0xA5]));                         // junk + dangling SOF
  await sleep(120);                                                            // > byte timeout
  await link.write(13, 0);                                                     // board still answers
  await waitFor(() => tr.pinLog.includes('WRITE 13 0'), 500, 'WRITE 13 0');
  assert.equal(link.parser.stats.crcErrors, before, 'board sent nothing corrupt back');
  assert.equal(link.state, LINK.UP);
});

await test('link lost when the board stops answering, restored when it resumes', async () => {
  tr.proc.kill('SIGSTOP');
  await waitFor(() => link.state === LINK.LOST, 1600, 'LOST');
  tr.proc.kill('SIGCONT');
  await waitFor(() => link.state === LINK.UP, 1000, 'UP again');
  assert.ok(logs.some(m => m.startsWith('Link lost')));
  assert.ok(logs.includes('Link restored.'));
});

await test('board fails safe when the host goes quiet, host resyncs', async () => {
  await link.setMode(13, MODE.OUTPUT);
  await link.write(13, 1);
  tr.pinLog.length = 0;
  tr.dropWrites = true;                                  // host -> board traffic stops
  await waitFor(() => tr.pinLog.includes('PINMODE 13 0'), 2500, 'failsafe on D13');
  await waitFor(() => logs.some(m => m.startsWith('Board failsafe')), 500, 'EVT_FAILSAFE seen by host');
  tr.dropWrites = false;
  await waitFor(() => link.state === LINK.UP && link.board.config[13].mode === MODE.INPUT, 2000, 'resync after failsafe');
  const flags = (await link.request(CMD.PING))[1];
  assert.equal(flags & 1, 0, 'FAILSAFE flag cleared by GET_CONFIG');
});

await test('board reboot is detected and state reloaded', async () => {
  await link.setMode(13, MODE.OUTPUT);
  logs.length = 0;
  tr.kill();
  await sleep(300);
  tr.start(b => link.receive(b));                        // "new" board on the same port
  await waitFor(() => logs.some(m => /Board reset|Board restarted/.test(m)), 2000, 'reboot noticed');
  await waitFor(() => link.state === LINK.UP && link.board.config[13].mode === MODE.INPUT, 2000, 'state reloaded');
  const flags = (await link.request(CMD.PING))[1];
  assert.equal(flags & 2, 0, 'NEEDS_HELLO cleared');
});

await test('safe-state button resets every pin', async () => {
  await link.setMode(13, MODE.OUTPUT);
  await link.setMode(5, MODE.PWM);
  await link.resetPins();
  assert.ok(link.board.config.every(c => c.mode === MODE.INPUT));
});

await sleep(600);                                        // let earlier tests' in-flight pings settle
const timeoutsBeforeCapture = link.stats.timeouts;
await test('capture: A0 and A2 stream aligned 32-sample blocks at 1.024 ms', async () => {
  assert.equal(link.board.hello.capturePeriodUs, 1024);
  assert.ok(link.board.caps[14].caps & CAP.CAPTURE);
  const got = [];
  const onCap = e => got.push(e.detail);
  link.addEventListener('capture', onCap);
  await link.setMode(14, MODE.CAPTURE);
  await link.setMode(16, MODE.CAPTURE);
  await sleep(600);
  link.removeEventListener('capture', onCap);
  const a0 = got.filter(c => c.channel === 0), a2 = got.filter(c => c.channel === 2);
  assert.ok(a0.length >= 12, `A0 blocks: ${a0.length}`);           // ~18 expected in 600 ms
  for (let i = 1; i < a0.length; i++) assert.equal((a0[i].block - a0[i - 1].block) & 0xFFFF, 1, 'consecutive blocks');
  // Sim signal: channel n = (ms + 100n) mod 1024, so each sample rises ~1 count per tick...
  for (const c of a0) for (let k = 1; k < 32; k++) {
    const d = (c.samples[k] - c.samples[k - 1] + 1024) % 1024;
    assert.ok(d <= 2, `step ${d}`);
  }
  // ...and A2 sampled at the same instants reads 200 counts higher than A0.
  const byBlock = new Map(a2.map(c => [c.block, c]));
  let compared = 0;
  for (const c of a0) {
    const m = byBlock.get(c.block); if (!m) continue;
    for (let k = 0; k < 32; k++) assert.ok([199, 200, 201].includes((m.samples[k] - c.samples[k] + 1024) % 1024));
    compared++;
  }
  assert.ok(compared >= 10, `aligned blocks compared: ${compared}`);
  assert.equal(link.stats.captureGaps, 0);
});

await test('capture: READ_ALL still reports live ADC values, link stays healthy', async () => {
  const r = await nextInputs();
  assert.ok(r.adc[0] < 1024 && r.adc[2] < 1024);
  assert.ok([198, 199, 200, 201, 202].includes((r.adc[2] - r.adc[0] + 1024) % 1024), `A2-A0 ${r.adc[2] - r.adc[0]}`);
  assert.equal(link.state, LINK.UP);
  assert.equal(link.stats.timeouts, timeoutsBeforeCapture, 'no timeouts while streaming');
});

await test('capture: all six channels at once fit the link', async () => {
  for (let p = 14; p < 20; p++) await link.setMode(p, MODE.CAPTURE);
  const blocks = link.stats.captureBlocks, t0 = performance.now();
  await sleep(1000);
  const perSec = (link.stats.captureBlocks - blocks) / ((performance.now() - t0) / 1000);
  assert.ok(perSec > 6 * 28, `blocks/s ${perSec.toFixed(1)}`);    // 6 ch x 30.5 blocks/s nominal
  assert.equal(link.stats.timeouts, timeoutsBeforeCapture, 'no timeouts with all six streaming');
  const ping = await link.request(CMD.PING);
  assert.equal(ping[8] | (ping[9] << 8), 0, 'board dropped no blocks');
  assert.equal(link.stats.captureGaps, 0);
});

await test('capture stops when pins leave capture mode', async () => {
  await link.resetPins();
  await sleep(100);
  const n = link.stats.captureBlocks;
  await sleep(300);
  assert.equal(link.stats.captureBlocks, n);
});

// ---------- Burst ----------
// Sim signal: channel n reads (ms + 100n) mod 1024, sampled at each sample's exact time, so a
// value holds for 1 ms. Run lengths of equal values therefore measure the sample period.
function nextBurst(ms = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no burst event')), ms);
    link.addEventListener('burst', e => { clearTimeout(t); resolve(e.detail); }, { once: true });
  });
}
function innerRuns(samples) {
  const runs = []; let len = 1;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i] === samples[i - 1]) len++; else { runs.push(len); len = 1; }
  }
  return runs.slice(1);                       // first run is partial; the last one was never closed
}

await test('burst: 76.9 kS/s 8-bit, no trigger, 1024 samples at 13 us', async () => {
  assert.equal(link.board.hello.burstSamples, 1024);
  const done = nextBurst();
  const r = await link.startBurst({ channel: 1, rate: 0, trigger: TRIGGER.NONE });
  assert.deepEqual([r.samples, r.bits, r.periodNs, r.triggerIndex], [1024, 8, 13000, 0]);
  const b = await done;
  assert.ok(b.ok); assert.equal(b.samples.length, 1024); assert.equal(b.channel, 1);
  const runs = innerRuns(b.samples);                   // 8-bit value steps every 4 ms = 307.7 samples
  assert.ok(runs.length >= 2 && runs.every(n => n >= 306 && n <= 309), `runs ${runs}`);
});

await test('burst: 9.6 kS/s 10-bit, 512 samples at 104 us', async () => {
  const done = nextBurst();
  await link.startBurst({ channel: 0, rate: 3, trigger: TRIGGER.NONE });
  const b = await done;
  assert.ok(b.ok); assert.equal(b.bits, 10); assert.equal(b.samples.length, 512);
  const runs = innerRuns(b.samples);                   // 1 ms / 104 us = 9.6 samples per value
  assert.ok(runs.length > 40 && runs.every(n => n === 9 || n === 10), `runs ${runs.slice(0, 10)}`);
});

await test('burst: rising trigger with 25% pre-trigger', async () => {
  const done = nextBurst();
  const r = await link.startBurst({ channel: 2, rate: 2, trigger: TRIGGER.RISING, level: 600, prePercent: 25, timeoutMs: 3000 });
  assert.equal(r.triggerIndex, 128);
  const b = await done;
  assert.ok(b.ok, b.reason); assert.equal(b.triggerIndex, 128);
  const s = b.samples;
  assert.ok(s[128] >= 600 && s[127] < 600, `around trigger: ${s[127]} ${s[128]}`);
  assert.ok(s.slice(0, 128).every(v => v < 600), 'pre-trigger history is below the level');
});

await test('burst: falling trigger (8-bit) catches the ramp wrapping', async () => {
  const done = nextBurst();
  await link.startBurst({ channel: 3, rate: 1, trigger: TRIGGER.FALLING, level: 512, prePercent: 50, timeoutMs: 3000 });
  const b = await done;
  assert.ok(b.ok, b.reason); assert.equal(b.triggerIndex, 512);
  const s = b.samples;
  assert.ok(s[512] <= 128 && s[511] > 128, `around trigger: ${s[511]} ${s[512]}`);
});

await test('burst: timeout when the level is never crossed', async () => {
  const now = (await nextInputs()).adc[0];
  const done = nextBurst();
  await link.startBurst({ channel: 0, rate: 0, trigger: TRIGGER.RISING, level: (now + 500) % 1024, timeoutMs: 150 });
  const b = await done;
  assert.equal(b.ok, false); assert.equal(b.reason, 'timeout');
});

await test('burst: cancel, then the board takes a new burst', async () => {
  const now = (await nextInputs()).adc[0];
  await link.startBurst({ channel: 0, rate: 0, trigger: TRIGGER.RISING, level: (now + 500) % 1024, timeoutMs: 0 });
  await link.cancelBurst();
  const done = nextBurst();
  await link.startBurst({ channel: 0, rate: 0, trigger: TRIGGER.NONE });
  assert.ok((await done).ok);
});

await test('burst: rejected on an output pin', async () => {
  await link.setMode(15, MODE.OUTPUT);
  await assert.rejects(link.startBurst({ channel: 1, rate: 0 }), e => e instanceof ProtocolError && e.status === 7);
  await link.setMode(15, MODE.INPUT);
});

await test('burst: streaming capture pauses and resumes, with the gap in the right place', async () => {
  const blocks = [];
  const onCap = e => { if (e.detail.channel === 0) blocks.push(e.detail.block); };
  link.addEventListener('capture', onCap);
  await link.setMode(14, MODE.CAPTURE);
  await sleep(300);
  const done = nextBurst();
  await link.startBurst({ channel: 1, rate: 3, trigger: TRIGGER.NONE });   // ~53 ms of sampling + sending
  assert.ok((await done).ok);
  await sleep(300);
  link.removeEventListener('capture', onCap);
  await link.setMode(14, MODE.INPUT);
  const jumps = blocks.slice(1).map((b, i) => (b - blocks[i]) & 0xFFFF).filter(d => d !== 1);
  assert.equal(jumps.length, 1, `jumps ${jumps}`);
  // The pause (burst + sending, ~100-250 ms) shows up as a gap of the same length: 3-10 blocks.
  assert.ok(jumps[0] >= 3 && jumps[0] <= 10, `gap of ${jumps[0]} blocks`);
  assert.ok(blocks.length > 12, 'capture resumed');
});

link.stop();
tr.kill();
console.log(`\n${passed} tests passed. Stats: ${JSON.stringify(link.stats)} parser ${JSON.stringify(link.parser.stats)}`);

function nextInputs() {
  return new Promise(r => link.addEventListener('inputs', e => r(e.detail), { once: true }));
}
