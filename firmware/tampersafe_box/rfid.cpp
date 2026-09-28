#include "rfid.h"
#include "pins.h"
#include "events.h"

#include <SPI.h>
// The RC522 clone on this board misreads at the library's 4 MHz default over
// jumper wires; 500 kHz is solid.
#define MFRC522_SPICLOCK 500000
#include <MFRC522.h>

#define MISMATCH_POLLS 3
#define ALERT_PACKAGE_MISMATCH 16

// RST not wired (see pins.h), so the library only soft-resets.
static MFRC522 reader(PIN_RFID_SS, MFRC522::UNUSED_PIN);

static byte boundUid[10];
static byte boundLen = 0;
static uint8_t missPolls = 0;
static bool alerted = false;

struct Reading {
  bool present; // a tag answered the wake-up
  bool uidOk;   // and its UID was read this time
  byte uid[10];
  byte len;
};

// Presence is the wake-up command (WUPA), which works on a tag that was halted
// last poll. Re-reading the UID after a halt is unreliable on this clone, so
// the UID is best-effort and only a successful read can prove a change.
static Reading poll() {
  Reading r{};
  for (int attempt = 0; attempt < 3; attempt++) {
    byte atqa[2];
    byte size = sizeof(atqa);
    if (reader.PICC_WakeupA(atqa, &size) == MFRC522::STATUS_OK) {
      r.present = true;
      if (reader.PICC_ReadCardSerial()) {
        r.uidOk = true;
        r.len = reader.uid.size;
        memcpy(r.uid, reader.uid.uidByte, r.len);
      }
      reader.PICC_HaltA();
      return r;
    }
    delay(10);
  }
  return r;
}

bool rfidInit() {
  SPI.begin(PIN_RFID_SCK, PIN_RFID_MISO, PIN_RFID_MOSI, PIN_RFID_SS);
  reader.PCD_Init();
  // Max gain (48 dB) saturates this clone; mid-range reads reliably.
  reader.PCD_SetAntennaGain(MFRC522::RxGain_avg);
  byte v = reader.PCD_ReadRegister(MFRC522::VersionReg);
  return v != 0x00 && v != 0xFF;
}

bool rfidBind() {
  rfidUnbind();
  for (int i = 0; i < 5; i++) { // a fresh tag can need a couple of tries to read
    Reading r = poll();
    if (r.present && r.uidOk) {
      boundLen = r.len;
      memcpy(boundUid, r.uid, r.len);
      return true;
    }
    delay(50);
  }
  return false;
}

void rfidWatch() {
  if (boundLen == 0 || alerted) return;
  Reading r = poll();
  bool changed = r.uidOk && (r.len != boundLen || memcmp(r.uid, boundUid, boundLen) != 0);
  if (r.present && !changed) {
    missPolls = 0;
    return;
  }
  if (++missPolls >= MISMATCH_POLLS) {
    alerted = true;
    emitAlertEvent(ALERT_PACKAGE_MISMATCH);
  }
}

void rfidUnbind() {
  boundLen = 0;
  missPolls = 0;
  alerted = false;
}

bool rfidBound() {
  return boundLen != 0;
}
