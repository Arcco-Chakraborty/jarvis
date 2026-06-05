/*
  ESP32 Smart Switch — 8-Channel Relay Controller
  ================================================
  Devices:
    1. Fan 1        → GPIO13
    2. Fan 2        → GPIO14
    3. Tubelight    → GPIO27
    4. Spotlight    → GPIO26
    5. RGB Light    → GPIO25
    6. Night Light  → GPIO4
    7. Socket       → GPIO18
    8. Spare        → GPIO19
  
  Control: Web UI via home WiFi
  Check Serial Monitor for IP address after boot
*/

#include <WiFi.h>
#include <WebServer.h>
#include <EEPROM.h>

// ─── WiFi Config ────────────────────────────────────
// Set these to your home WiFi before flashing.
const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* HOSTNAME      = "smartswitch";

// ─── Relay Pins ─────────────────────────────────────
#define NUM_RELAYS  8
#define RELAY_ON    LOW
#define RELAY_OFF   HIGH

const int relayPins[NUM_RELAYS] = { 13, 14, 27, 26, 25, 4, 18, 19 };
const char* relayNames[NUM_RELAYS] = {
  "Fan 1", "Fan 2", "Tubelight", "Spotlight",
  "RGB Light", "Night Light", "Socket", "Spare"
};

bool relayState[NUM_RELAYS] = { false };

#define EEPROM_SIZE 16
#define EEPROM_MAGIC 0xA5

WebServer server(80);

// ─── EEPROM ─────────────────────────────────────────
void saveStates() {
  EEPROM.write(0, EEPROM_MAGIC);
  for (int i = 0; i < NUM_RELAYS; i++)
    EEPROM.write(i + 1, relayState[i] ? 1 : 0);
  EEPROM.commit();
}

void loadStates() {
  if (EEPROM.read(0) == EEPROM_MAGIC) {
    for (int i = 0; i < NUM_RELAYS; i++) {
      relayState[i] = EEPROM.read(i + 1) == 1;
      digitalWrite(relayPins[i], relayState[i] ? RELAY_ON : RELAY_OFF);
    }
  }
}

void applyRelay(int i) {
  digitalWrite(relayPins[i], relayState[i] ? RELAY_ON : RELAY_OFF);
  saveStates();
}

// ─── JSON response ──────────────────────────────────
void sendStates() {
  String j = "{\"states\":[";
  for (int i = 0; i < NUM_RELAYS; i++) {
    j += relayState[i] ? "true" : "false";
    if (i < NUM_RELAYS - 1) j += ",";
  }
  j += "],\"ip\":\"" + WiFi.localIP().toString() + "\"}";
  server.send(200, "application/json", j);
}

