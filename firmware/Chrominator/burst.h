// Chrominator — Burst capture (included by Chrominator.ino after capture.h).
//
// One ADC channel is sampled as fast as the ATmega328P allows, with the ADC free-running
// (a new conversion starts the moment the last one ends, so the sample clock is exact):
//
//   rate code  prescaler  ADC clock  period   rate         stored        samples  window
//   0          16         1 MHz      13 us    76.9 kS/s    8-bit (ADCH)  1024     13.3 ms
//   1          32         500 kHz    26 us    38.5 kS/s    8-bit         1024     26.6 ms
//   2          64         250 kHz    52 us    19.2 kS/s    10-bit        512      26.6 ms
//   3          128        125 kHz    104 us   9.6 kS/s     10-bit        512      53.2 ms
//
// Samples go into a circular buffer (sampleMem, shared with streaming capture) from the moment
// the burst is armed, so pre-trigger history is always available. When the trigger fires, the
// remaining post-trigger samples are taken and the ADC is stopped. loop() then sends one
// EVT_BURST_INFO frame and the samples as EVT_BURST_DATA frames, oldest first, and restarts
// streaming capture. Streaming capture is paused for the whole burst.
#pragma once

#define BURST_RATES       4
#define BURST_HYST_8      2       // trigger hysteresis, counts (about 1% of full scale)
#define BURST_HYST_10     8
#define BURST_CHUNK_8     40      // samples per EVT_BURST_DATA frame
#define BURST_CHUNK_10    20

enum BurstTrig : uint8_t { TRIG_NONE = 0, TRIG_RISING = 1, TRIG_FALLING = 2 };
enum BurstPhase : uint8_t { BP_IDLE, BP_SAMPLING, BP_CAPTURED, BP_SENDING };
enum BurstResult : uint8_t { BR_OK = 0, BR_TIMEOUT = 1, BR_CANCELLED = 2 };

static const uint8_t  BURST_BITS[BURST_RATES]      = { 8, 8, 10, 10 };
static const uint8_t  BURST_PERIOD_US[BURST_RATES] = { 13, 26, 52, 104 };

static volatile uint8_t  bPhase = BP_IDLE;
static volatile uint16_t bW = 0;            // samples written so far (buffer index = bW & mask)
static volatile uint16_t bTrigAt = 0;       // value of bW - 1 when the trigger fired
static volatile uint16_t bRemaining = 0;    // post-trigger samples still to take
static volatile bool     bTriggered = false, bArmed = false;
static uint8_t  bCh, bRate, bTrig, bId = 0;
static bool     b8;                         // storing 8-bit samples
static uint16_t bN, bMask, bPre, bLevel, bArmLow, bArmHigh, bTimeoutMs, bSendPos;
static uint32_t bStartMs;

static bool burstBusy() { return bPhase != BP_IDLE; }

// ---- sample handling: called from the ADC interrupt (AVR) or the simulator's poll ----
static inline void burstFinishSampling();

static inline void burstSample(uint16_t v) {
  uint16_t w = bW;
  if (b8) sampleMem[w & bMask] = (uint8_t)v;
  else ((uint16_t *)sampleMem)[w & bMask] = v;
  bW = ++w;
  adcLatest[bCh] = b8 ? (v << 2) : v;

  if (bTriggered) {
    if (--bRemaining == 0) burstFinishSampling();
    return;
  }
  bool fire;
  switch (bTrig) {
    case TRIG_RISING:
      if (v < bArmLow) bArmed = true;
      fire = bArmed && v >= bLevel && w > bPre;
      break;
    case TRIG_FALLING:
      if (v > bArmHigh) bArmed = true;
      fire = bArmed && v <= bLevel && w > bPre;
      break;
    default:
      fire = true;                                   // no trigger: bPre is 0, start at once
  }
  if (!fire) return;
  bTriggered = true;
  bTrigAt = w - 1;
  bRemaining = bN - bPre - 1;
  if (bRemaining == 0) burstFinishSampling();
}

