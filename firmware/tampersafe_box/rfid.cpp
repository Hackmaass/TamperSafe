#include "rfid.h"
#include "pins.h"
#include "nvs_store.h"

#include <SPI.h>
// The RC522 clone on this board misreads at the library's 4 MHz default over
// jumper wires; 500 kHz is solid.
#define MFRC522_SPICLOCK 500000
#include <MFRC522.h>

#define MAX_UID 10

static MFRC522 reader(PIN_RFID_SS, PIN_RFID_RST);

static uint8_t keyUid[MAX_UID];
static size_t keyLen = 0;

// Official delivery key: 20 85 89 56
static const uint8_t DEFAULT_KEY_UID[4] = { 0x20, 0x85, 0x89, 0x56 };

bool rfidInit() {
  SPI.begin(PIN_RFID_SCK, PIN_RFID_MISO, PIN_RFID_MOSI, PIN_RFID_SS);
  reader.PCD_Init();
  // Max gain (48 dB) saturates this clone; mid-range reads reliably.
  reader.PCD_SetAntennaGain(MFRC522::RxGain_avg);
  keyLen = nvsLoadKeyUid(keyUid, sizeof(keyUid));
  if (keyLen != 4 || memcmp(keyUid, DEFAULT_KEY_UID, 4) != 0) {
    memcpy(keyUid, DEFAULT_KEY_UID, 4);
    keyLen = 4;
    nvsSaveKeyUid(keyUid, keyLen);
  }
  byte v = reader.PCD_ReadRegister(MFRC522::VersionReg);
  return v != 0x00 && v != 0xFF;
}

bool rfidHasKey() {
  return keyLen != 0;
}

// One result per tap. PICC_IsNewCardPresent (REQA) only answers a tag in the
// IDLE state; after a successful read we halt it, so it stays silent until it
// leaves the field and comes back fresh. A failed UID read simply returns None
// and is retried on the next poll, so it is never reported as "wrong".
Tag rfidScan(bool enroll) {
  if (!reader.PICC_IsNewCardPresent()) return Tag::None;
  if (!reader.PICC_ReadCardSerial()) return Tag::None;

  size_t len = reader.uid.size;
  uint8_t uid[MAX_UID];
  memcpy(uid, reader.uid.uidByte, len);
  reader.PICC_HaltA();
  reader.PCD_StopCrypto1();

  if (enroll) {
    memcpy(keyUid, uid, len);
    keyLen = len;
    nvsSaveKeyUid(uid, len);
    return Tag::Key;
  }
  return (keyLen != 0 && len == keyLen && memcmp(uid, keyUid, len) == 0) ? Tag::Key : Tag::Other;
}
