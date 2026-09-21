#include "vitals.h"
#include <heartRate.h>   // checkForBeat(), from the SparkFun MAX3010x library
#include <math.h>
#include <string.h>

// Median of up to 16 values. Used instead of a mean wherever a single bad
// sample would otherwise drag the output: one missed or doubled beat, or one
// noisy ratio window, should not move the number a reader is watching.
static float medianOf(const float* src, uint8_t n) {
  if (n == 0) return 0.0f;
  float tmp[16];
  if (n > 16) n = 16;
  for (uint8_t i = 0; i < n; i++) tmp[i] = src[i];
  for (uint8_t i = 1; i < n; i++) {           // insertion sort, n <= 16
    float key = tmp[i];
    int8_t j = i - 1;
    while (j >= 0 && tmp[j] > key) { tmp[j + 1] = tmp[j]; j--; }
    tmp[j + 1] = key;
  }
  return (n & 1) ? tmp[n / 2] : 0.5f * (tmp[n / 2 - 1] + tmp[n / 2]);
}

void VitalsEngine::begin() {
  head_ = filled_ = sinceRatio_ = settle_ = 0;
  redSum_ = irSum_ = 0;
  irBaseline_ = 0.0f;
  redFast_ = redSlow_ = irFast_ = irSlow_ = 0.0f;
  lastBeatMs_ = 0;
  resetDerived_();
  fingerOn_ = saturated_ = false;
}

// Everything downstream of contact. Called when the finger lifts so a stale
// reading never lingers on the dashboard as if it were current.
uint8_t VitalsEngine::takeIntervals(uint16_t* out, uint8_t max) {
  uint8_t n = pendingCount_ < max ? pendingCount_ : max;
  for (uint8_t i = 0; i < n; i++) out[i] = pending_[i];
  // Anything not taken is dropped: a caller that cannot keep up should lose
  // old beats rather than accumulate a backlog that skews the next window.
  pendingCount_ = 0;
  return n;
}

void VitalsEngine::resetDerived_() {
  ibiCount_ = ibiHead_ = 0;
  pendingCount_ = 0;
  spo2Count_ = spo2Head_ = 0;
  spo2Smooth_ = bpmSmooth_ = piSmooth_ = 0.0f;
}

bool VitalsEngine::update(uint32_t red, uint32_t ir) {
  // --- sliding window bookkeeping -----------------------------------------
  if (filled_ == VITALS_WINDOW) {
    redSum_ -= redBuf_[head_];
    irSum_  -= irBuf_[head_];
  } else {
    filled_++;
  }
  redBuf_[head_] = red;
  irBuf_[head_]  = ir;
  redSum_ += red;
  irSum_  += ir;

  irDc_  = (uint32_t)(irSum_ / filled_);
  redDc_ = (uint32_t)(redSum_ / filled_);
  saturated_ = irDc_ >= SATURATION_LEVEL;

  // Bandpass both channels into the cardiac band before any amplitude is
  // measured from them. Seed on the first sample so the filters do not spend
  // seconds ramping up from zero.
  if (irFast_ == 0.0f) { irFast_ = irSlow_ = (float)ir; redFast_ = redSlow_ = (float)red; }
  irFast_  += 0.25f * ((float)ir  - irFast_);
  irSlow_  += 0.01f * ((float)ir  - irSlow_);
  redFast_ += 0.25f * ((float)red - redFast_);
  redSlow_ += 0.01f * ((float)red - redSlow_);
  irAcBuf_[head_]  = irFast_  - irSlow_;
  redAcBuf_[head_] = redFast_ - redSlow_;
  head_ = (head_ + 1) % VITALS_WINDOW;

  bool nowOn = ir > FINGER_THRESHOLD;
  if (nowOn != fingerOn_) {
    // Placing or lifting a finger steps the DC by tens of thousands of counts.
    // That edge dwarfs the pulse and, once inside the analysis window, produced
    // nonsense like a 452% perfusion index. Restart the clock on contact and
    // ignore the window until the transient has aged out of it entirely.
    settle_ = 0;
    if (!nowOn) resetDerived_();
  } else if (fingerOn_ && settle_ < VITALS_WINDOW) {
    settle_++;
  }
  fingerOn_ = nowOn;

  // --- display waveform ----------------------------------------------------
  if (irBaseline_ == 0.0f) irBaseline_ = (float)ir;
  irBaseline_ += 0.02f * ((float)ir - irBaseline_);
  float ac = (float)ir - irBaseline_;
  lastAc_ = (int16_t)constrain(ac, -32000.0f, 32000.0f);

  // --- beat detection ------------------------------------------------------
  bool beat = false;
  if (fingerOn_ && !saturated_ && checkForBeat((long)ir)) {
    uint32_t now = millis();
    if (lastBeatMs_ != 0) {
      uint32_t ibi = now - lastBeatMs_;
      // Physiologically plausible only (30-200 BPM); rejects most artefacts.
      if (ibi >= 300 && ibi <= 2000) {
        // Queue the raw interval for HRV before it is averaged away. Dropping
        // the oldest on overflow keeps the most recent beats, which is what a
        // rolling HRV window wants.
        if (pendingCount_ < PENDING_MAX) {
          pending_[pendingCount_++] = (uint16_t)ibi;
        } else {
          memmove(pending_, pending_ + 1, (PENDING_MAX - 1) * sizeof(uint16_t));
          pending_[PENDING_MAX - 1] = (uint16_t)ibi;
        }

        ibiHistory_[ibiHead_] = (float)ibi;
        ibiHead_ = (ibiHead_ + 1) % BEAT_HISTORY;
        if (ibiCount_ < BEAT_HISTORY) ibiCount_++;
        beat = true;

        // Median interval, not mean: a single dropped beat doubles one
        // interval, which would drag a mean down by ~10 BPM but leaves the
        // median untouched.
        if (ibiCount_ >= 3) {
          float medIbi = medianOf(ibiHistory_, ibiCount_);
          if (medIbi > 0.0f) {
            float raw = 60000.0f / medIbi;
            bpmSmooth_ = (bpmSmooth_ == 0.0f) ? raw
                                              : bpmSmooth_ + 0.25f * (raw - bpmSmooth_);
          }
        }
      }
    }
    lastBeatMs_ = now;
  }

  if (++sinceRatio_ >= 100) {   // ~1 Hz at a 100 Hz sample rate
    sinceRatio_ = 0;
    recomputeRatio_();
  }
  return beat;
}