// ---- board-specific ADC driving ----
#if CAPTURE_IMPL == CAPTURE_AVR
  static const uint8_t BURST_PS[BURST_RATES] = {
    _BV(ADPS2),                         // /16
    _BV(ADPS2) | _BV(ADPS0),            // /32
    _BV(ADPS2) | _BV(ADPS1),            // /64
    _BV(ADPS2) | _BV(ADPS1) | _BV(ADPS0)// /128
  };
  static inline void burstAdcIsr() { burstSample(b8 ? ADCH : ADC); }

  static void burstHalStart() {
    uint8_t s = SREG; cli();
    ADCSRA = 0;
    ADMUX  = _BV(REFS0) | (b8 ? _BV(ADLAR) : 0) | (bCh & 0x07);   // AVcc ref; ADLAR: 8 bits in ADCH
    ADCSRB = 0;                                                     // auto-trigger source: free running
    burstSampling = true;
    ADCSRA = _BV(ADEN) | _BV(ADIF) | _BV(ADIE) | _BV(ADATE) | BURST_PS[bRate];
    ADCSRA |= _BV(ADSC);
    SREG = s;
  }
  static void burstHalStop() {
    uint8_t s = SREG; cli();
    burstSampling = false;
    // Back to the Arduino core's settings: single conversions, /128, right-adjusted, no interrupt.
    ADCSRA = _BV(ADEN) | _BV(ADIF) | _BV(ADPS2) | _BV(ADPS1) | _BV(ADPS0);
    ADMUX  = _BV(REFS0);
    SREG = s;
  }
  static void burstHalPoll() {}
  #define B_ATOMIC_BEGIN  { uint8_t _sreg = SREG; cli();
  #define B_ATOMIC_END    SREG = _sreg; }

#elif CAPTURE_IMPL == CAPTURE_SIM
  // Simulator: loop() takes the samples that are due, each at its exact scheduled time.
  static uint32_t bSimNext;
  static void burstHalStart() { burstSampling = true; bSimNext = micros(); }
  static void burstHalStop() { burstSampling = false; }
  static void burstHalPoll() {
    uint32_t now = micros();
    while (burstSampling && (int32_t)(now - bSimNext) >= 0) {
      simAdcClockUs = bSimNext;
      uint16_t v = (uint16_t)analogRead(ADC_PIN[bCh]);
      simAdcClockUs = 0;
      burstSample(b8 ? (v >> 2) : v);
      bSimNext += BURST_PERIOD_US[bRate];
    }
  }
  #define B_ATOMIC_BEGIN  {
  #define B_ATOMIC_END    }
#endif

#if CAPTURE_IMPL != CAPTURE_NONE

static inline void burstFinishSampling() {
  burstHalStop();
  bPhase = BP_CAPTURED;
}

static void burstSendInfo(uint8_t result) {
  uint8_t f[12];
  uint32_t periodNs = (uint32_t)BURST_PERIOD_US[bRate] * 1000UL;
  uint16_t n = result == BR_OK ? bN : 0;
  f[0] = bId; f[1] = result; f[2] = bCh; f[3] = BURST_BITS[bRate];
  f[4] = n & 0xFF; f[5] = n >> 8;
  f[6] = bPre & 0xFF; f[7] = bPre >> 8;                       // index of the trigger sample
  f[8] = periodNs & 0xFF; f[9] = (periodNs >> 8) & 0xFF; f[10] = (periodNs >> 16) & 0xFF; f[11] = periodNs >> 24;
  sendFrame(0, EVT_BURST_INFO, f, sizeof f);
}

// Stop any burst and give the ADC and sampleMem back to streaming capture.
static void burstAbort(uint8_t result) {
  bool wasActive = bPhase == BP_SAMPLING;
  if (bPhase == BP_SAMPLING) burstHalStop();
  bool any = bPhase != BP_IDLE;
  bPhase = BP_IDLE;
  if (wasActive) burstSendInfo(result);
  if (any) capConfigure();
}