// ─── Web UI (chunked to avoid memory issues) ────────
void handleRoot() {
  server.setContentLength(CONTENT_LENGTH_UNKNOWN);
  server.send(200, "text/html", "");

  server.sendContent(F("<!DOCTYPE html><html><head><meta charset='UTF-8'>"
    "<meta name='viewport' content='width=device-width,initial-scale=1,user-scalable=no'>"
    "<title>Smart Switch</title><style>"
    "*{margin:0;padding:0;box-sizing:border-box}"
    ":root{--bg:#0e0e12;--card:#18181f;--border:#2a2a35;--text:#e8e8ed;"
    "--dim:#6b6b7b;--off:#3a3a48;"
    "--c0:#42aaf5;--c1:#38bdf8;--c2:#f5c842;--c3:#fb923c;"
    "--c4:#f472b6;--c5:#a78bfa;--c6:#45d9a0;--c7:#94a3b8}"
    "body{font-family:system-ui,-apple-system,sans-serif;background:var(--bg);"
    "color:var(--text);min-height:100dvh;display:flex;flex-direction:column;"
    "align-items:center;padding:1.5rem 1rem 2rem}"
  ));

  server.sendContent(F(
    ".header{text-align:center;margin-bottom:1.8rem}"
    ".header h1{font-size:1.5rem;font-weight:700;letter-spacing:-0.02em;margin-bottom:0.25rem}"
    ".status{font-size:0.75rem;color:var(--dim);display:flex;align-items:center;"
    "justify-content:center;gap:0.4rem}"
    ".dot{width:6px;height:6px;border-radius:50%;display:inline-block;animation:pulse 2s ease infinite}"
    ".dot.on{background:#45d9a0}.dot.off{background:#e24b4a}"
    "@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}"
    ".ip{margin-top:0.4rem;font-size:0.7rem;color:var(--dim);font-family:monospace;opacity:0.6}"
  ));

  server.sendContent(F(
    ".grid{display:grid;grid-template-columns:1fr 1fr;gap:0.8rem;width:100%;max-width:400px}"
    ".sc{background:var(--card);border:1px solid var(--border);border-radius:18px;"
    "padding:1.2rem 1rem;display:flex;flex-direction:column;gap:0.8rem;cursor:pointer;"
    "transition:all 0.3s ease;user-select:none;-webkit-tap-highlight-color:transparent;"
    "position:relative;overflow:hidden}"
    ".sc:active{transform:scale(0.96)}"
    ".ic{font-size:1.7rem;line-height:1;filter:grayscale(1) brightness(0.5);transition:filter 0.3s}"
    ".sc.on .ic{filter:none}"
    ".nm{font-size:0.85rem;font-weight:500}"
    ".st{font-size:0.68rem;text-transform:uppercase;letter-spacing:0.08em;"
    "font-weight:700;color:var(--off);transition:color 0.3s}"
  ));

  server.sendContent(F(
    ".tg{width:40px;height:22px;background:var(--off);border-radius:11px;"
    "position:relative;transition:background 0.3s;align-self:flex-end}"
    ".tg::after{content:'';position:absolute;top:3px;left:3px;width:16px;height:16px;"
    "background:#fff;border-radius:50%;transition:transform 0.3s cubic-bezier(0.4,0,0.2,1)}"
    ".sc.on .tg::after{transform:translateX(18px)}"
  ));

  // Per-device colors
  for (int i = 0; i < 8; i++) {
    String ci = String(i);
    server.sendContent(".sc[data-d='" + ci + "'].on .st{color:var(--c" + ci + ")}");
    server.sendContent(".sc[data-d='" + ci + "'].on .tg{background:var(--c" + ci + ")}");
    server.sendContent(".sc[data-d='" + ci + "'].on{border-color:transparent;"
      "box-shadow:0 0 30px -10px var(--c" + ci + ")}");
  }

  server.sendContent(F(
    ".br{margin-top:1.5rem;display:flex;gap:0.8rem;flex-wrap:wrap;justify-content:center}"
    ".btn{background:transparent;border:1px solid var(--border);color:var(--dim);"
    "font-family:inherit;font-size:0.75rem;font-weight:500;letter-spacing:0.05em;"
    "text-transform:uppercase;padding:0.6rem 1.5rem;border-radius:40px;cursor:pointer;"
    "transition:all 0.2s}"
    ".btn:active{transform:scale(0.96)}"
    ".ft{margin-top:2rem;text-align:center;font-size:0.65rem;color:var(--dim);opacity:0.5}"
    "</style></head><body>"
  ));

  server.sendContent(F(
    "<div class='header'><h1>Smart Switch</h1>"
    "<div class='status'><span class='dot on' id='dot'></span><span id='ct'>Connected</span></div>"
    "<div class='ip' id='ip'></div></div>"
    "<div class='grid' id='g'></div>"
    "<div class='br'>"
    "<button class='btn' onclick=\"gOff('lights')\">Lights Off</button>"
    "<button class='btn' onclick=\"gOff('fans')\">Fans Off</button>"
    "<button class='btn' onclick='aOff()'>All Off</button>"
    "</div>"
    "<div class='ft'>ESP32 &bull; 8-Channel</div>"
  ));

  server.sendContent(F("<script>"
    "var D=["
    "{n:'Fan 1',i:'\\u{1F300}',g:'fans'},"
    "{n:'Fan 2',i:'\\u{1F300}',g:'fans'},"
    "{n:'Tubelight',i:'\\u{1F4A1}',g:'lights'},"
    "{n:'Spotlight',i:'\\u{1F526}',g:'lights'},"
    "{n:'RGB Light',i:'\\u{1F308}',g:'lights'},"
    "{n:'Night Light',i:'\\u{1F319}',g:'lights'},"
    "{n:'Socket',i:'\\u{1F50C}',g:'other'},"
    "{n:'Spare',i:'\\u26A1',g:'other'}],"
    "S=[0,0,0,0,0,0,0,0];"
  ));

  server.sendContent(F(
    "function R(){var g=document.getElementById('g');g.innerHTML='';"
    "D.forEach(function(d,i){var c=document.createElement('div');"
    "c.className='sc'+(S[i]?' on':'');c.dataset.d=i;"
    "c.innerHTML='<div class=ic>'+d.i+'</div><div><div class=nm>'+d.n+"
    "'</div><div class=st>'+(S[i]?'On':'Off')+'</div></div><div class=tg></div>';"
    "c.onclick=function(){T(i)};g.appendChild(c)})}"
  ));

  server.sendContent(F(
    "function T(i){fetch('/toggle?r='+i).then(function(r){return r.json()})"
    ".then(function(d){S=d.states.map(Number);O(1);R()})"
    ".catch(function(){S[i]=S[i]?0:1;O(0);R()})}"
    "function aOff(){fetch('/alloff').then(function(r){return r.json()})"
    ".then(function(d){S=d.states.map(Number);O(1);R()})"
    ".catch(function(){S=[0,0,0,0,0,0,0,0];O(0);R()})}"
  ));

  server.sendContent(F(
    "function gOff(g){var ix=[];D.forEach(function(d,i){if(d.g===g)ix.push(i)});"
    "var p=Promise.resolve();"
    "ix.forEach(function(i){if(S[i])p=p.then(function(){"
    "return fetch('/set?r='+i+'&s=0').then(function(r){return r.json()})"
    ".then(function(d){S=d.states.map(Number);O(1);R()})})});"
    "p.catch(function(){O(0)})}"
  ));

  server.sendContent(F(
    "function O(v){document.getElementById('dot').className='dot '+(v?'on':'off');"
    "document.getElementById('ct').textContent=v?'Connected':'Offline'}"
    "function F(){fetch('/state').then(function(r){return r.json()})"
    ".then(function(d){S=d.states.map(Number);"
    "if(d.ip)document.getElementById('ip').textContent=d.ip;O(1);R()})"
    ".catch(function(){O(0);R()})}"
    "F();setInterval(F,3000);"
    "</script></body></html>"
  ));

  server.sendContent("");
}

