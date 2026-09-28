// TamperSafe bring-up: RC522 read test on the extension board's RFID socket.
// Pin mapping found by rfid_pin_scan (29-Sep-2026): SS=3, SCK=18, MOSI=17,
// MISO=16, RST=15 (also the CH15 IR pin -- keep the IR sensor off CH15).
// Hold a tag on the reader; it prints the UID once per second.
// A stationary tag must read "present" on every poll: uses WakeupA + read
// serial + HaltA, because IsNewCardPresent() alternates for a stationary tag.
#include <Newrick.h>
#include <SPI.h>
#define MFRC522_SPICLOCK 500000 // jumper wires: 4 MHz default is marginal
#include <MFRC522.h>

#define RFID_SS   3
#define RFID_SCK  18
#define RFID_MOSI 17
#define RFID_MISO 16
#define RFID_RST  15

Newrick nr;
MFRC522 rfid(RFID_SS, RFID_RST);

void setup() {
  Serial.begin(115200);
  delay(2000);
  nr.begin();
  SPI.begin(RFID_SCK, RFID_MISO, RFID_MOSI, RFID_SS);
  rfid.PCD_Init();
  byte v = rfid.PCD_ReadRegister(MFRC522::VersionReg);
  Serial.printf("RC522 VersionReg=0x%02X (%s)\n", v, (v == 0x91 || v == 0x92) ? "genuine" : (v == 0x00 || v == 0xFF) ? "NOT RESPONDING" : "clone/other");
  Serial.printf("Self test: %s\n", rfid.PCD_PerformSelfTest() ? "PASS" : "FAIL");
  rfid.PCD_Init();
  rfid.PCD_SetAntennaGain(MFRC522::RxGain_max);
  Serial.printf("readback: TxASK=0x%02X(exp 40) Mode=0x%02X(exp 3D) TReloadH/L=0x%02X%02X(exp 03E8) TxControl=0x%02X(bits0-1 must be 3=antenna on)\n",
    rfid.PCD_ReadRegister(MFRC522::TxASKReg), rfid.PCD_ReadRegister(MFRC522::ModeReg),
    rfid.PCD_ReadRegister(MFRC522::TReloadRegH), rfid.PCD_ReadRegister(MFRC522::TReloadRegL),
    rfid.PCD_ReadRegister(MFRC522::TxControlReg));
  Serial.println("Hold a tag on the reader...");
}

void loop() {
  byte atqa[2]; byte len = sizeof(atqa);
  MFRC522::StatusCode st = rfid.PICC_WakeupA(atqa, &len);
  bool got = (st == MFRC522::STATUS_OK && rfid.PICC_ReadCardSerial());
  if (!got && rfid.PICC_IsNewCardPresent() && rfid.PICC_ReadCardSerial()) got = true;
  if (got) {
    Serial.print("TAG UID:");
    for (byte i = 0; i < rfid.uid.size; i++) Serial.printf(" %02X", rfid.uid.uidByte[i]);
    Serial.println();
    rfid.PICC_HaltA();
  } else {
    Serial.println("no tag");
  }
  delay(1000);
}
