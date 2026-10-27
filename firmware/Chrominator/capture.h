// Chrominator — analog Capture engine (included by Chrominator.ino after its state is declared).
//
// Every CAPTURE_PERIOD_US the ADC converts each channel whose pin is in ANALOG or CAPTURE mode.
// On the Uno this is driven by the ADC-complete interrupt so the main loop never waits on it; on
// the Nano R4 (CAPTURE_POLL) loop() runs each tick that is due with analogRead().
// CAPTURE channels are packed CAP_BITS bits per sample into CAP_BLOCK_SAMPLES-sample blocks
// (Uno: 10 bits x 32, Nano R4: 14 bits x 8); loop() sends each finished block as one EVT_CAPTURE
// frame per channel. Up to CAP_RING_BLOCKS blocks are queued.
// While capture is running, READ_ALL takes its ADC values from this scan instead of analogRead().
#pragma once

// Defaults are the Uno's; board_config.h may override them.
#ifndef CAP_BLOCK_SAMPLES
  #define CAP_BLOCK_SAMPLES 32
#endif
#ifndef CAP_RING_BLOCKS
  #define CAP_RING_BLOCKS   4
#endif
#ifndef CAP_BITS
  #define CAP_BITS          10
#endif
#define CAP_CH_BYTES      ((CAP_BLOCK_SAMPLES * CAP_BITS + 7) / 8)     // Uno 40, Nano R4 14 bytes per channel per block
#if 5 + CAP_CH_BYTES > MAX_DATA
  #error "Capture block does not fit in one frame: reduce CAP_BLOCK_SAMPLES"
#endif

#if CAPTURE_IMPL != CAPTURE_NONE
static uint8_t  capRing[CAP_RING_BLOCKS][NUM_ADC][CAP_CH_BYTES];      // 960 B on the Uno
static uint16_t capRingSeq[CAP_RING_BLOCKS];
static volatile uint8_t  capFill = 0;      // block the ISR is filling
static volatile uint8_t  capReady = 0;     // finished blocks waiting to be sent
static volatile uint8_t  capTick = 0;      // sample position in the block being filled
static volatile uint16_t capSeq = 0;       // number of the block being filled (wraps)
static volatile uint16_t adcLatest[NUM_ADC];
static volatile bool     adcBusy = false;
static volatile uint8_t  scanIdx = 0;
static uint8_t  scanCh[NUM_ADC];           // channels converted each tick
static uint8_t  scanN = 0;
static uint16_t capMask = 0;               // bit n = ADC channel n is in CAPTURE mode
static bool     capOn = false;
static uint16_t capOverruns = 0;           // ticks skipped because the previous scan was still running
static uint16_t capDropped = 0;            // blocks lost because the queue was full

// ---- called from interrupt context ----
static inline void capStore(uint8_t *buf, uint8_t k, uint16_t v) {
  uint16_t bit = (uint16_t)k * CAP_BITS;
#if CAP_BITS <= 10
  uint16_t w = v << (bit & 7);                       // shift <= 6, so 10 bits fit in 16
  buf[bit >> 3]       |= (uint8_t)w;
  buf[(bit >> 3) + 1] |= (uint8_t)(w >> 8);
#else
  uint32_t w = (uint32_t)(v & ((1u << CAP_BITS) - 1)) << (bit & 7);   // up to 16 + 7 bits
  buf[bit >> 3]       |= (uint8_t)w;
  buf[(bit >> 3) + 1] |= (uint8_t)(w >> 8);
  if ((bit & 7) + CAP_BITS > 16) buf[(bit >> 3) + 2] |= (uint8_t)(w >> 16);
#endif
}

static inline void capOnResult(uint8_t ch, uint16_t v) {
  adcLatest[ch] = v;
  if (capMask & (1u << ch)) capStore(capRing[capFill][ch], capTick, v);
}

static inline void capOnTickDone() {
  if (++capTick < CAP_BLOCK_SAMPLES) return;
  capTick = 0;
  if (capReady < CAP_RING_BLOCKS - 1) {
    capRingSeq[capFill] = capSeq;
    capFill = (capFill + 1) % CAP_RING_BLOCKS;
    capReady++;
  } else {
    capDropped++;                                    // queue full: overwrite this block
  }
  capSeq++;                                          // the host sees the gap in block numbers
  memset(capRing[capFill], 0, sizeof capRing[0]);
}

// ---- board-specific timer + ADC driving ----
#if CAPTURE_IMPL == CAPTURE_AVR
  // Tick = Timer0 compare-match A. Timer0 already runs millis() and the PWM on D5/D6 at
  // 16 MHz / 64 / 256 = 976.5625 Hz; the compare interrupt piggybacks on it, so no timer
  // (and no PWM pin) is taken away. Writing a new PWM duty to D6 moves the compare point,
  // which can shift one sample by up to a period.
  static inline void adcStart(uint8_t ch) { ADMUX = _BV(REFS0) | (ch & 0x07); ADCSRA |= _BV(ADSC); }

  ISR(TIMER0_COMPA_vect) {
    if (adcBusy) { capOverruns++; return; }
    adcBusy = true;
    scanIdx = 0;
    adcStart(scanCh[0]);
  }

  ISR(ADC_vect) {
    uint16_t v = ADC;
    capOnResult(scanCh[scanIdx], v);
    if (++scanIdx < scanN) adcStart(scanCh[scanIdx]);
    else { adcBusy = false; capOnTickDone(); }
  }

  static void halStart() { ADCSRA |= _BV(ADIE); TIFR0 = _BV(OCF0A); TIMSK0 |= _BV(OCIE0A); }
  static void halStop() {
    uint8_t s = SREG; cli();
    TIMSK0 &= ~_BV(OCIE0A);
    ADCSRA &= ~_BV(ADIE);
    SREG = s;
    while (ADCSRA & _BV(ADSC)) {}                    // let a conversion in progress finish
    ADCSRA |= _BV(ADIF);                             // clear its flag so analogRead() starts clean
    adcBusy = false;
  }
  static void halPoll() {}
  #define CAP_ATOMIC_BEGIN  { uint8_t _sreg = SREG; cli();
  #define CAP_ATOMIC_END    SREG = _sreg; }

