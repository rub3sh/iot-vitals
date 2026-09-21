#include "display.h"
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

namespace display {
namespace {

const uint8_t  WIDTH   = 128;
const uint8_t  HEIGHT  = 32;
const uint8_t  ADDR_A  = 0x3C;   // nearly all 0.91" modules
const uint8_t  ADDR_B  = 0x3D;   // a few are strapped high

Adafruit_SSD1306 oled(WIDTH, HEIGHT, &Wire, -1);
bool ok = false;

// Centre a string horizontally for the current text size.
void centred(const char* s, int16_t y, uint8_t size) {
  oled.setTextSize(size);
  int16_t w = strlen(s) * 6 * size;
  oled.setCursor((WIDTH - w) / 2, y);
  oled.print(s);
}

// Signal strength as a four-bar meter in the top-right corner. Bars read at a
// glance from across a desk in a way that "-61 dBm" does not.
void wifiBars(int rssi, bool netUp) {
  const int16_t x = WIDTH - 10, y = 0;
  if (!netUp) {
    oled.drawLine(x, y + 5, x + 8, y + 5, SSD1306_WHITE);  // dash = no link
    return;
  }
  uint8_t bars = rssi >= -55 ? 4 : rssi >= -65 ? 3 : rssi >= -75 ? 2 : 1;
  for (uint8_t i = 0; i < 4; i++) {
    int16_t h = 2 + i * 2;
    if (i < bars) oled.fillRect(x + i * 2, y + 8 - h, 1, h, SSD1306_WHITE);
    else          oled.drawPixel(x + i * 2, y + 7, SSD1306_WHITE);
  }
}

}  // namespace

// Adafruit_SSD1306::begin() returns true whenever it can allocate its buffer —
// it does not check that anything on the bus actually answered. Probe for a
// real ACK first, or a missing display reports itself as present and we spend
// I2C bandwidth writing into the void once a second.
static bool acks(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission() == 0;
}

bool begin() {
  uint8_t addr = acks(ADDR_A) ? ADDR_A : acks(ADDR_B) ? ADDR_B : 0;
  if (addr == 0) { ok = false; return false; }

  ok = oled.begin(SSD1306_SWITCHCAPVCC, addr);
  if (!ok) return false;
  oled.clearDisplay();
  oled.setTextColor(SSD1306_WHITE);
  oled.display();
  return true;
}

bool present() { return ok; }

void message(const char* line1, const char* line2) {
  if (!ok) return;
  oled.clearDisplay();
  if (line2) {
    centred(line1, 4, 1);
    centred(line2, 18, 1);
  } else {
    centred(line1, 12, 1);
  }
  oled.display();
}

void show(const VitalsReading& v, bool sensorOk, bool netUp, int rssi) {
  if (!ok) return;
  oled.clearDisplay();

  if (!sensorOk) {
    centred("NO SENSOR", 4, 1);
    centred("check SDA/SCL", 18, 1);
    oled.display();
    return;
  }

  if (v.saturated) {
    centred("SIGNAL CLIPPED", 4, 1);
    centred("ease off finger", 18, 1);
    wifiBars(rssi, netUp);
    oled.display();
    return;
  }

  if (!v.fingerOn) {
    centred("Place a finger", 12, 1);
    wifiBars(rssi, netUp);
    oled.display();
    return;
  }

  // Measuring: two columns, label above value, divider between.
  oled.drawLine(63, 2, 63, 29, SSD1306_WHITE);

  oled.setTextSize(1);
  oled.setCursor(2, 0);
  oled.print("HR");
  oled.setCursor(68, 0);
  oled.print("SpO2");

  char buf[8];
  oled.setTextSize(2);

  // A dash beats a zero: it says "not yet" rather than asserting a value.
  if (v.bpm > 0) snprintf(buf, sizeof(buf), "%d", (int)lroundf(v.bpm));
  else           snprintf(buf, sizeof(buf), "--");
  oled.setCursor(2, 13);
  oled.print(buf);

  if (v.spo2 > 0) snprintf(buf, sizeof(buf), "%d", (int)lroundf(v.spo2));
  else            snprintf(buf, sizeof(buf), "--");
  oled.setCursor(68, 13);
  oled.print(buf);

  oled.setTextSize(1);
  if (v.bpm > 0)  { oled.setCursor(40, 20); oled.print("bpm"); }
  if (v.spo2 > 0) { oled.setCursor(110, 20); oled.print("%"); }

  wifiBars(rssi, netUp);
  oled.display();
}

}  // namespace display
