// Standalone radio power probe — built only by `-e wifi_probe`.
//
// No sensor, no MQTT, no credentials. It establishes a quiet baseline with the
// radio off, then runs WiFi.scanNetworks(), which is the largest current
// transient the radio can produce. If the board survives a few scans, the USB
// cable and port can carry WiFi and the fault lies elsewhere. If it resets at
// the first scan, the supply cannot feed the radio.
//
// A flash-backed counter distinguishes a real restart from a USB dropout.

#include <Arduino.h>
#include <WiFi.h>
#include <esp_system.h>
#include <Preferences.h>

static const char* REASONS[] = {"unknown","poweron","ext","sw","panic","int_wdt",
                                "task_wdt","wdt","deepsleep","brownout","sdio"};

void setup() {
  Serial.begin(115200);
  delay(1500);

  Preferences prefs;
  prefs.begin("wifiprobe", false);
  uint32_t boots = prefs.getUInt("boots", 0) + 1;
  prefs.putUInt("boots", boots);
  prefs.end();

  int rr = (int)esp_reset_reason();
  Serial.printf("\n=== wifi probe ===\n[boot] count=%lu reason=%d(%s)\n",
                (unsigned long)boots, rr, (rr >= 0 && rr <= 10) ? REASONS[rr] : "?");

  // Baseline: radio still off. Surviving this proves the board itself is fine.
  Serial.println("[phase 1] radio OFF, 5s baseline");
  for (int i = 5; i > 0; i--) { Serial.printf("   t-%d\n", i); delay(1000); }
  Serial.println("[phase 1] OK — board stable with radio off");

  Serial.println("[phase 2] powering radio (WIFI_STA)...");
  WiFi.mode(WIFI_STA);
  WiFi.disconnect(true, true);
  delay(400);
  Serial.println("[phase 2] OK — radio powered, still alive");
}

void loop() {
  static uint32_t pass = 0;
  pass++;

  Serial.printf("[phase 3] scan #%lu starting (peak current)...\n", (unsigned long)pass);
  int n = WiFi.scanNetworks();          // blocking full-channel scan
  Serial.printf("[phase 3] scan #%lu SURVIVED — %d networks\n", (unsigned long)pass, n);

  for (int i = 0; i < n && i < 12; i++) {
    Serial.printf("   %2d) %-32s rssi=%4d ch=%2d %s\n", i + 1,
                  WiFi.SSID(i).c_str(), WiFi.RSSI(i), WiFi.channel(i),
                  WiFi.encryptionType(i) == WIFI_AUTH_OPEN ? "open" : "secured");
  }
  WiFi.scanDelete();
  delay(3000);
}
