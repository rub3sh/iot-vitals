#pragma once
#include <Arduino.h>
#include "vitals.h"

// 0.91" SSD1306 (128x32) on the same I2C bus as the sensor. Entirely optional:
// if no display answers, every call here is a no-op and the node runs as before.
namespace display {

bool begin();
bool present();

// Called once a second alongside the MQTT publish. Chooses what to render
// from the state of the reading, so the screen explains itself rather than
// showing stale numbers.
void show(const VitalsReading& v, bool sensorOk, bool netUp, int rssi);

void message(const char* line1, const char* line2 = nullptr);

}  // namespace display
