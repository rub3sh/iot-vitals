// XIAO ESP32C3 + MH-ET LIVE MAX30102 -> MQTT pulse oximeter node.
//
// Wiring (I2C):
//   MAX30102 VIN -> XIAO 3V3      MAX30102 SDA -> XIAO D4 (GPIO6)
//   MAX30102 GND -> XIAO GND      MAX30102 SCL -> XIAO D5 (GPIO7)
//
// NOT A MEDICAL DEVICE. Readings are uncalibrated and for learning only.

#include <Arduino.h>
#include <Wire.h>
#include <esp_system.h>
#include <Preferences.h>
#include <MAX30105.h>
#include "vitals.h"
#include "display.h"
#include "secrets.h"

// Bring-up build (`-e seeed_xiao_esp32c3_nonet`) drops the radio entirely so a
// sensor or wiring fault can be told apart from a WiFi or power problem.
#ifdef NO_NETWORK
namespace net {
  void begin() {}
  void loop()  {}
  bool connected() { return false; }
  int  rssi()      { return 0; }
  bool publish(const char*, const char*, bool = false) { return false; }
}
#else
#include "net.h"
#endif

// Per-board I2C pins, set from platformio.ini build flags.
// XIAO ESP32C3: D4/D5 = GPIO6/7.  ESP32 DevKit V1: GPIO21/22.
#ifndef I2C_SDA_PIN
#define I2C_SDA_PIN 6
#endif
#ifndef I2C_SCL_PIN
#define I2C_SCL_PIN 7
#endif
static const uint8_t  I2C_SDA = I2C_SDA_PIN;
static const uint8_t  I2C_SCL = I2C_SCL_PIN;

static const uint16_t SAMPLE_HZ    = 100;  // effective rate out of the FIFO
static const uint8_t  WAVE_DECIM   = 2;    // publish every 2nd sample -> 50 Hz
static const uint8_t  WAVE_BATCH   = 25;   // 25 samples @ 50 Hz -> 1 msg / 500 ms
static const uint32_t VITALS_EVERY = 1000; // ms

MAX30105     sensor;
VitalsEngine engine;
bool         sensorOk = false;

// Survives resets (not power loss). A count that climbs on its own means the
// board is rebooting; one that only moves when the serial port is opened means
// the chip is fine and it is just USB CDC dropping.
RTC_DATA_ATTR static uint32_t bootCount = 0;

int16_t  waveBuf[WAVE_BATCH];
uint8_t  waveCount  = 0;
uint8_t  decimCount = 0;
uint32_t lastVitals = 0;
char     payload[768];

// A device interrupted mid-transfer can hold SDA low indefinitely, which
// wedges the bus: every later transaction blocks and the board watchdogs.
// Clocking SCL up to nine times lets it finish the byte it believes it is
// sending and release the line. Must run before Wire.begin() takes the pins.
static bool recoverI2C() {
  pinMode(I2C_SDA, INPUT_PULLUP);
  pinMode(I2C_SCL, INPUT_PULLUP);
  delayMicroseconds(10);

  Serial.printf("[i2c] idle lines: SDA=%s SCL=%s\n",
                digitalRead(I2C_SDA) ? "high" : "LOW (stuck)",
                digitalRead(I2C_SCL) ? "high" : "LOW (stuck)");

  if (digitalRead(I2C_SDA) == HIGH) return true;   // nothing to recover

  Serial.println("[i2c] SDA held low — clocking the bus free");
  pinMode(I2C_SCL, OUTPUT_OPEN_DRAIN);
  digitalWrite(I2C_SCL, HIGH);
  for (uint8_t i = 0; i < 9 && digitalRead(I2C_SDA) == LOW; i++) {
    digitalWrite(I2C_SCL, LOW);  delayMicroseconds(5);
    digitalWrite(I2C_SCL, HIGH); delayMicroseconds(5);
  }
  // Manual STOP so the next transaction starts from a known state.
  pinMode(I2C_SDA, OUTPUT_OPEN_DRAIN);
  digitalWrite(I2C_SDA, LOW);  delayMicroseconds(5);
  digitalWrite(I2C_SCL, HIGH); delayMicroseconds(5);
  digitalWrite(I2C_SDA, HIGH); delayMicroseconds(5);

  pinMode(I2C_SDA, INPUT_PULLUP);
  pinMode(I2C_SCL, INPUT_PULLUP);
  bool freed = digitalRead(I2C_SDA) == HIGH;
  Serial.printf("[i2c] recovery %s\n", freed ? "succeeded" : "FAILED — check wiring");
  return freed;
}

