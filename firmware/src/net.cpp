#include "net.h"
#include "secrets.h"
#include <WiFi.h>
#include <PubSubClient.h>

namespace net {
namespace {

WiFiClient   wifiClient;
PubSubClient mqtt(wifiClient);

char topicBase_[64];
char statusTopic_[80];
char scratch_[96];

uint32_t nextMqttAttempt_ = 0;
uint16_t backoffMs_       = 1000;

// PPG batches run a few hundred bytes; PubSubClient's 256-byte default would
// silently drop them.
const uint16_t MQTT_BUFFER = 1024;

void connectMqtt() {
  if (WiFi.status() != WL_CONNECTED) return;

  Serial.printf("[mqtt] connecting to %s:%d ... ", MQTT_HOST, MQTT_PORT);

  // Register "offline" as the last will so an unplugged board shows as gone
  // instead of freezing on its final reading.
  bool ok;
  if (strlen(MQTT_USER) > 0) {
    ok = mqtt.connect(DEVICE_ID, MQTT_USER, MQTT_PASS, statusTopic_, 1, true, "offline");
  } else {
    ok = mqtt.connect(DEVICE_ID, statusTopic_, 1, true, "offline");
  }

  if (ok) {
    Serial.println("ok");
    mqtt.publish(statusTopic_, "online", true);
    backoffMs_ = 1000;
  } else {
    Serial.printf("failed rc=%d, retrying in %ums\n", mqtt.state(), backoffMs_);
    nextMqttAttempt_ = millis() + backoffMs_;
    if (backoffMs_ < 30000) backoffMs_ *= 2;   // back off, but keep trying
  }
}

}  // namespace

void begin() {
  snprintf(topicBase_,   sizeof(topicBase_),   "vitals/%s", DEVICE_ID);
  snprintf(statusTopic_, sizeof(statusTopic_), "%s/status", topicBase_);

  WiFi.mode(WIFI_STA);

  // Power envelope matters more than raw range here: a XIAO on a USB port that
  // is already near its budget browns out on full-power transmit peaks, and
  // drops off the bus entirely. 11 dBm is plenty for a node sitting indoors on
  // the same LAN as the broker. Modem sleep is left enabled — the MAX30102's
  // FIFO buffers samples, so the radio napping between publishes costs no data.
  WiFi.setTxPower(WIFI_POWER_11dBm);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.printf("[wifi] joining %s\n", WIFI_SSID);

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(MQTT_BUFFER);
  mqtt.setKeepAlive(15);
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) return;

  static bool announced = false;
  if (!announced) {
    Serial.printf("[wifi] connected, ip=%s rssi=%d\n",
                  WiFi.localIP().toString().c_str(), WiFi.RSSI());
    announced = true;
  }

  if (!mqtt.connected()) {
    if ((int32_t)(millis() - nextMqttAttempt_) >= 0) connectMqtt();
  } else {
    mqtt.loop();
  }
}

bool connected() { return WiFi.status() == WL_CONNECTED && mqtt.connected(); }

int rssi() { return WiFi.RSSI(); }

bool publish(const char* subtopic, const char* payload, bool retain) {
  if (!mqtt.connected()) return false;
  snprintf(scratch_, sizeof(scratch_), "%s/%s", topicBase_, subtopic);
  return mqtt.publish(scratch_, payload, retain);
}

}  // namespace net
