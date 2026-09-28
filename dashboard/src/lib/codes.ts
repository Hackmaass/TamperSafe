// Shared codes, ARCHITECTURE.md §6 -- the one place the UI turns a number
// into a name, so a raw code never reaches the screen.

export const TAMPER_CODES: Record<number, string> = {
  1: "LID_OPENED",
  2: "CONTENTS_DISTURBED",
  3: "POWER_INTERRUPTED",
};

// Alerts are evidence only: they never move funds.
export const ALERT_CODES: Record<number, string> = {
  10: "SHOCK",
  11: "TILT",
  12: "SIGNAL_LOST",
  13: "LOG_GAP",
  14: "ROUTE_DEVIATION",
  15: "SENSOR_FAULT",
  16: "PACKAGE_MISMATCH",
};

// TamperSafeEscrow.ReleaseKind
export const RELEASE_KINDS = ["Paid to seller", "Refunded to buyer", "Bond slashed to seller"] as const;

export function tamperName(code: number): string {
  return TAMPER_CODES[code] ?? `CODE_${code}`;
}

export function alertName(code: number): string {
  return ALERT_CODES[code] ?? `CODE_${code}`;
}