static void scanI2C() {
  Serial.println("[i2c] scanning...");
  uint8_t found = 0;
  for (uint8_t addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      const char* who = addr == 0x57 ? "  <- MAX30102"
                      : (addr == 0x3C || addr == 0x3D) ? "  <- SSD1306 OLED" : "";
      Serial.printf("[i2c]   device at 0x%02X%s\n", addr, who);
      found++;
    }
    delay(1);   // keep the watchdog fed across a slow or marginal bus
  }
  if (found == 0) Serial.println("[i2c]   nothing found — check wiring and pull-ups");
}

void setup() {
  Serial.begin(115200);
  delay(1500);                       // let USB CDC enumerate before first print
  Serial.println("\n=== iot-vitals node: " DEVICE_ID " ===");
  bootCount++;

  // RTC RAM does not survive every reset type, so also keep a count in flash.
  // A flash count that climbs proves the chip is genuinely restarting rather
  // than the USB peripheral merely detaching.
  static const char* REASONS[] = {"unknown","poweron","ext","sw","panic",
                                  "int_wdt","task_wdt","wdt","deepsleep",
                                  "brownout","sdio"};
  Preferences prefs;
  prefs.begin("vitals", false);
  uint32_t flashBoots = prefs.getUInt("boots", 0) + 1;
  prefs.putUInt("boots", flashBoots);
  prefs.end();

  int rr = (int)esp_reset_reason();
  Serial.printf("[boot] rtc=%lu flash=%lu reason=%d(%s)\n",
                (unsigned long)bootCount, (unsigned long)flashBoots, rr,
                (rr >= 0 && rr <= 10) ? REASONS[rr] : "?");

  recoverI2C();
  Wire.begin(I2C_SDA, I2C_SCL);
  // 100 kHz: a second device plus longer jumpers adds bus capacitance, and
  // 400 kHz is where marginal wiring starts corrupting transfers.
  Wire.setClock(100000);
  Wire.setTimeOut(25);          // ms — never block the boot on a dead device
  scanI2C();

  // A missing sensor is reported, not fatal: the node still joins the network
  // and publishes its state, so a wiring fault is visible on the dashboard
  // instead of looking like a dead board.
  sensorOk = sensor.begin(Wire, I2C_SPEED_FAST);
  if (sensorOk) {
    // ledBrightness, sampleAverage, ledMode(2=red+IR), sampleRate, pulseWidth, adcRange.
    // 400 Hz averaged by 4 gives the 100 Hz stream the engine expects.
    //
    // adcRange 16384 (not the 4096 of most examples): a fingertip pressed on
    // this module reflects enough IR to peg the 18-bit ADC at 262143 on the
    // smaller range, which clips away the entire pulsatile signal. The wider
    // range trades quantisation for headroom, and the AC component is still
    // hundreds of counts.
    sensor.setup(0x3C, 4, 2, 400, 411, 16384);
    sensor.setPulseAmplitudeGreen(0);   // MAX30102 has no green LED
    Serial.println("[max30102] ready — place a fingertip over the sensor");
  } else {
    Serial.printf("[max30102] NOT FOUND — continuing without it. "
                  "Check 3V3, GND, SDA=GPIO%d, SCL=GPIO%d.\n", I2C_SDA, I2C_SCL);
  }
  engine.begin();

  // Optional 0.91" OLED on the same bus. Reported either way so a wiring
  // mistake is visible at boot rather than silently doing nothing.
  Serial.printf("[oled] %s\n", display::begin() ? "found" : "not found (optional)");
  display::message("iot-vitals", "connecting...");

  net::begin();
}