void handleToggle() {
  if (!server.hasArg("r")) { server.send(400); return; }
  int i = server.arg("r").toInt();
  if (i < 0 || i >= NUM_RELAYS) { server.send(400); return; }
  relayState[i] = !relayState[i];
  applyRelay(i);
  sendStates();
}

void handleSet() {
  if (!server.hasArg("r") || !server.hasArg("s")) { server.send(400); return; }
  int i = server.arg("r").toInt();
  int v = server.arg("s").toInt();
  if (i < 0 || i >= NUM_RELAYS) { server.send(400); return; }
  relayState[i] = (v == 1);
  applyRelay(i);
  sendStates();
}

void handleAllOff() {
  for (int i = 0; i < NUM_RELAYS; i++) {
    relayState[i] = false;
    digitalWrite(relayPins[i], RELAY_OFF);
  }
  saveStates();
  sendStates();
}

// ─── Setup ──────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println("\n[SmartSwitch] Booting...");

  EEPROM.begin(EEPROM_SIZE);

  // Init all relay pins OFF first
  for (int i = 0; i < NUM_RELAYS; i++) {
    pinMode(relayPins[i], OUTPUT);
    digitalWrite(relayPins[i], RELAY_OFF);
  }

  // Small delay before loading saved states
  delay(100);
  loadStates();

  // Connect to home WiFi
  WiFi.mode(WIFI_STA);
  WiFi.setHostname(HOSTNAME);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.printf("[WiFi] Connecting to %s", WIFI_SSID);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 40) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println(" OK!");
    Serial.printf("[WiFi] IP: %s\n", WiFi.localIP().toString().c_str());
    Serial.printf("[WiFi] Signal: %d dBm\n", WiFi.RSSI());
  } else {
    Serial.println(" FAILED!");
    Serial.println("[WiFi] Restarting in 5s...");
    delay(5000);
    ESP.restart();
  }

  server.on("/", handleRoot);
  server.on("/state", HTTP_GET, []() { sendStates(); });
  server.on("/toggle", HTTP_GET, handleToggle);
  server.on("/set", HTTP_GET, handleSet);
  server.on("/alloff", HTTP_GET, handleAllOff);
  server.begin();

  Serial.printf("[OK] Open http://%s\n", WiFi.localIP().toString().c_str());
}

// ─── Loop ───────────────────────────────────────────
void loop() {
  server.handleClient();

  // Auto-reconnect WiFi
  static unsigned long lastCheck = 0;
  if (millis() - lastCheck > 30000) {
    lastCheck = millis();
    if (WiFi.status() != WL_CONNECTED) {
      Serial.println("[WiFi] Reconnecting...");
      WiFi.reconnect();
    }
  }
}
