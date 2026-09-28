// TamperSafe box firmware -- main sketch.
//
// A sealed box watches its lid (IR), shock/tilt (MPU6050), position (GPS) and
// and the buyer's RFID delivery key, latches any tamper in NVS before reporting it, and
// reports hash-chained events to the relayer over Wi-Fi. See
// docs/ARCHITECTURE.md §8-9 and docs/HARDWARE.md.
//
// setup() order follows the neurick-firmware skill exactly:
//   Serial.begin -> nr.begin() -> OLED display.begin() -> other peripherals.

#include <Newrick.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <WiFi.h>

#include "pins.h"
#include "config.h"
#include "protocol.h"
#include "box_context.h"
#include "events.h"
#include "nvs_store.h"
#include "network_task.h"
#include "mpu.h"
#include "sensors.h"
#include "rfid.h"
#include "led.h"

Newrick nr;

// --- OLED --------------------------------------------------------------------
// Constructed with clkDuring=clkAfter=400000 (both explicit), NOT the
// library's defaults (400000/100000). Why: Adafruit_SSD1306 wraps every
// I2C transfer with wire->setClock(clkDuring) then wire->setClock(clkAfter)
// (see Adafruit_SSD1306.cpp's SETWIRECLOCK/RESWIRECLOCK macros) -- with the
// library's own default clkAfter of 100000, every OLED refresh would drop
// the SHARED bus (STM32 0x08, MPU6050 0x68) to 100 kHz afterwards, silently
// contradicting nr.begin()'s 400 kHz and the "never call Wire.setClock()"
// rule in spirit (we don't call it ourselves, but the library does, on our
// behalf, on every display() call). Setting both parameters to 400000 means
// the library still calls setClock(), but only ever back to the same
// 400 kHz nr.begin() already set -- a no-op in effect. Flagged in the M4
// report; the clean fix would be a periphBegin-style "don't touch the
// clock" library option, which this version of Adafruit_SSD1306 (2.5.17)
// doesn't expose.
Adafruit_SSD1306 display(128, 32, &Wire, -1, 400000, 400000);

// --- Servo angles: CALIBRATED 29-Sep-2026 via bringup/servo_test.
// The latch is on physical Servo 2. Every call commands all three channels to
// the SAME angle, exactly as servo_test.ino does, so it works whichever name
// (S2 / S3 / S4) the library gives the channels -- this closes the S3-vs-S4
// signature question for this box.
#define LOCK_ANGLE   180 // latch closed
#define UNLOCK_ANGLE  90 // latch open

#define BATTERY_MIN_VOLTS 10.5f // docs/HARDWARE.md §5

// --- Tamper code names, for the OLED's "TAMPERED: <name>" (ARCHITECTURE §8) --
static const char *tamperCodeName(uint8_t code) {
  switch (code) {
    case 1: return "LID_OPENED";
    case 2: return "CONTENTS_DISTURBED";
    case 3: return "POWER_INTERRUPTED";
    default: return "UNKNOWN";
  }
}

// --- Scheduler cadence, per ARCHITECTURE.md §8 --------------------------------
#define IR_INTERVAL_MS         50   // 20 Hz
#define MPU_INTERVAL_MS        50   // 20 Hz
#define RFID_INTERVAL_MS       250  // 4 Hz
#define SENSORS_INTERVAL_MS    500  // 2 Hz  (nr.updateSensors())
#define OLED_INTERVAL_MS       500  // 2 Hz
#define TELEMETRY_SEALED_MS    2000
#define TELEMETRY_OTHER_MS     10000

static unsigned long tIr = 0, tRfid = 0, tMpu = 0, tSensors = 0, tOled = 0, tTelemetry = 0;

// Doorstep unlock is two-factor. The buyer's signed "Confirm & Unlock" reaches
// the box as an UNLOCK command, which ARMS it (blue LED); the latch only opens
// when the enrolled delivery key is then tapped. RAM only: a reboot while
// sealed is still POWER_INTERRUPTED, so nothing extra needs persisting.
static bool unlockArmed = false;
static char armedCmdId[32] = "";

