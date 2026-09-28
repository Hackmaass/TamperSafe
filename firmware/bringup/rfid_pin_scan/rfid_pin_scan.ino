// TamperSafe bring-up: find which RC522 wire is on which extension-board pin.
//
// The extension board's RFID socket reads 3V3, IO15, GND, IO16, IO17, IO18,
// IO3 (photo 29-Sep). That is five signal GPIOs, but which RC522 pin (SDA/SS,
// SCK, MOSI, MISO, RST) each jumper goes to isn't known. This sketch tries all
// 5! = 120 assignments: for each one it starts SPI, pulses RST, and reads the
// MFRC522 VersionReg (0x37). A real chip answers 0x91/0x92 (0x88/0x12 for
// clones); a wrong mapping reads 0x00 or 0xFF.
//
// BEFORE RUNNING: unplug the IR sensor from CH15 -- GPIO15 is one of the five
// lines here, and the IR output would fight the RC522 on it.
// Wrong guesses briefly drive a few pins the wrong way at 3.3 V. That is
// harmless to the RC522, and no motors or servos are involved.
//
// Uses raw SPI (no library), and no Wire calls, so nr.begin() is untouched.

#include <Newrick.h>
#include <SPI.h>

Newrick nr;

static const int PINS[5] = {15, 16, 17, 18, 3};
enum Role { SS_, SCK_, MOSI_, MISO_, RST_ };
static const char *ROLE_NAME[5] = {"SDA/SS", "SCK", "MOSI", "MISO", "RST"};

static uint8_t readReg(SPIClass &spi, int ss, uint8_t reg) {
  spi.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
  digitalWrite(ss, LOW);
  spi.transfer(((reg << 1) & 0x7E) | 0x80);
  uint8_t v = spi.transfer(0);
  digitalWrite(ss, HIGH);
  spi.endTransaction();
  return v;
}

static bool validVersion(uint8_t v) { return v == 0x91 || v == 0x92 || v == 0x88 || v == 0x12; }

// perm[role] = index into PINS
static uint8_t tryMapping(const int perm[5], bool pulseRst) {
  int ss = PINS[perm[SS_]], sck = PINS[perm[SCK_]], mosi = PINS[perm[MOSI_]];
  int miso = PINS[perm[MISO_]], rst = PINS[perm[RST_]];
  SPIClass spi(FSPI);
  if (pulseRst) {
    pinMode(rst, OUTPUT);
    digitalWrite(rst, LOW);
    delay(2);
    digitalWrite(rst, HIGH);
    delay(50);
  } else {
    pinMode(rst, INPUT); // fifth line may be IRQ (an RC522 output) -- never drive it
  }
  pinMode(ss, OUTPUT);
  digitalWrite(ss, HIGH);
  spi.begin(sck, miso, mosi, ss);
  uint8_t v = readReg(spi, ss, 0x37);
  spi.end();
  return v;
}

static bool nextPerm(int *a, int n) { // lexicographic next permutation
  int i = n - 2;
  while (i >= 0 && a[i] >= a[i + 1]) i--;
  if (i < 0) return false;
  int j = n - 1;
  while (a[j] <= a[i]) j--;
  int t = a[i]; a[i] = a[j]; a[j] = t;
  for (int l = i + 1, r = n - 1; l < r; l++, r--) { t = a[l]; a[l] = a[r]; a[r] = t; }
  return true;
}

void setup() {
  Serial.begin(115200);
  delay(2000);
  nr.begin(); // I2C for the board; RFID scan below never touches Wire

  for (int pass = 0; pass < 2; pass++) {
    Serial.printf("=== PASS %d: 120 mappings over GPIO 15,16,17,18,3, fifth pin %s ===\n", pass + 1,
                  pass == 0 ? "= RST (pulsed)" : "left as input (IRQ / unused)");
    int perm[5] = {0, 1, 2, 3, 4};
    int hits = 0, tried = 0;
    do {
      tried++;
      uint8_t v = tryMapping(perm, pass == 0);
      if (validVersion(v) || (v != 0x00 && v != 0xFF)) {
        if (validVersion(v)) hits++;
        Serial.printf("%s (VersionReg=0x%02X):\n", validVersion(v) ? "FOUND" : "odd read", v);
        for (int r = 0; r < 5; r++) Serial.printf("  %-6s = GPIO %d\n", ROLE_NAME[r], PINS[perm[r]]);
      }
    } while (nextPerm(perm, 5));
    Serial.printf("=== pass %d done: %d tried, %d valid ===\n", pass + 1, tried, hits);
  }
}

void loop() { delay(1000); }
