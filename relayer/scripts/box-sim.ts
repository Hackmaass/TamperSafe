// SIMULATED BOX: `npm run box`. A stand-in for the real ESP32 box that speaks
// the exact device protocol to the relayer over HTTP and holds no wallet.
// This file is only the shell (config, keys, terminal); the behaviour lives
// in box-sim-core.ts (state machine) and box-sim-net.ts (batch POSTs).
//
//   npm run box -- [--fresh] [--relayer URL] [--box ID] [--state FILE]
//                  [--auto SECONDS] [--plain] [--no-color]
//
// The box secret comes from BOX_SECRET_HEX, else from BOX_SECRETS in
// relayer/.env (parsed, never loaded into process.env). It is never printed.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import type { WireEvent } from "../src/ingest/types.js";
import { BoxCore, FileNvs, type NoteEntry } from "./box-sim-core.js";
import { BoxNet, BoxRuntime } from "./box-sim-net.js";
import { codeName, renderFrame, type LogLine, type UiSnapshot } from "./box-sim-ui.js";

const RELAYER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface SimArgs {
  fresh: boolean;
  relayerUrl: string;
  boxId: string;
  stateFile: string;
  autoTapSeconds: number | null;
  unicode: boolean;
  color: boolean;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv): SimArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const boxId = get("--box") ?? env.BOX_ID ?? "TS-BOX-01";
  if (!/^[A-Za-z0-9_-]+$/.test(boxId)) throw new Error(`box-sim: invalid box id ${JSON.stringify(boxId)}`);
  let autoTapSeconds: number | null = null;
  if (argv.includes("--auto")) {
    const raw = get("--auto");
    autoTapSeconds = raw !== undefined && /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : 5;
  }
  return {
    fresh: argv.includes("--fresh"),
    relayerUrl: (get("--relayer") ?? env.RELAYER_URL ?? "http://127.0.0.1:4000").replace(/\/+$/, ""),
    boxId,
    stateFile: path.resolve(get("--state") ?? path.join(RELAYER_DIR, "data", `box-sim-${boxId}.json`)),
    autoTapSeconds,
    unicode: !argv.includes("--plain"),
    color: !argv.includes("--no-color") && !env.NO_COLOR,
  };
}

const HEX64 = /^[0-9a-fA-F]{64}$/;

/** Finds the box secret without ever putting it in an error message, a log
 * line or process.env. Returns where it came from so the banner can say so. */
export function resolveSecret(boxId: string, env: NodeJS.ProcessEnv, envFile: string): { secretHex: string; source: string } {
  const direct = env.BOX_SECRET_HEX;
  if (direct !== undefined && direct !== "") {
    if (!HEX64.test(direct)) throw new Error("box-sim: BOX_SECRET_HEX is set but is not a 64-character hex string (value not shown).");
    return { secretHex: direct.toLowerCase(), source: "BOX_SECRET_HEX" };
  }
  let raw = env.BOX_SECRETS;
  let source = "BOX_SECRETS (environment)";
  if (raw === undefined || raw === "") {
    if (!fs.existsSync(envFile)) {
      throw new Error(`box-sim: no box secret. Set BOX_SECRET_HEX, or BOX_SECRETS in ${envFile} (JSON box_id -> hex).`);
    }
    raw = dotenv.parse(fs.readFileSync(envFile)).BOX_SECRETS;
    source = `BOX_SECRETS in ${envFile}`;
  }
  if (raw === undefined || raw === "") {
    throw new Error(`box-sim: no box secret. Set BOX_SECRET_HEX, or BOX_SECRETS in ${envFile} (JSON box_id -> hex).`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`box-sim: ${source} is not valid JSON (value not shown).`);
  }
  const value = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>)[boxId] : undefined;
  if (typeof value !== "string") throw new Error(`box-sim: ${source} has no entry for ${boxId}.`);
  if (!HEX64.test(value)) throw new Error(`box-sim: ${source}["${boxId}"] is not a 64-character hex string (value not shown).`);
  return { secretHex: value.toLowerCase(), source };
}