// Enrolment (IDLE only): hold the board button ~2 s, then tap the tag to
// enrol as the delivery key. Every other tag is wrong.
#define ENROLL_HOLD_SAMPLES 4     // 4 x 500 ms sensor polls
#define ENROLL_WINDOW_MS    10000
static uint8_t buttonHeld = 0;
static unsigned long enrollUntil = 0; // 0 = not enrolling

#define ALERT_AUTH_FAILED 17 // wrong delivery key tapped on a sealed box (evidence only)

// Last cmd_id we printed an "IGNORED command" line for, so a command the
// relayer keeps resending (per §9.2, "the relayer re-sends an
// unacknowledged command on every response") logs once, not once per
// loop() tick.
static char lastIgnoredCmdId[32] = "";

// Set once at boot by runProtocolSelfTest(); surfaced on every reportStatus()
// call (Serial + OLED), not just the one-shot boot print, so it can't be
// missed by a Serial Monitor that attaches late.
static bool g_selfTestOk = false;

// Last time nr.updateSensors() actually succeeded. ctx.battValid alone only
// says "at least once, ever" -- it never goes back to false, so on its own
// it would let SEAL through on a value that's gone stale (e.g. the 12V pack
// is off but USB is still powering the ESP32, so updateSensors() keeps
// failing while nr.batteryVolts holds whatever it last read before that).
// attemptSeal() additionally requires a successful read within the last 2s.
static unsigned long lastBattOkMs = 0;
#define BATTERY_FRESH_MS 2000

// Lid must read open this many 50 ms samples in a row to latch LID_OPENED.
#define LID_OPEN_SAMPLES 4
static uint8_t lidOpenStreak = 0;

// ---------------------------------------------------------------------------
// Seal / unlock / reset -- the only places that move the servo or write NVS
// `state`. Every one of them writes NVS BEFORE the corresponding event goes
// to the network task (CLAUDE.md invariant: "Latch before report").
// ---------------------------------------------------------------------------

static void doTamper(uint8_t code) {
  // Tamper rules only run in SEALED (CLAUDE.md invariant: "Tamper only
  // while SEALED"). Callers are responsible for that check; this function
  // just performs the transition once a caller has already decided to.
  ctx.tamperCode = code;
  ctx.state = BoxState::TAMPERED;
  nvsSaveState("TAMPERED");     // latch...
  nvsSaveTamperCode(code);
  emitEvent("TAMPER", code, ""); // ...then report
}

static void attemptSeal(uint32_t orderId, const char *cmdId) {
  ctx.state = BoxState::ARMING;
  nvsSaveState("ARMING");
  ctx.orderId = orderId;
  nvsSaveOrderId(orderId);

  // ARCHITECTURE §8: "ARMING --> IDLE: lid open or battery low -> SEAL_FAILED".
  ctx.lid = lidClosed() ? 1 : 0;
  bool batteryFresh = ctx.battValid && (millis() - lastBattOkMs <= BATTERY_FRESH_MS);
  bool batteryOk = batteryFresh && (nr.batteryVolts >= BATTERY_MIN_VOLTS);

  if (!batteryOk || ctx.lid == 0) {
    ctx.state = BoxState::IDLE;
    nvsSaveState("IDLE");
    emitEvent("SEAL_FAILED", 0, cmdId); // SEAL_FAILED is an event, not a persisted state (§6 lists 6 states, not 7)
    return;
  }

  // The ultrasonic contents baseline was dropped (28 Sept); the field stays 0.
  ctx.baselineMm = 0;
  nvsSaveBaseline(0);

  nr.servo(LOCK_ANGLE, LOCK_ANGLE, LOCK_ANGLE); // calibrated
  ctx.lock = 'L';

  if (!mpuSetReference()) Serial.println("MPU: no gravity reading at seal -- tilt alerts off for this shipment");

  ctx.state = BoxState::SEALED;
  nvsSaveState("SEALED"); // latch...
  emitEvent("SEALED", 0, cmdId); // ...then report
}