#elif CAPTURE_IMPL == CAPTURE_SIM || CAPTURE_IMPL == CAPTURE_POLL
  // No interrupts: loop() runs the ticks that are due, timed with micros(). Used by the PC
  // simulator and by the Nano R4 (RA4M1), where analogRead() is fast enough for 100 samples/s
  // on all eight channels. A sample is taken within one loop() pass of its scheduled time;
  // the host plots it at the scheduled time.
  static uint32_t pollNext;
  static void halStart() { pollNext = micros(); }
  static void halStop() {}
  static void halPoll() {
    uint32_t now = micros();
    if ((int32_t)(now - pollNext) > 100000L) { capOverruns++; pollNext = now; }   // way behind: resync
    while ((int32_t)(now - pollNext) >= 0) {
  #if CAPTURE_IMPL == CAPTURE_SIM
      simAdcClockUs = pollNext;                        // sample the simulated signal at the tick's time
  #endif
      for (uint8_t i = 0; i < scanN; i++) capOnResult(scanCh[i], (uint16_t)analogRead(ADC_PIN[scanCh[i]]));
  #if CAPTURE_IMPL == CAPTURE_SIM
      simAdcClockUs = 0;
  #endif
      capOnTickDone();
      pollNext += CAPTURE_PERIOD_US;
    }
  }
  #define CAP_ATOMIC_BEGIN  {
  #define CAP_ATOMIC_END    }
#endif

// ---- called from loop() ----

// Re-read pin modes and (re)start or stop the engine. Call after any pin mode change.
static void capConfigure() {
  if (capOn) { halStop(); capOn = false; }
  capMask = 0; scanN = 0;
  for (uint8_t ch = 0; ch < NUM_ADC; ch++) {
    uint8_t m = pinMode_[ADC_PIN[ch]];
    if (m == M_CAPTURE) capMask |= (uint16_t)(1u << ch);
    if (m == M_CAPTURE || m == M_ANALOG) scanCh[scanN++] = ch;
  }
  capTick = 0; capReady = 0; capFill = 0;
  memset(capRing, 0, sizeof capRing);
  if (capMask) { capOn = true; halStart(); }
}

// ADC value for READ_ALL. Only channels in ANALOG mode are converted here: on the R4 core
// analogRead() switches the pin to its analog function, which would break an A-pin in digital
// use. Other channels report 0 (the host ignores them).
static uint16_t capAdcValue(uint8_t ch) {
  if (!capOn) return pinMode_[ADC_PIN[ch]] == M_ANALOG ? (uint16_t)analogRead(ADC_PIN[ch]) : 0;
  uint16_t v;
  CAP_ATOMIC_BEGIN
  v = adcLatest[ch];
  CAP_ATOMIC_END
  return v;
}

// Send at most one finished block per call, so incoming commands keep being serviced.
static void capService() {
  if (!capOn) return;
  halPoll();
  uint8_t ready, fill;
  CAP_ATOMIC_BEGIN
  ready = capReady; fill = capFill;
  CAP_ATOMIC_END
  if (!ready) return;
  uint8_t b = (uint8_t)((fill + CAP_RING_BLOCKS - ready) % CAP_RING_BLOCKS);
  uint8_t frame[5 + CAP_CH_BYTES];
  for (uint8_t ch = 0; ch < NUM_ADC; ch++) {
    if (!(capMask & (1u << ch))) continue;
    frame[0] = capRingSeq[b] & 0xFF; frame[1] = capRingSeq[b] >> 8;
    frame[2] = ch; frame[3] = CAP_BLOCK_SAMPLES; frame[4] = CAP_BITS;
    memcpy(frame + 5, capRing[b][ch], CAP_CH_BYTES);
    sendFrame(0, EVT_CAPTURE, frame, sizeof frame);
  }
  CAP_ATOMIC_BEGIN
  capReady--;
  CAP_ATOMIC_END
}

#else   // board without a capture implementation
static void capConfigure() {}
static void capService() {}
// Only convert channels whose pin is in ANALOG mode. On the Renesas (R4) core analogRead()
// switches the pin to its analog function, which would silently break an A-pin being used as a
// digital input or output. Other channels report 0 (the host ignores them).
static uint16_t capAdcValue(uint8_t ch) {
  if (pinMode_[ADC_PIN[ch]] != M_ANALOG) return 0;
  return (uint16_t)analogRead(ADC_PIN[ch]);
}
static const uint16_t capOverruns = 0, capDropped = 0;
#endif