function eventText(e: WireEvent): string {
  const name = codeName(e.type, e.code);
  const code = e.code ? ` ${e.code}${name ? ` ${name}` : ""}` : "";
  const cmd = e.cmd_id ? ` cmd=${e.cmd_id}` : "";
  const order = e.order_id ? ` order #${e.order_id}` : "";
  return `#${e.seq} ${e.type}${code}  ${e.state}${order} lock ${e.lock} lid ${e.lid ? "closed" : "open"}${cmd}`;
}

async function fetchChain(url: string): Promise<string | null> {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(3000) });
    const body = (await res.json()) as { chain?: string };
    return typeof body.chain === "string" ? body.chain : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), process.env);
  const { secretHex, source } = resolveSecret(args.boxId, process.env, path.join(RELAYER_DIR, ".env"));

  if (args.fresh && fs.existsSync(args.stateFile)) {
    fs.rmSync(args.stateFile);
    console.log(`[box-sim] --fresh: deleted ${args.stateFile}; the chain restarts at seq 1 (the relayer treats it as a re-provisioned box).`);
  }

  const tty = Boolean(process.stdout.isTTY && process.stdin.isTTY);
  const log: LogLine[] = [];
  const push = (line: LogLine) => {
    const prev = log[log.length - 1];
    // Collapse runs of TELEMETRY into one line so they don't bury the
    // events that matter.
    if (line.type === "TELEMETRY" && prev?.type === "TELEMETRY") log[log.length - 1] = line;
    else log.push(line);
    if (log.length > 50) log.shift();
    if (!tty) console.log(`${new Date(line.at).toISOString().slice(11, 19)} ${line.kind === "event" ? "EVENT" : line.level.toUpperCase()} ${line.text}`);
  };

  const core = new BoxCore({
    boxId: args.boxId,
    nvs: new FileNvs(args.stateFile),
    onEvent: (e) => push({ at: Date.now(), kind: "event", level: "info", text: eventText(e), type: e.type }),
    onNote: (n: NoteEntry) => push({ at: n.at, kind: "note", level: n.level, text: n.text }),
  });
  const net = new BoxNet({
    core,
    relayerUrl: args.relayerUrl,
    secretHex,
    log: (level, text) => push({ at: Date.now(), kind: "net", level, text }),
  });
  const runtime = new BoxRuntime(core, net);

  console.log("");
  console.log("  ==============================================================");
  console.log("   TAMPERSAFE  SIMULATED BOX");
  console.log("  ==============================================================");
  console.log(`   box id   ${args.boxId}   (secret from ${source}; never shown)`);
  console.log(`   relayer  ${args.relayerUrl}`);
  console.log(`   state    ${args.stateFile}`);
  console.log("   WARNING: do not run this while the real box with the same id is");
  console.log("   powered on. Both would write one hash chain and lock each other out.");
  const chain = await fetchChain(args.relayerUrl);
  if (chain === null) console.log("   relayer health check failed; events will buffer until it answers.");
  else console.log(`   relayer is up, chain=${chain}${chain === "mst" ? " (events you trigger make real MST testnet transactions)" : ""}`);
  console.log("");

  runtime.start();

  let banner: string | null = null;
  let quitArmed = false;
  let autoTimer: NodeJS.Timeout | null = null;
  let autoLabel: string | null = null;
  let stopping = false;

  const snapshot = (): UiSnapshot => ({
    now: Date.now(),
    boxId: args.boxId,
    relayerUrl: args.relayerUrl,
    relayerChain: chain,
    link: net.link,
    offline: net.offline,
    state: core.state,
    orderId: core.orderId,
    lock: core.lock,
    lidClosed: core.world.lidClosed,
    armed: core.armed,
    led: core.led(),
    battMv: core.batteryMv(),
    accelMg: core.accelMg,
    tiltDeg: core.tiltDeg,
    seq: core.seq,
    head: core.head,
    buffered: core.outbox.length,
    dropped: core.droppedFromRing,
    tamperCode: core.tamperCode,
    log,
    banner,
    auto: autoLabel,
  });

  const draw = () => {
    if (!tty) return;
    const lines = renderFrame(snapshot(), {
      cols: process.stdout.columns ?? 100,
      rows: process.stdout.rows ?? 30,
      color: args.color,
      unicode: args.unicode,
    });
    process.stdout.write("\x1b[H" + lines.map((l) => l + "\x1b[K").join("\n") + "\x1b[J");
  };

  const restoreTerminal = () => {
    if (!tty) return;
    try {
      process.stdin.setRawMode(false);
    } catch {
      // stdin already closed
    }
    process.stdout.write("\x1b[?25h\x1b[?1049l");
  };

  const quit = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    clearInterval(drawTimer);
    clearInterval(autoWatch);
    if (autoTimer) clearTimeout(autoTimer);
    await runtime.stop();
    // Best-effort flush of anything still buffered (up to 3 s).
    const deadline = Date.now() + 3000;
    while (!net.offline && core.outbox.length > 0 && Date.now() < deadline && net.link.state !== "rejected") {
      await net.pumpOnce();
      if (core.outbox.length > 0) await new Promise((r) => setTimeout(r, 200));
    }
    restoreTerminal();
    console.log(`[box-sim] stopped at seq ${core.seq}, state ${core.state}${core.outbox.length ? `, ${core.outbox.length} event(s) unsent` : ""}.`);
    process.exit(code);
  };

  const onKey = (key: string) => {
    if (stopping) return;
    if (quitArmed && key !== "q" && key !== "\u0003") {
      quitArmed = false;
      banner = null;
      return;
    }
    switch (key) {
      case "l":
        core.liftLid();
        break;
      case "c":
        core.closeLid();
        break;
      case "r":
        core.tapTag("RIGHT");
        break;
      case "w":
        core.tapTag("WRONG");
        break;
      case "p":
        runtime.powerCycle();
        break;
      case "s":
        core.shock();
        break;
      case "t":
        core.tilt(4000);
        break;
      case "o":
        net.setOffline(!net.offline);
        break;
      case "b":
        core.setBatteryMv(core.world.battMv < 10_500 ? 11_700 : 10_200);
        break;
      case "n":
        core.telemetryNow();
        net.requestFlush();
        break;
      case "q":
      case "\u0003": // Ctrl+C in raw mode
        if (core.state === "SEALED" && !quitArmed) {
          quitArmed = true;
          banner = "Box is SEALED: quitting = power loss, next start latches TAMPER POWER_INTERRUPTED. q again to quit, any key to cancel";
          break;
        }
        void quit(0);
        return;
      default:
        return;
    }
    draw();
  };

  // --auto: once armed, tap the right tag after N seconds (hands-free demo).
  const autoWatch = setInterval(() => {
    if (args.autoTapSeconds === null) return;
    if (core.armed && !autoTimer) {
      const due = Date.now() + args.autoTapSeconds * 1000;
      autoTimer = setTimeout(() => {
        autoTimer = null;
        autoLabel = null;
        if (core.armed) core.tapTag("RIGHT");
      }, args.autoTapSeconds * 1000);
      const tickLabel = () => {
        autoLabel = autoTimer ? `--auto: tapping the delivery key in ${Math.max(0, Math.ceil((due - Date.now()) / 1000))} s` : null;
      };
      tickLabel();
      const labelTimer = setInterval(() => (autoTimer ? tickLabel() : clearInterval(labelTimer)), 250);
    } else if (!core.armed && autoTimer) {
      clearTimeout(autoTimer);
      autoTimer = null;
      autoLabel = null;
    }
  }, 200);

  if (tty) {
    process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J");
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on("keypress", (str: string | undefined, key: { name?: string; ctrl?: boolean } | undefined) => {
      if (key?.ctrl && key.name === "c") onKey("\u0003");
      else if (str) onKey(str.toLowerCase());
    });
    process.stdout.on("resize", () => {
      process.stdout.write("\x1b[2J");
      draw();
    });
  } else {
    // Not a terminal (piped/CI): each character on stdin is a key press.
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      for (const ch of chunk) if (ch.trim()) onKey(ch.toLowerCase());
    });
    process.stdin.on("end", () => void quit(0));
  }
  process.on("SIGINT", () => onKey("\u0003"));
  process.on("uncaughtException", (err) => {
    restoreTerminal();
    console.error("[box-sim] crashed:", err.message);
    process.exit(1);
  });

  const drawTimer = setInterval(draw, 200);
  draw();
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    process.stdout.write("\x1b[?25h");
    console.error((err as Error).message);
    process.exit(1);
  });
}
