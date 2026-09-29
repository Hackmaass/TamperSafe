// Network side of the SIMULATED BOX, mirroring the firmware's network task:
// batches the core's ring buffer to POST /api/device/events (§9.2), MACs
// each batch with src/protocol.ts, retries with backoff, and hands the
// relayer's pending command back to the core. `fetch` and the clock are
// injectable so the unit tests can run it with no server at all.
//
// It never edits seq/head: a 401/409 is reported, the events stay buffered,
// and the local chain is left exactly as it was (the relayer is the one that
// has to re-base, per §10).
import { computeMac } from "../src/protocol.js";
import type { WireBatch } from "../src/ingest/types.js";
import { BoxCore, SAMPLE_MS, type DeviceCommand } from "./box-sim-core.js";

export const POST_EVERY_MS = 2_000;
export const MAX_BATCH = 20;
export const POST_TIMEOUT_MS = 5_000;
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000];

export type LinkState = "starting" | "ok" | "offline-by-user" | "unreachable" | "rejected";

export interface LinkStatus {
  state: LinkState;
  lastStatus: number | null; // HTTP status of the last POST, null if it never got one
  lastAckSeq: number | null;
  lastError: string | null;
  lastOkAt: number | null;
  failures: number;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface BoxNetOptions {
  core: BoxCore;
  relayerUrl: string;
  secretHex: string;
  fetch?: FetchLike;
  clock?: () => number;
  log?: (level: "info" | "warn" | "error", text: string) => void;
}

export class BoxNet {
  offline = false;
  readonly link: LinkStatus = { state: "starting", lastStatus: null, lastAckSeq: null, lastError: null, lastOkAt: null, failures: 0 };
  private inFlight = false;
  private nextAttemptAt = 0;
  private urgent = false;
  private readonly fetchFn: FetchLike;
  private readonly clock: () => number;

  constructor(private readonly opts: BoxNetOptions) {
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
    this.clock = opts.clock ?? (() => Date.now());
  }

  private log(level: "info" | "warn" | "error", text: string): void {
    this.opts.log?.(level, text);
  }

  /** Ask for a POST as soon as possible (TAMPER / SEALED / UNLOCKED ...).
   * Cuts any error backoff short: a tamper must not wait 15 s. */
  requestFlush(): void {
    this.urgent = true;
  }

  setOffline(offline: boolean): void {
    this.offline = offline;
    if (offline) {
      this.link.state = "offline-by-user";
      this.log("warn", "Wi-Fi OFF: events now buffer in the ring (128 max, oldest dropped when full)");
    } else {
      this.link.state = "starting";
      this.nextAttemptAt = 0;
      this.urgent = true;
      this.log("info", `Wi-Fi ON: flushing ${this.opts.core.outbox.length} buffered event(s)`);
    }
  }

  /** Called by the scheduler; decides whether a POST is due right now. */
  due(): boolean {
    if (this.offline || this.inFlight || this.opts.core.outbox.length === 0) return false;
    const now = this.clock();
    if (this.urgent || this.opts.core.urgentPending) return true;
    return now >= this.nextAttemptAt;
  }