static void doUnlock(const char *cmdId) {
  // RAM/NVS state flips to OPEN_AUTHORIZED before the servo moves, so a
  // reboot mid-unlock never latches POWER_INTERRUPTED against a state the
  // box was already leaving on purpose.
  ctx.state = BoxState::OPEN_AUTHORIZED;
  nvsSaveState("OPEN_AUTHORIZED");
  nr.servo(UNLOCK_ANGLE, UNLOCK_ANGLE, UNLOCK_ANGLE); // calibrated
  ctx.lock = 'U';
  unlockArmed = false;
  mpuClearReference();
  emitEvent("UNLOCKED", 0, cmdId);
}

static void doReset(const char *cmdId) {
  ctx.orderId = 0;
  ctx.baselineMm = 0;
  ctx.tamperCode = 0;
  nvsSaveOrderId(0);
  nvsSaveBaseline(0);
  nvsSaveTamperCode(0);
  // Judgment call (undocumented in ARCHITECTURE §8): RESET also unlocks the
  // servo, since IDLE means "ready to be reloaded and re-sealed" and the
  // depot needs physical access either way (whether coming from TAMPERED or
  // OPEN_AUTHORIZED). Flagged for the team to confirm.
  nr.servo(UNLOCK_ANGLE, UNLOCK_ANGLE, UNLOCK_ANGLE); // calibrated
  ctx.lock = 'U';
  unlockArmed = false;
  mpuClearReference();
  ctx.state = BoxState::IDLE;
  nvsSaveState("IDLE");
  emitEvent("RESET_DONE", 0, cmdId);
}

// ---------------------------------------------------------------------------
// Boot-time NVS state mapping, per ARCHITECTURE.md §8's state diagram.
// ---------------------------------------------------------------------------
static void handleBoot() {
  String savedStateStr = nvsLoadState();
  BoxState saved = boxStateFromName(savedStateStr);

  ctx.orderId = nvsLoadOrderId();
  ctx.seq = nvsLoadSeq();
  strlcpy(ctx.head, nvsLoadHead().c_str(), sizeof(ctx.head));
  ctx.baselineMm = nvsLoadBaseline();
  ctx.tamperCode = nvsLoadTamperCode();

  switch (saved) {
    case BoxState::SEALED:
      // "BOOT --> TAMPERED: NVS state SEALED -> TAMPER POWER_INTERRUPTED"
      ctx.tamperCode = 3; // POWER_INTERRUPTED
      ctx.state = BoxState::TAMPERED;
      nvsSaveState("TAMPERED"); // latch...
      nvsSaveTamperCode(3);
      ctx.lock = 'L';
      break;
    case BoxState::TAMPERED:
      // "BOOT --> TAMPERED: NVS state TAMPERED (stays latched)"
      ctx.state = BoxState::TAMPERED;
      ctx.lock = 'L';
      break;
    case BoxState::OPEN_AUTHORIZED:
      // "BOOT --> IDLE: NVS state IDLE / OPEN_AUTHORIZED" -- yes, even
      // OPEN_AUTHORIZED maps to IDLE at boot per the diagram, not back to
      // OPEN_AUTHORIZED.
      ctx.state = BoxState::IDLE;
      nvsSaveState("IDLE");
      ctx.lock = 'U';
      break;
    case BoxState::ARMING:
      // Not in the §8 diagram at all -- ARMING is a sub-second transient in
      // normal operation, so a reboot catching it there is itself unusual.
      // Judgment call: treat it like "never sealed" and map to IDLE, since
      // the relayer never received a SEALED event for whatever order was
      // being armed. Flagged for the team.
      ctx.state = BoxState::IDLE;
      nvsSaveState("IDLE");
      ctx.lock = 'U';
      break;
    case BoxState::IDLE:
    case BoxState::BOOT: // unknown/empty NVS value (first boot ever)
    default:
      ctx.state = BoxState::IDLE;
      nvsSaveState("IDLE");
      ctx.lock = 'U';
      break;
  }
}

