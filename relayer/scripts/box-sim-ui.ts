// Terminal panel for the SIMULATED BOX. renderFrame() is a pure function of a
// snapshot, so the tests can render every state at any width without a TTY.
// Raw ANSI only (no UI dependency): colours, a 3-row block font for the box
// state, and an emulated RGB LED that follows the HARDWARE.md LED semantics.
import type { BoxState, LockState } from "../src/protocol.js";
import type { LedColor } from "./box-sim-core.js";
import type { LinkStatus } from "./box-sim-net.js";

export interface LogLine {
  at: number; // ms
  kind: "event" | "note" | "net";
  level: "info" | "warn" | "error";
  text: string;
  type?: string; // device event type, for colour
}

export interface UiSnapshot {
  now: number;
  boxId: string;
  relayerUrl: string;
  relayerChain: string | null;
  link: LinkStatus;
  offline: boolean;
  state: BoxState;
  orderId: number;
  lock: LockState;
  lidClosed: boolean;
  armed: boolean;
  led: LedColor;
  battMv: number;
  accelMg: number;
  tiltDeg: number;
  seq: number;
  head: string;
  buffered: number;
  dropped: number;
  tamperCode: number;
  log: LogLine[];
  banner: string | null; // one-shot prompt, e.g. quit confirmation
  auto: string | null;
}

export interface RenderOpts {
  cols: number;
  rows: number;
  color: boolean;
  unicode: boolean;
}

// --- ANSI helpers -----------------------------------------------------------
const ESC = "\x1b[";
function sgr(on: boolean, codes: string, s: string): string {
  return on ? `${ESC}${codes}m${s}${ESC}0m` : s;
}
/** Visible length, ignoring ANSI escapes. */
export function visibleLength(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").length;
}

// --- 3x5 pixel font, drawn as 3 text rows with half blocks -----------------
const FONT: Record<string, string[]> = {
  A: ["111", "101", "111", "101", "101"],
  B: ["110", "101", "110", "101", "110"],
  D: ["110", "101", "101", "101", "110"],
  E: ["111", "100", "110", "100", "111"],
  G: ["111", "100", "101", "101", "111"],
  H: ["101", "101", "111", "101", "101"],
  I: ["111", "010", "010", "010", "111"],
  L: ["100", "100", "100", "100", "111"],
  M: ["10001", "11011", "10101", "10001", "10001"],
  N: ["1001", "1101", "1011", "1001", "1001"],
  O: ["111", "101", "101", "101", "111"],
  P: ["111", "101", "111", "100", "100"],
  R: ["110", "101", "110", "101", "101"],
  S: ["111", "100", "111", "001", "111"],
  T: ["111", "010", "010", "010", "010"],
  U: ["101", "101", "101", "101", "111"],
  Z: ["111", "001", "010", "100", "111"],
  _: ["000", "000", "000", "000", "111"],
};

export function bigText(word: string, unicode: boolean): string[] {
  const rows = ["", "", ""];
  const chars = [...word];
  chars.forEach((ch, idx) => {
    const g = FONT[ch] ?? FONT._!;
    const px = [...g, "0".repeat(g[0]!.length)]; // pad to 6 pixel rows
    for (let r = 0; r < 3; r++) {
      const top = px[2 * r]!;
      const bot = px[2 * r + 1]!;
      let line = "";
      for (let c = 0; c < top.length; c++) {
        const t = top[c] === "1";
        const b = bot[c] === "1";
        if (unicode) line += t && b ? "█" : t ? "▀" : b ? "▄" : " ";
        else line += t || b ? "#" : " ";
      }
      rows[r] += line + (idx < chars.length - 1 ? " " : "");
    }
  });
  return rows;
}

const STATE_STYLE: Record<BoxState, string> = {
  SEALED: "1;97", // bold bright white
  TAMPERED: "1;91", // bold red
  IDLE: "2;37", // dim
  OPEN_AUTHORIZED: "1;92", // bold green
  ARMING: "1;93",
  BOOT: "1;96",
};

const EVENT_STYLE: Record<string, string> = {
  TAMPER: "1;91",
  ALERT: "93",
  SEALED: "1;97",
  SEAL_FAILED: "33",
  UNLOCKED: "1;92",
  RESET_DONE: "96",
  BOOT: "96",
  TELEMETRY: "2;37",
};

const ALERT_NAMES: Record<number, string> = { 10: "SHOCK", 11: "TILT", 17: "AUTH_FAILED" };
const TAMPER_NAMES: Record<number, string> = { 1: "LID_OPENED", 2: "CONTENTS_DISTURBED", 3: "POWER_INTERRUPTED" };
export function codeName(type: string, code: number): string {
  if (type === "TAMPER") return TAMPER_NAMES[code] ?? `code ${code}`;
  if (type === "ALERT") return ALERT_NAMES[code] ?? `code ${code}`;
  return "";
}