  /** One POST of up to MAX_BATCH buffered events. Returns the command the
   * relayer handed back (already delivered to the core), if any. */
  async pumpOnce(): Promise<DeviceCommand | null> {
    const core = this.opts.core;
    if (this.inFlight || this.offline || core.outbox.length === 0) return null;
    this.inFlight = true;
    this.urgent = false;
    core.urgentPending = false;
    const generation = core.generation;
    const events = core.outbox.slice(0, MAX_BATCH);
    const last = events[events.length - 1]!;
    const batch: WireBatch = {
      box_id: core.boxId,
      events,
      mac: computeMac(this.opts.secretHex, core.boxId, last.seq, last.head),
    };
    let status: number;
    let body: Record<string, unknown>;
    try {
      const res = await this.fetchFn(`${this.opts.relayerUrl}/api/device/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      status = res.status;
      body = ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    } catch (err) {
      this.inFlight = false;
      this.fail("unreachable", null, `relayer unreachable: ${(err as Error).message}`);
      return null;
    }
    this.inFlight = false;
    this.link.lastStatus = status;

    if (core.generation !== generation) {
      // The box rebooted while this POST was in flight: its RAM buffer and
      // armed flag are gone, so neither the ack nor the command applies.
      this.log("warn", `POST ${status} arrived after a power cycle; ignored`);
      return null;
    }

    if (status === 200 && body.ok === true) {
      const ackSeq = Number(body.ack_seq);
      core.ackThrough(ackSeq);
      if (this.link.state !== "ok") this.log("info", `relayer link OK (POST 200, ack_seq ${ackSeq})`);
      this.link.state = "ok";
      this.link.lastAckSeq = ackSeq;
      this.link.lastError = null;
      this.link.lastOkAt = this.clock();
      this.link.failures = 0;
      // More buffered (a flush after Wi-Fi came back)? Go again right away.
      this.nextAttemptAt = core.outbox.length > 0 ? 0 : this.clock() + POST_EVERY_MS;
      const cmd = parseCommand(body.command);
      if (cmd) {
        const produced = core.handleCommand(cmd);
        if (produced.length > 0) this.urgent = true;
      }
      return cmd;
    }

    const error = typeof body.error === "string" ? body.error : `HTTP ${status}`;
    if (status === 400) {
      // A schema rejection can never succeed on retry; drop the batch so the
      // ring doesn't jam. The relayer then sees a seq gap (LOG_GAP).
      core.ackThrough(last.seq);
      this.fail("rejected", status, `400 schema rejected seq ${events[0]!.seq}..${last.seq}, batch dropped: ${error}`);
      return null;
    }
    if (status === 401) {
      this.fail(
        "rejected",
        status,
        `401 ${error}. Either BOX secret differs from the relayer's BOX_SECRETS, or the relayer already holds a different chain for ${core.boxId} at seq >= ${events[0]!.seq} (e.g. the real box used this id). Events stay buffered; --fresh re-provisions from seq 1.`,
      );
      return null;
    }
    if (status === 409) {
      const expected = body.expected_seq;
      this.fail(
        "rejected",
        status,
        `409 FORGERY CHECK: relayer expected seq ${String(expected)} with a different head (${error}). Local chain left untouched (seq ${core.seq}); events stay buffered.`,
      );
      return null;
    }
    this.fail("rejected", status, `HTTP ${status}: ${error}`);
    return null;
  }

  private fail(state: LinkState, status: number | null, message: string): void {
    this.link.state = state;
    this.link.lastStatus = status;
    this.link.lastError = message;
    this.link.failures += 1;
    const wait = BACKOFF_MS[Math.min(this.link.failures - 1, BACKOFF_MS.length - 1)]!;
    this.nextAttemptAt = this.clock() + wait;
    this.log("error", `${message} (retry in ${wait / 1000} s)`);
  }
}

function parseCommand(raw: unknown): DeviceCommand | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.id !== "string" || typeof c.type !== "string" || typeof c.order_id !== "number") return null;
  if (c.type !== "SEAL" && c.type !== "UNLOCK" && c.type !== "RESET") return null;
  return { id: c.id, type: c.type, order_id: c.order_id };
}

/** Wires core + net to real timers: 20 Hz sensor loop, network scheduler.
 * Used by the terminal shell and by the end-to-end check alike. */
export class BoxRuntime {
  private sampleTimer: NodeJS.Timeout | undefined;
  private netTimer: NodeJS.Timeout | undefined;
  private pumping: Promise<unknown> = Promise.resolve();

  constructor(
    readonly core: BoxCore,
    readonly net: BoxNet,
  ) {}

  start(): void {
    this.core.boot();
    this.net.requestFlush();
    this.sampleTimer = setInterval(() => this.core.tick(), SAMPLE_MS);
    this.netTimer = setInterval(() => {
      if (this.net.due()) this.pumping = this.net.pumpOnce().catch(() => null);
    }, 100);
  }

  powerCycle(): void {
    this.core.powerCycle();
    this.net.requestFlush();
  }

  async stop(): Promise<void> {
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    if (this.netTimer) clearInterval(this.netTimer);
    await this.pumping;
  }
}
