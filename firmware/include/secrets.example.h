#pragma once
// Copy this file to secrets.h and fill in your values.
// secrets.h is gitignored so your credentials stay out of version control.

#define WIFI_SSID   "your-wifi-name"
#define WIFI_PASS   "your-wifi-password"

// IP of the machine running the Mosquitto broker (not "localhost" — the
// ESP32 needs the LAN address). Find it with:  hostname -I
#define MQTT_HOST   "192.168.1.100"
#define MQTT_PORT   1883

// Leave blank if the broker allows anonymous connections.
#define MQTT_USER   ""
#define MQTT_PASS   ""

// Unique per board — becomes the MQTT topic prefix and the dashboard label.
#define DEVICE_ID   "esp32-01"