void loop() {
  net::loop();

  // Drain the FIFO. Doing this in a tight loop keeps latency low even if the
  // network layer stalls briefly.
  if (sensorOk) {
  sensor.check();
  while (sensor.available()) {
    uint32_t red = sensor.getFIFORed();
    uint32_t ir  = sensor.getFIFOIR();
    engine.update(red, ir);

    if (++decimCount >= WAVE_DECIM) {
      decimCount = 0;
      if (waveCount < WAVE_BATCH) waveBuf[waveCount++] = engine.waveformSample();
    }
    sensor.nextSample();
  }
  }

  // --- PPG waveform batch --------------------------------------------------
  if (waveCount >= WAVE_BATCH) {
    int n = snprintf(payload, sizeof(payload),
                     "{\"t\":%lu,\"fs\":%u,\"ppg\":[",
                     (unsigned long)millis(), SAMPLE_HZ / WAVE_DECIM);
    for (uint8_t i = 0; i < waveCount && n < (int)sizeof(payload) - 16; i++) {
      n += snprintf(payload + n, sizeof(payload) - n, "%s%d",
                    i ? "," : "", waveBuf[i]);
    }
    snprintf(payload + n, sizeof(payload) - n, "]}");
    net::publish("ppg", payload);
    waveCount = 0;
  }

  // --- beat intervals for HRV ----------------------------------------------
  // Published as they happen rather than on the 1 Hz tick, so no beat is lost
  // and the server sees true spacing.
  {
    uint16_t ibi[16];
    uint8_t  count = engine.takeIntervals(ibi, 16);
    if (count > 0) {
      int n = snprintf(payload, sizeof(payload), "{\"t\":%lu,\"ibi\":[",
                       (unsigned long)millis());
      for (uint8_t i = 0; i < count && n < (int)sizeof(payload) - 12; i++) {
        n += snprintf(payload + n, sizeof(payload) - n, "%s%u", i ? "," : "", ibi[i]);
      }
      snprintf(payload + n, sizeof(payload) - n, "]}");
      net::publish("ibi", payload);
    }
  }

  // --- vitals summary ------------------------------------------------------
  uint32_t now = millis();
  if (now - lastVitals >= VITALS_EVERY) {
    lastVitals = now;
    VitalsReading v = engine.read();

    snprintf(payload, sizeof(payload),
             "{\"t\":%lu,\"bpm\":%.1f,\"spo2\":%.1f,\"pi\":%.2f,"
             "\"finger\":%s,\"ir\":%lu,\"rdc\":%lu,\"rssi\":%d,\"up\":%lu}",
             (unsigned long)now, v.bpm, v.spo2, v.perfusion,
             v.fingerOn ? "true" : "false", (unsigned long)v.irDc, (unsigned long)v.redDc,
             net::rssi(), (unsigned long)(now / 1000),
             sensorOk ? "true" : "false", v.saturated ? "true" : "false");

    display::show(v, sensorOk, net::connected(), net::rssi());

    if (!net::publish("vitals", payload)) {
      // Offline: keep the reading visible on the serial monitor so the sensor
      // can still be tested without a broker.
      Serial.printf("[offline] %s\n", payload);
    } else if (v.saturated) {
      Serial.printf("[vitals] ADC SATURATED (ir=%lu) — reduce LED power\n",
                    (unsigned long)v.irDc);
    } else if (v.fingerOn) {
      Serial.printf("[vitals] bpm=%.1f spo2=%.1f pi=%.2f%%\n", v.bpm, v.spo2, v.perfusion);
    }
  }
}
