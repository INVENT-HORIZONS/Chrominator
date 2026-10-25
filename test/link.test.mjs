// End-to-end test: the real firmware (compiled for the PC against test/sim) talking to the
// extension's real protocol.js and link.js. Run with test/run.sh.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { crc8, encodeFrame, FrameParser, CMD, MODE } from '../extension/js/protocol.js';
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

link.stop();
tr.kill();
console.log(`\n${passed} tests passed. Stats: ${JSON.stringify(link.stats)} parser ${JSON.stringify(link.parser.stats)}`);

function nextInputs() {
  return new Promise(r => link.addEventListener('inputs', e => r(e.detail), { once: true }));
}
