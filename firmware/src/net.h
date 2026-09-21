#pragma once
#include <Arduino.h>

namespace net {

void begin();

// Drives WiFi and MQTT reconnection. Must be called every loop(); never blocks.
void loop();

bool connected();
int  rssi();

// Returns false if the payload could not be handed to the broker.
bool publish(const char* subtopic, const char* payload, bool retain = false);

}  // namespace net