// ---------------------------------------------------------------------------
// Status on Serial + OLED (ARCHITECTURE §8 / task requirement: "Current
// state shown on OLED and Serial").
// ---------------------------------------------------------------------------
static void reportStatus() {
  bool wifiOk = (WiFi.status() == WL_CONNECTED);

  // Self-test result folded into the recurring 2Hz line, not just the one
  // boot-time print -- the CDC Serial Monitor often attaches after that
  // first print has already scrolled past, so PASS/FAIL needs to stay
  // visible on both Serial and the OLED for as long as the box is on.
  Serial.printf("[state=%s] order=%lu seq=%lu batt=%s wifi=%s lock=%c lid=%s gps=%s key=%s accel=%ldmg tilt=%ld selftest=%s\n",
                boxStateName(ctx.state), (unsigned long)ctx.orderId, (unsigned long)ctx.seq,
                ctx.battValid ? String(nr.batteryVolts, 2).c_str() : "?",
                wifiOk ? "OK" : "--", ctx.lock, ctx.lid ? "closed" : "OPEN", ctx.fix ? "fix" : (gpsHeard() ? "nofix" : "silent"),
                unlockArmed ? "armed" : (rfidHasKey() ? "key" : "none"), (long)ctx.accelMg, (long)ctx.tiltDeg, g_selfTestOk ? "PASS" : "FAIL");

  // 128x32 at text size 1 = 21 chars/row, 4 rows (y=0/8/16/24). Wrap is
  // disabled deliberately: a wrapped line 3 ("TAMPERED: POWER_INTERRUPTED"
  // is 27 chars) would overlap line 4 instead of being clipped -- clipped
  // but readable beats overlapping and unreadable on the one screen the
  // power-cut demo depends on.
  display.clearDisplay();
  display.setTextWrap(false);
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);

  display.setCursor(0, 0);
  display.printf("%s %s", BOX_ID, g_selfTestOk ? "ST:OK" : "ST:FAIL");

  display.setCursor(0, 8);
  if (ctx.state == BoxState::TAMPERED) {
    display.print("TAMPERED:");
  } else {
    display.print(boxStateName(ctx.state));
  }

  display.setCursor(0, 16);
  if (ctx.state == BoxState::TAMPERED) {
    display.print(tamperCodeName(ctx.tamperCode)); // longest name is 18 chars, fits
  } else {
    display.printf("order=%lu", (unsigned long)ctx.orderId);
  }

  display.setCursor(0, 24);
  display.printf("B:%s W:%s L:%c", ctx.battValid ? String(nr.batteryVolts, 1).c_str() : "?",
                 wifiOk ? "Y" : "N", ctx.lock);

  display.display();
}

// A delivery-key tap (or a wrong tag). Only an armed SEALED box opens.
static void onTag(Tag tag, bool enrolled) {
  if (enrolled) {
    enrollUntil = 0;
    Serial.println("RFID: delivery key enrolled");
    ledFlash(LED_G, 1500);
    return;
  }
  if (ctx.state == BoxState::IDLE) { // bench feedback at the depot: is this the key?
    Serial.printf("RFID: %s tag (IDLE)\n", tag == Tag::Key ? "delivery key" : "WRONG");
    ledFlash(tag == Tag::Key ? LED_G : LED_R, 1500);
    return;
  }
  // SEALED
  if (tag == Tag::Key && unlockArmed) {
    Serial.println("RFID: delivery key accepted -- opening");
    ledFlash(LED_G, 2000);
    doUnlock(armedCmdId);
    strlcpy(ctx.lastHandledCmdId, armedCmdId, sizeof(ctx.lastHandledCmdId));
    networkAckCommandHandled(armedCmdId);
  } else if (tag == Tag::Key) {
    Serial.println("RFID: delivery key tapped but the buyer has not confirmed on-chain yet");
    ledFlash(LED_B, 600);
  } else {
    Serial.println("RFID: WRONG tag on a sealed box");
    ledFlash(LED_R, 2000);
    emitAlertEvent(ALERT_AUTH_FAILED);
  }
}

