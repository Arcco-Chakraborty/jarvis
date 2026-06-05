# ESP32 Smart Switch — Firmware

Arduino firmware for the 8-channel relay board JARVIS controls. It connects to your
WiFi, serves a standalone web UI, and exposes a small HTTP API. The orchestrator is
just another client of that API — and the board's own web UI keeps working
independently, so it's usable with or without JARVIS.

## Hardware

An ESP32 dev board driving an 8-channel relay module. Relays are **active-low**
(`RELAY_ON = LOW`). Default GPIO → device map:

| Relay | Device | GPIO | Group | | Relay | Device | GPIO | Group |
|---|---|---|---|---|---|---|---|---|
| 0 | Fan 1 | 13 | fans | | 4 | RGB Light | 25 | lights |
| 1 | Fan 2 | 14 | fans | | 5 | Night Light | 4 | lights |
| 2 | Tubelight | 27 | lights | | 6 | Socket | 18 | other |
| 3 | Spotlight | 26 | lights | | 7 | Spare | 19 | other |

This map must match the orchestrator's registry (it's seeded with exactly this order).
Relay states are persisted to EEPROM, so they survive a reboot/power cut.

## Flashing (Arduino IDE)

1. Install the **ESP32 board package**: *File → Preferences → Additional Boards Manager
   URLs* → `https://espressif.github.io/arduino-esp32/package_esp32_index.json`, then
   *Tools → Board → Boards Manager* → install **esp32** by Espressif.
2. Open `smart_switch.ino`.
3. Set your WiFi credentials at the top:
   ```cpp
   const char* WIFI_SSID     = "YOUR_WIFI_SSID";
   const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
   ```
4. Select your ESP32 board and port under *Tools*, then **Upload**.
5. Open the **Serial Monitor** at `115200` baud. After it connects it prints the IP:
   `[OK] Open http://192.168.x.y`.
6. **Reserve that IP** as a static DHCP lease in your router (the firmware sets a
   hostname but does not run mDNS, so `smartswitch.local` won't resolve on its own).
7. Put that IP in the orchestrator's `.env`: `ESP32_BASE_URL=http://192.168.x.y`.

## HTTP API

| Method / Path | Effect | Returns |
|---|---|---|
| `GET /` | Standalone web UI | HTML |
| `GET /state` | Read all relay states | `{"states":[bool ×8],"ip":"..."}` |
| `GET /set?r=<i>&s=<0\|1>` | Set relay `i` (idempotent) | same as `/state` |
| `GET /alloff` | Turn all relays off | same as `/state` |
| `GET /toggle?r=<i>` | Toggle relay `i` (the web UI uses this) | same as `/state` |

JARVIS issues only idempotent `/set` calls so a retried command never flips state back.
Endpoints are unauthenticated — fine for a trusted home LAN, which is the intended
deployment.