function hhmmss(ms: number): string {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

function ledBlock(s: UiSnapshot, o: RenderOpts): string {
  const phase = Math.floor(s.now / 500) % 2 === 0;
  const cell = "      ";
  const label: Record<LedColor, string> = {
    off: "off",
    blue: "BLUE pulse: armed, waiting for the delivery key",
    green: "GREEN: key accepted",
    red: "RED: wrong tag",
    "red-blink": "RED blink: tamper latched",
  };
  let bg: string;
  switch (s.led) {
    case "blue":
      bg = phase ? "104" : "44";
      break;
    case "green":
      bg = "102";
      break;
    case "red":
      bg = "101";
      break;
    case "red-blink":
      bg = phase ? "101" : "40";
      break;
    default:
      bg = "100";
  }
  if (!o.color) {
    const ch = s.led === "off" || (s.led === "red-blink" && !phase) ? "[      ]" : `[${s.led.toUpperCase().padEnd(6).slice(0, 6)}]`;
    return `${ch} ${label[s.led]}`;
  }
  return `${sgr(true, bg, cell)} ${label[s.led]}`;
}

function linkLine(s: UiSnapshot, o: RenderOpts): string {
  const l = s.link;
  let word: string;
  if (s.offline) word = sgr(o.color, "1;93", "WIFI OFF (buffering)");
  else if (l.state === "ok") word = sgr(o.color, "1;92", "OK");
  else if (l.state === "starting") word = sgr(o.color, "96", "connecting");
  else if (l.state === "unreachable") word = sgr(o.color, "1;91", "UNREACHABLE");
  else word = sgr(o.color, "1;91", `REJECTED ${l.lastStatus ?? ""}`.trim());
  const post = l.lastStatus === null ? "no POST yet" : `last POST ${l.lastStatus}`;
  const ack = l.lastAckSeq === null ? "" : `  ack_seq ${l.lastAckSeq}`;
  const chain = s.relayerChain ? `  chain=${s.relayerChain}` : "";
  return ` relayer ${s.relayerUrl}${chain}  link ${word}  ${post}${ack}`;
}

export function renderFrame(s: UiSnapshot, o: RenderOpts): string[] {
  const cols = Math.max(40, o.cols);
  const out: string[] = [];
  const rule = o.unicode ? "━" : "=";
  const title = ` TAMPERSAFE  SIMULATED BOX  ${s.boxId} `;
  const fill = Math.max(0, cols - 2 - title.length);
  out.push(sgr(o.color, "1;30;107", title) + sgr(o.color, "90", rule.repeat(fill)));
  out.push(sgr(o.color, "33", ` SIMULATED: never run this while the real ${s.boxId} is powered on (same box id).`));
  out.push(linkLine(s, o));
  if (s.link.lastError && s.link.state !== "ok" && !s.offline) {
    // At most two lines, so the frame height stays predictable.
    const msg = ` ! ${s.link.lastError}`;
    const w = cols - 1;
    out.push(sgr(o.color, "91", msg.slice(0, w)));
    if (msg.length > w) out.push(sgr(o.color, "91", msg.slice(w, 2 * w)));
  } else {
    const bufLine = ` buffered ${s.buffered}${s.dropped ? `  dropped by ring overflow ${s.dropped}` : ""}`;
    out.push(s.buffered > 0 || s.dropped > 0 ? sgr(o.color, "93", bufLine) : sgr(o.color, "2", bufLine));
  }
  out.push("");

  // Box state, big when there is room.
  const style = STATE_STYLE[s.state];
  const big = bigText(s.state, o.unicode);
  if (visibleLength(big[0]!) + 2 <= cols) {
    for (const row of big) out.push("  " + sgr(o.color, style, row));
  } else {
    out.push("  " + sgr(o.color, `${style};7`, `  ${s.state}  `));
  }
  const sub: string[] = [];
  if (s.state === "TAMPERED") sub.push(`latched: ${TAMPER_NAMES[s.tamperCode] ?? `code ${s.tamperCode}`} (only RESET clears it)`);
  if (s.armed) sub.push("ARMED: buyer requested unlock, tap the delivery key [r]");
  if (s.auto) sub.push(s.auto);
  out.push(sub.length ? "  " + sgr(o.color, s.state === "TAMPERED" ? "91" : "94", sub.join("   ")) : "");

  const lock = s.lock === "L" ? sgr(o.color, "1;97", "LOCKED") : sgr(o.color, "92", "UNLOCKED");
  const lid = s.lidClosed ? sgr(o.color, "97", "CLOSED") : sgr(o.color, "1;93", "OPEN");
  out.push(` order ${s.orderId ? `#${s.orderId}` : "-"}   lock ${lock}   lid ${lid}`);
  out.push(` LED ${ledBlock(s, o)}`);
  const batt = (s.battMv / 1000).toFixed(2);
  const battStr = s.battMv < 10_500 ? sgr(o.color, "91", `${batt} V LOW`) : `${batt} V`;
  out.push(` battery ${battStr}   accel ${s.accelMg} mg   tilt ${s.tiltDeg} deg`);
  out.push(` seq ${s.seq}   head ${s.head.slice(0, 8)}   GPS fix 0 (box has none; the dashboard route is SIMULATED)`);
  out.push("");

  // Everything below the log is 4 lines; shrink the log to fit short windows.
  const logRows = Math.max(3, Math.min(8, o.rows - out.length - 5));
  out.push(sgr(o.color, "1", " recent"));
  const recent = s.log.slice(-logRows);
  for (let i = 0; i < logRows; i++) {
    const l = recent[i];
    if (!l) {
      out.push("");
      continue;
    }
    let text = `  ${hhmmss(l.at)}  ${l.text}`;
    if (text.length > cols - 1) text = text.slice(0, cols - 2) + "~";
    let code: string;
    if (l.kind === "event") code = EVENT_STYLE[l.type ?? ""] ?? "0";
    else code = l.level === "error" ? "91" : l.level === "warn" ? "33" : "2;36";
    out.push(sgr(o.color, code, text));
  }
  if (s.banner) out.push(sgr(o.color, "1;30;103", ` ${s.banner} `));
  else out.push("");
  const keys = [
    "[l] lift lid  [c] close lid  [r] RIGHT tag  [w] WRONG tag  [p] power cycle",
    `[s] shock  [t] tilt 4 s  [o] wifi ${s.offline ? "ON " : "OFF"}  [b] battery low/ok  [n] send now  [q] quit`,
  ];
  for (const k of keys) out.push(sgr(o.color, "2", " " + k));
  return out;
}