// ---------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(2000);

  nr.begin(); // starts I2C on SDA=8/SCL=9 at 400 kHz -- must be first and only Wire.begin()

  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C, /*reset=*/true, /*periphBegin=*/false)) {
    // periphBegin=false: don't let the SSD1306 library call Wire.begin()
    // again (nr.begin() already did, on 8/9 -- a second Wire.begin() with
    // this library's defaults would reset the bus to the wrong pins).
    Serial.println("WARNING: SSD1306 display.begin() failed -- OLED not present or wrong address");
  }
  display.clearDisplay();
  display.display();

  // Safe-stop path (neurick-firmware skill): motor commands persist until
  // changed, so stop them explicitly even though this sketch never drives
  // motors.
  nr.motor(1, 0);
  nr.motor(2, 0);
  nr.motor(3, 0);
  nr.motor(4, 0);

  nvsInit();
  uint32_t bootCount = nvsIncrementBootCount();
  Serial.printf("TamperSafe box booting, boot_count=%lu\n", (unsigned long)bootCount);

  g_selfTestOk = runProtocolSelfTest(); // prints SELFTEST PASS/FAIL; boot continues either way so the team can still see a FAIL on Serial/OLED rather than the box going dark

  sensorsInit();
  ledInit();
  if (!rfidInit()) {
    Serial.println("WARNING: RC522 not answering -- the delivery key cannot open the box (check the RFID socket wiring)");
  } else if (!rfidHasKey()) {
    Serial.println("RFID: no delivery key enrolled -- hold the board button 2 s in IDLE, then tap the key");
  }

  if (!mpuInit()) {
    Serial.println("WARNING: MPU6050 init failed (0x68 not answering?) -- SHOCK/TILT alerts disabled until it recovers");
  }

  handleBoot();

  // Boot-time servo position matches the post-mapping state: TAMPERED stays
  // locked, everything else (only IDLE is reachable post-mapping) is
  // unlocked. See handleBoot()'s switch for why SEALED/OPEN_AUTHORIZED/
  // ARMING can never survive a reboot as themselves.
  if (ctx.state == BoxState::TAMPERED) {
    nr.servo(LOCK_ANGLE, LOCK_ANGLE, LOCK_ANGLE); // calibrated
  } else {
    nr.servo(UNLOCK_ANGLE, UNLOCK_ANGLE, UNLOCK_ANGLE); // calibrated
  }

  networkInit(); // starts the core-0 task; safe to start after NVS/state are loaded

  emitEvent("BOOT", 0, "");
  if (ctx.state == BoxState::TAMPERED && ctx.orderId != 0) {
    // Re-emit TAMPER with the latched code on EVERY boot that comes up
    // TAMPERED against a real order -- not just the boot that first caused
    // it (tamperCode==3/POWER_INTERRUPTED). Reasoning: the ring buffer that
    // carries TAMPER to the relayer lives in RAM only. A tamper detected
    // while offline (LID_OPENED, CONTENTS_DISTURBED, or a prior
    // POWER_INTERRUPTED) that is then followed by ANOTHER reboot before the
    // box ever reconnects would otherwise never reach the chain, which
    // breaks CLAUDE.md invariant 3 ("Once a box reports tamper... both the
    // firmware (NVS) and the contract keep it"). Latch already happened
    // inside handleBoot() (or on a prior boot) before this BOOT event was
    // emitted above, so this still satisfies "latch before report".
    //
    // Flag for the main session: the relayer must treat a TAMPER for an
    // order that's already Tampered on-chain as a no-op (Escrow.reportTamper
    // would revert InvalidStatus otherwise on this resend).
    emitEvent("TAMPER", ctx.tamperCode, "");
  }

  reportStatus();
}

