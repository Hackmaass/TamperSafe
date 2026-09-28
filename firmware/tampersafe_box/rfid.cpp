#include "rfid.h"
#include "pins.h"
#include "nvs_store.h"

#include <SPI.h>
// The RC522 clone on this board misreads at the library's 4 MHz default over
// jumper wires; 500 kHz is solid.
#define MFRC522_SPICLOCK 500000
#include <MFRC522.h>

#define MAX_UID 10
#define ABSENT_POLLS 3 // consecutive empty polls before a tag counts as removed

static MFRC522 reader(PIN_RFID_SS, PIN_RFID_RST);

static uint8_t keyUid[MAX_UID];
static size_t keyLen = 0;

// Presentation state: a tag is classified once, when it arrives.
static enum { ABSENT, ARRIVED, CLASSIFIED } phase = ABSENT;
static uint8_t emptyPolls = 0;

bool rfidInit() {
  SPI.begin(PIN_RFID_SCK, PIN_RFID_MISO, PIN_RFID_MOSI, PIN_RFID_SS);
  reader.PCD_Init();
  // Max gain (48 dB) saturates this clone; mid-range reads reliably.
  reader.PCD_SetAntennaGain(MFRC522::RxGain_avg);
  keyLen = nvsLoadKeyUid(keyUid, sizeof(keyUid));
  byte v = reader.PCD_ReadRegister(MFRC522::VersionReg);
  return v != 0x00 && v != 0xFF;
}

bool rfidHasKey() {
  return keyLen != 0;
}

// Presence is the wake-up command (WUPA), which also reaches a tag halted on a
// previous poll. The UID read is best-effort: re-reading right after a halt is
// unreliable on this clone, so a failed read is retried on later polls, with
// the field power-cycled to reset the tag.
Tag rfidScan(bool enroll) {
  byte atqa[2];
  byte size = sizeof(atqa);
  bool present = reader.PICC_WakeupA(atqa, &size) == MFRC522::STATUS_OK;

  if (!present) {
    if (++emptyPolls >= ABSENT_POLLS) phase = ABSENT;
    return Tag::None;
  }
  emptyPolls = 0;
  if (phase == CLASSIFIED) {
    reader.PICC_HaltA(); // keep the tag quiet until it leaves and returns
    return Tag::None;
  }

  if (!reader.PICC_ReadCardSerial()) {
    phase = ARRIVED; // present but unread: try again next poll
    reader.PCD_AntennaOff();
    delay(5);
    reader.PCD_AntennaOn();
    return Tag::None;
  }

  phase = CLASSIFIED;
  size_t len = reader.uid.size;
  uint8_t uid[MAX_UID];
  memcpy(uid, reader.uid.uidByte, len);
  reader.PICC_HaltA();

  if (enroll) {
    memcpy(keyUid, uid, len);
    keyLen = len;
    nvsSaveKeyUid(uid, len);
    return Tag::Key;
  }
  return (keyLen != 0 && len == keyLen && memcmp(uid, keyUid, len) == 0) ? Tag::Key : Tag::Other;
}
