#pragma once
#include <Arduino.h>

// Sliding window for the SpO2 ratio-of-ratios estimate.
// 400 samples @ 100 Hz = 4 s, roughly four cardiac cycles. A 2 s window spans
// barely two, so a single irregular beat moved the ratio noticeably.
static const uint16_t VITALS_WINDOW = 400;
static const uint8_t  BEAT_HISTORY  = 8;   // intervals behind the BPM readout
static const uint8_t  SPO2_HISTORY  = 9;   // median filter over ~9 estimates

// IR DC level below which we assume no finger is on the sensor.
// Scaled for adcRange 16384, where counts are 4x coarser than the 4096 most
// examples use: the dark baseline sits near 250 and a fingertip lands in the
// tens of thousands, so this sits comfortably between the two.
static const uint32_t FINGER_THRESHOLD = 12000;

// The MAX30102's ADC is 18-bit, so 262143 is full scale. Sitting near it means
// the signal is clipped and every derived value is meaningless.
static const uint32_t SATURATION_LEVEL = 258000;

// Below this perfusion the ratio is dominated by noise; report nothing rather
// than a plausible-looking number. Above MAX_PERFUSION the window is not a
// pulse at all — a resting fingertip modulates the light by a few percent at
// most, so anything larger is the finger moving, not blood flowing.
static const float    MIN_PERFUSION = 0.15f;
static const float    MAX_PERFUSION = 8.0f;

struct VitalsReading {
  float    bpm        = 0.0f;   // 0 until enough beats agree
  float    spo2       = 0.0f;   // 0 until the signal supports it
  float    perfusion  = 0.0f;   // peak-to-peak AC / DC, as a percentage
  uint32_t irDc       = 0;
  uint32_t redDc      = 0;      // exposed to check red/IR LED balance
  bool     fingerOn   = false;
  bool     saturated  = false;  // ADC clipped — readings suppressed
};

class VitalsEngine {
 public:
  void  begin();
  bool  update(uint32_t red, uint32_t ir);
  int16_t waveformSample() const { return lastAc_; }
  VitalsReading read() const;

  // HRV is about the spacing between individual beats, so every accepted
  // interval has to survive rather than being folded into an average. They
  // queue here and the caller drains them each publish; returns how many were
  // written into `out`.
  uint8_t takeIntervals(uint16_t* out, uint8_t max);

 private:
  void recomputeRatio_();
  void resetDerived_();

  uint32_t redBuf_[VITALS_WINDOW] = {0};
  uint32_t irBuf_[VITALS_WINDOW]  = {0};
  uint16_t head_        = 0;
  uint16_t filled_      = 0;
  uint16_t sinceRatio_  = 0;
  uint16_t settle_      = 0;   // samples since contact began
  uint64_t redSum_      = 0;
  uint64_t irSum_       = 0;

  float    irBaseline_ = 0.0f;   // fast EMA, only to centre the waveform
  int16_t  lastAc_     = 0;

  // --- cardiac bandpass ---
  // A fast EMA (low-pass, ~4 Hz) minus a slow one (high-pass, ~0.16 Hz) leaves
  // the 0.16-4 Hz band a pulse actually lives in. Measuring AC on the raw
  // signal instead sums every bit of out-of-band noise into the amplitude,
  // which inflates R on the weaker red channel and drags SpO2 to the floor.
  float    redFast_ = 0.0f, redSlow_ = 0.0f;
  float    irFast_  = 0.0f, irSlow_  = 0.0f;
  float    redAcBuf_[VITALS_WINDOW] = {0};
  float    irAcBuf_[VITALS_WINDOW]  = {0};

  // --- beat timing ---
  uint32_t lastBeatMs_ = 0;
  float    ibiHistory_[BEAT_HISTORY] = {0};
  uint8_t  ibiCount_   = 0;
  uint8_t  ibiHead_    = 0;

  static const uint8_t PENDING_MAX = 16;   // ~5 s of beats at 200 bpm
  uint16_t pending_[PENDING_MAX] = {0};
  uint8_t  pendingCount_ = 0;

  // --- smoothed outputs ---
  // Two stages: a median to throw out single bad estimates outright, then an
  // EMA so what is left moves gradually instead of stepping every second.
  float    spo2Hist_[SPO2_HISTORY] = {0};
  uint8_t  spo2Count_  = 0;
  uint8_t  spo2Head_   = 0;
  float    spo2Smooth_ = 0.0f;
  float    bpmSmooth_  = 0.0f;
  float    piSmooth_   = 0.0f;

  uint32_t irDc_      = 0;
  uint32_t redDc_     = 0;
  bool     fingerOn_  = false;
  bool     saturated_ = false;
};