// Ratio-of-ratios pulse oximetry:
//   R = (AC_red / DC_red) / (AC_ir / DC_ir)
// Oxygenated and deoxygenated haemoglobin absorb red (660 nm) and infrared
// (880 nm) light differently, so R tracks oxygen saturation. The polynomial
// is Maxim's empirical curve for this sensor family — good for trends, not
// traceable to a calibrated reference.
void VitalsEngine::recomputeRatio_() {
  if (!fingerOn_ || saturated_ || filled_ < VITALS_WINDOW ||
      settle_ < VITALS_WINDOW) {
    piSmooth_ = 0.0f;
    spo2Smooth_ = 0.0f;
    return;
  }

  float redMean = (float)redSum_ / filled_;
  float irMean  = (float)irSum_  / filled_;
  if (redMean <= 0.0f || irMean <= 0.0f) return;

  double redSq = 0.0, irSq = 0.0;
  float irMin = 1e30f, irMax = -1e30f;
  for (uint16_t i = 0; i < filled_; i++) {
    redSq += (double)redAcBuf_[i] * redAcBuf_[i];
    irSq  += (double)irAcBuf_[i]  * irAcBuf_[i];
    if (irAcBuf_[i] < irMin) irMin = irAcBuf_[i];
    if (irAcBuf_[i] > irMax) irMax = irAcBuf_[i];
  }
  float redAc = sqrtf((float)(redSq / filled_));
  float irAc  = sqrtf((float)(irSq  / filled_));

  // Perfusion index is conventionally peak-to-peak AC over DC, which is what
  // commercial oximeters display. RMS understates it by roughly 3x.
  float rawPi = ((irMax - irMin) / irMean) * 100.0f;
  if (rawPi > MAX_PERFUSION) {        // movement, not circulation
    piSmooth_ = 0.0f;
    spo2Smooth_ = 0.0f;
    spo2Count_ = spo2Head_ = 0;
    return;
  }
  // Motion is the dominant error source here, and it is insidious: shifting
  // the finger changes the optical path rather than the oxygenation, and it
  // modulates red and IR almost equally. That drives R toward 1, which the
  // polynomial maps to a confident-looking ~80% — indistinguishable from real
  // hypoxia unless it is caught. A window whose pulse amplitude has jumped
  // against the running average is movement, so let it update the perfusion
  // readout (that is what PI is for) but keep it out of the SpO2 estimate.
  bool steady = (piSmooth_ == 0.0f) ||
                (fabsf(rawPi - piSmooth_) <= 0.60f * piSmooth_);
  piSmooth_ = (piSmooth_ == 0.0f) ? rawPi : piSmooth_ + 0.25f * (rawPi - piSmooth_);
  if (!steady) return;

  // Too little pulsatile signal for the ratio to mean anything. Reporting
  // nothing beats reporting a number that swings across the whole clamp range.
  if (piSmooth_ < MIN_PERFUSION || irAc <= 0.0f) {
    spo2Smooth_ = 0.0f;
    spo2Count_ = spo2Head_ = 0;
    return;
  }

  float r = (redAc / redMean) / (irAc / irMean);
  float raw = constrain(-45.060f * r * r + 30.354f * r + 94.845f, 70.0f, 100.0f);

  spo2Hist_[spo2Head_] = raw;
  spo2Head_ = (spo2Head_ + 1) % SPO2_HISTORY;
  if (spo2Count_ < SPO2_HISTORY) spo2Count_++;

  // Hold back until the median has something to work with, then median first
  // (discards outliers outright) and EMA second (keeps the rest from stepping).
  if (spo2Count_ < 3) return;
  float med = medianOf(spo2Hist_, spo2Count_);
  spo2Smooth_ = (spo2Smooth_ == 0.0f) ? med : spo2Smooth_ + 0.20f * (med - spo2Smooth_);
}

VitalsReading VitalsEngine::read() const {
  VitalsReading v;
  v.irDc      = irDc_;
  v.redDc     = redDc_;
  v.fingerOn  = fingerOn_;
  v.saturated = saturated_;
  v.perfusion = piSmooth_;
  v.spo2      = spo2Smooth_;
  if (fingerOn_ && !saturated_ && ibiCount_ >= 3) v.bpm = bpmSmooth_;
  return v;
}