void loop() {
  unsigned long now = millis();

  // --- IR lid (20 Hz). While SEALED, the lid reading open for 4 consecutive
  // samples (200 ms) is TAMPER LID_OPENED (HARDWARE.md §5).
  if (now - tIr >= IR_INTERVAL_MS) {
    tIr = now;
    bool closed = lidClosed();
    ctx.lid = closed ? 1 : 0;
    if (ctx.state == BoxState::SEALED && !closed) {
      if (++lidOpenStreak >= LID_OPEN_SAMPLES) doTamper(1); // LID_OPENED
    } else {
      lidOpenStreak = 0;
    }
  }

  // --- GPS (every loop): evidence only, never gates escrow.
  {
    int32_t lat, lon;
    if (gpsPoll(&lat, &lon)) {
      ctx.lat_e6 = lat;
      ctx.lon_e6 = lon;
      ctx.fix = 1;
    } else {
      ctx.fix = 0;
    }
  }

  // --- RFID delivery key (4 Hz). Never touches funds: it only gates the physical latch.
  if (now - tRfid >= RFID_INTERVAL_MS) {
    tRfid = now;
    bool enrolling = enrollUntil != 0;
    if (enrolling && (long)(enrollUntil - now) <= 0) {
      enrollUntil = 0;
      enrolling = false;
      ledFlash(LED_R, 1000); // enrolment timed out
    }
    if (ctx.state == BoxState::IDLE || ctx.state == BoxState::SEALED) {
      Tag tag = rfidScan(enrolling);
      if (tag != Tag::None) onTag(tag, enrolling);
    }
  }

  // --- LED: tamper blinks red, armed pulses blue, enrolling is cyan; a scan result flashes over it.
  if (ctx.state == BoxState::TAMPERED) ledBackground(LED_R, 500);
  else if (unlockArmed) ledBackground(LED_B, 400);
  else if (enrollUntil != 0) ledBackground(LED_CYAN);
  else ledBackground(LED_OFF);
  ledTick();

  // --- MPU6050 (20 Hz).
  if (now - tMpu >= MPU_INTERVAL_MS) {
    tMpu = now;
    int32_t accelMg, tiltDeg;
    if (mpuReadAccelTilt(&accelMg, &tiltDeg)) {
      ctx.accelMg = accelMg;
      ctx.tiltDeg = tiltDeg;
      // Judgment call, not explicit in ARCHITECTURE §8 (which only says
      // alerts never change state, not that they're SEALED-only): gate
      // SHOCK/TILT to SEALED so carrying the empty box around in IDLE/
      // ARMING/OPEN_AUTHORIZED doesn't spam Anchor.logAlert(order_id=0, ...)
      // on the relayer. Flagged for the team to confirm.
      if (ctx.state == BoxState::SEALED) mpuEvaluateAlerts(accelMg, tiltDeg);
    }
    // else: keep the stale ctx values, per "always check the return value"
  }

  // --- nr.updateSensors() (2 Hz): battery, button.
  if (now - tSensors >= SENSORS_INTERVAL_MS) {
    tSensors = now;
    if (nr.updateSensors()) {
      ctx.battMv = (int32_t)lroundf(nr.batteryVolts * 1000.0f);
      ctx.battValid = true;
      lastBattOkMs = now;
      buttonHeld = (nr.buttonState != 0) ? buttonHeld + 1 : 0;
      if (ctx.state == BoxState::IDLE && enrollUntil == 0 && buttonHeld >= ENROLL_HOLD_SAMPLES) {
        enrollUntil = now + ENROLL_WINDOW_MS;
        buttonHeld = 0;
        Serial.println("RFID: enrolling -- tap the tag that should be the delivery key");
      }
    }
    // else: stale nr.batteryVolts/ctx.battMv are kept for display, but
    // attemptSeal()'s freshness check (lastBattOkMs) stops them from
    // gating a real SEAL once they're more than 2s old.
  }

  // --- OLED + Serial (2 Hz).
  if (now - tOled >= OLED_INTERVAL_MS) {
    tOled = now;
    reportStatus();
  }

  // --- TELEMETRY event: 2s in SEALED, 10s otherwise.
  unsigned long telemetryInterval = (ctx.state == BoxState::SEALED) ? TELEMETRY_SEALED_MS : TELEMETRY_OTHER_MS;
  if (now - tTelemetry >= telemetryInterval) {
    tTelemetry = now;
    emitEvent("TELEMETRY", 0, "");
  }

  // --- Pending command from the relayer (SEAL/UNLOCK/RESET), per §9.2.
  char cmdId[32], cmdType[16];
  uint32_t cmdOrderId;
  if (networkGetPendingCommand(cmdId, sizeof(cmdId), cmdType, sizeof(cmdType), &cmdOrderId)) {
    if (strcmp(cmdId, ctx.lastHandledCmdId) != 0) {
      bool handled = false;
      if (strcmp(cmdType, "SEAL") == 0 && ctx.state == BoxState::IDLE) {
        attemptSeal(cmdOrderId, cmdId);
        handled = true;
      } else if (strcmp(cmdType, "UNLOCK") == 0 && ctx.state == BoxState::SEALED && cmdOrderId == ctx.orderId) {
        // The buyer has signed on-chain. Arm and wait for the delivery key;
        // don't ack yet (the relayer resends until UNLOCKED carries the id).
        if (!unlockArmed) {
          unlockArmed = true;
          strlcpy(armedCmdId, cmdId, sizeof(armedCmdId));
          Serial.println("UNLOCK armed: waiting for the delivery key");
        }
      } else if (strcmp(cmdType, "UNLOCK") == 0 && ctx.state == BoxState::IDLE && ctx.orderId != 0 &&
                 cmdOrderId == ctx.orderId) {
        // Idempotent, mirroring the RESET-in-IDLE case below: a brownout
        // during doUnlock() itself (HARDWARE.md §3's "brownout when the
        // servo moves" risk) can reboot the box between moving the servo
        // and the UNLOCKED event ever leaving RAM. The reboot's boot-time
        // mapping turns OPEN_AUTHORIZED into IDLE but keeps order_id, so
        // this re-runs doUnlock() (harmless: same servo angle, a fresh
        // UNLOCKED event) rather than leaving the relayer's UNLOCK stuck
        // forever and the happy path unable to reach Delivered. Safe
        // because a SEALED box can't boot into IDLE (only TAMPERED
        // survives a reboot as itself), and ARMING never reached SEALED,
        // so no UNLOCK can exist for an order that was never InTransit.
        doUnlock(cmdId);
        handled = true;
      } else if (strcmp(cmdType, "RESET") == 0 &&
                 (ctx.state == BoxState::TAMPERED || ctx.state == BoxState::OPEN_AUTHORIZED)) {
        doReset(cmdId);
        handled = true;
      } else if (strcmp(cmdType, "RESET") == 0 && ctx.state == BoxState::IDLE) {
        // Idempotent: e.g. the box already reset itself (UNLOCK->IDLE via a
        // prior RESET) but the relayer hasn't seen that RESET_DONE yet and
        // keeps resending. Re-ack it rather than ignoring it forever --
        // otherwise a depot's RESET can get stuck waiting on a box that's
        // already in the state it asked for.
        doReset(cmdId);
        handled = true;
      } else {
        // Invalid for the current state (e.g. a resent SEAL after the box
        // is already SEALED, or an UNLOCK for a stale order_id). Judgment
        // call: don't ack it and don't mark it handled -- leave it pending
        // so a legitimate state change lets it be re-evaluated later,
        // rather than silently dropping a command the relayer thinks is
        // still outstanding. Flagged for the team. Logged only once per
        // cmd_id (not every loop() tick) since the relayer keeps resending
        // an unacked command on every response.
        if (strcmp(cmdId, lastIgnoredCmdId) != 0) {
          strlcpy(lastIgnoredCmdId, cmdId, sizeof(lastIgnoredCmdId));
          Serial.printf("IGNORED command %s (id=%s, order=%lu) invalid for state %s\n",
                        cmdType, cmdId, (unsigned long)cmdOrderId, boxStateName(ctx.state));
        }
      }
      if (handled) {
        strlcpy(ctx.lastHandledCmdId, cmdId, sizeof(ctx.lastHandledCmdId));
        networkAckCommandHandled(cmdId);
      }
    }
  }
}