// BURST_START: ch, rate, trigger, level (u16, 10-bit counts), pre-trigger %, timeout ms (u16, 0 = none)
static uint8_t burstStart(const uint8_t *d) {
  uint8_t ch = d[0], rate = d[1], trig = d[2], pre = d[5];
  uint16_t level = d[3] | (d[4] << 8), timeout = d[6] | (d[7] << 8);
  if (ch >= NUM_ADC) return ST_BAD_PIN;
  uint8_t m = pinMode_[ADC_PIN[ch]];
  if (m == M_OUTPUT || m == M_PWM) return ST_WRONG_MODE;
  if (rate >= BURST_RATES || trig > TRIG_FALLING || pre > 90 || level > 1023) return ST_BAD_VALUE;

  burstAbort(BR_CANCELLED);                     // a new start replaces any burst in progress
  capStop();                                    // streaming capture pauses; sampleMem is ours

  bCh = ch; bRate = rate; bTrig = trig; bTimeoutMs = timeout;
  b8 = BURST_BITS[rate] == 8;
  bN = b8 ? SAMPLE_MEM_BYTES : SAMPLE_MEM_BYTES / 2;
  bMask = bN - 1;
  bPre = trig == TRIG_NONE ? 0 : (uint16_t)((uint32_t)bN * pre / 100);
  uint16_t hyst = b8 ? BURST_HYST_8 : BURST_HYST_10;
  bLevel = b8 ? (level >> 2) : level;
  bArmLow = bLevel > hyst ? bLevel - hyst : 0;
  bArmHigh = bLevel + hyst;
  bW = 0; bTriggered = false; bArmed = false; bSendPos = 0;
  bId++;
  bStartMs = millis();
  bPhase = BP_SAMPLING;
  burstHalStart();
  return ST_OK;
}

// Called from loop(): timeout, then INFO, then one DATA frame per call.
static void burstService() {
  if (bPhase == BP_IDLE) return;
  burstHalPoll();
  if (bPhase == BP_SAMPLING) {
    if (bTimeoutMs && (uint32_t)(millis() - bStartMs) > bTimeoutMs) burstAbort(BR_TIMEOUT);
    return;
  }
  if (bPhase == BP_CAPTURED) {
    burstSendInfo(BR_OK);
    bPhase = BP_SENDING;
    bSendPos = 0;
    return;
  }
  // BP_SENDING: oldest sample first; sample bPre is the trigger.
  uint16_t first = bTrigAt - bPre;
  uint8_t chunk = b8 ? BURST_CHUNK_8 : BURST_CHUNK_10;
  uint16_t left = bN - bSendPos;
  uint8_t count = left < chunk ? (uint8_t)left : chunk;
  uint8_t f[4 + BURST_CHUNK_8];
  f[0] = bId; f[1] = bSendPos & 0xFF; f[2] = bSendPos >> 8; f[3] = count;
  for (uint8_t i = 0; i < count; i++) {
    uint16_t idx = (first + bSendPos + i) & bMask;
    if (b8) f[4 + i] = sampleMem[idx];
    else { uint16_t v = ((uint16_t *)sampleMem)[idx]; f[4 + 2 * i] = v & 0xFF; f[5 + 2 * i] = v >> 8; }
  }
  sendFrame(0, EVT_BURST_DATA, f, 4 + (b8 ? count : 2 * count));
  bSendPos += count;
  if (bSendPos >= bN) { bPhase = BP_IDLE; capConfigure(); }
}

#define BURST_SAMPLES_8   SAMPLE_MEM_BYTES

#else   // no burst on this board
static void burstAbort(uint8_t) {}
static uint8_t burstStart(const uint8_t *) { return ST_UNKNOWN_CMD; }
static void burstService() {}
#define BURST_SAMPLES_8   0
#endif
