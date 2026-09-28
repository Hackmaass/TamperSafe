// Thin client for the relayer REST API (relayer/src/routes.ts). Types mirror
// what the relayer actually sends -- see relayer/src/boxTracker.ts and
// relayer/src/ingest/types.ts.

export type GpsBadge = "LIVE" | "NO_FIX" | "SIMULATED";
export type BoxState = "BOOT" | "IDLE" | "ARMING" | "SEALED" | "TAMPERED" | "OPEN_AUTHORIZED";

/** Latest known reading for a box (BoxTracker snapshot). */
export interface BoxSnapshot {
  boxId: string;
  lastSeenAt: number; // unix ms, relayer clock
  state: BoxState;
  orderId: number;
  lat_e6: number;
  lon_e6: number;
  fix: 0 | 1;
  lid: 0 | 1; // 1 closed, 0 open
  accel_mg: number;
  tilt_deg: number;
  lock: "L" | "U";
  batt_mv: number;
  seq: number;
  gpsSimEnabled: boolean;
}

export interface PendingCommand {
  cmdId: string;
  type: "SEAL" | "UNLOCK" | "RESET";
  boxId: string;
  orderId: number;
  courierAddress?: string;
}

export interface RelayerBox {
  label: string;
  boxId: string;
  lastSeenAt: number | null;
  state: BoxState | null;
  gps: GpsBadge;
  pendingCommand: PendingCommand | null;
  snapshot: BoxSnapshot | null;
}

export interface RelayerOrder {
  id: number;
  status: number;
  buyer: string;
  seller: string;
  amount: string; // wei, decimal string
  boxId: string;
  boxLabel?: string;
  courier: string;
}

/** One verified device event as stored by the relayer (canonical fields + head). */
export interface DeviceEvent {
  box_id: string;
  seq: number;
  ts: number;
  type: "BOOT" | "TELEMETRY" | "SEALED" | "SEAL_FAILED" | "TAMPER" | "ALERT" | "UNLOCKED" | "RESET_DONE";
  state: BoxState;
  order_id: number;
  lat_e6: number;
  lon_e6: number;
  fix: 0 | 1;
  dist_mm: number;
  lid: 0 | 1;
  accel_mg: number;
  tilt_deg: number;
  lock: "L" | "U";
  batt_mv: number;
  code: number;
  cmd_id: string;
  head: string;
  received_at: number;
}

export interface OrderLog {
  order_id: number;
  box_label?: string;
  events: DeviceEvent[];
  anchored_seq: number;
  computed_head_at_anchored_seq: string | null;
  anchored_head: string | null;
  match: boolean | null; // null = nothing anchored yet
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

async function postJson(path: string, body?: unknown): Promise<{ cmd_id: string; type: string }> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error ?? `${path}: ${res.status}`);
  return data.queued;
}

export const fetchBoxes = async () => (await getJson<{ boxes: RelayerBox[] }>("/api/boxes")).boxes;
export const fetchOrders = async () => (await getJson<{ orders: RelayerOrder[] }>("/api/orders")).orders;
export const fetchOrderLog = (orderId: number) => getJson<OrderLog>(`/api/orders/${orderId}/log`);

export const sealOrder = (orderId: number, boxLabel: string, courier: string) =>
  postJson(`/api/orders/${orderId}/seal`, { box_id: boxLabel, courier });

export const resetBox = (boxLabel: string) => postJson(`/api/boxes/${encodeURIComponent(boxLabel)}/reset`);

export async function setGpsSim(boxLabel: string, enabled: boolean): Promise<void> {
  const res = await fetch("/api/demo/gps-sim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ box_id: boxLabel, enabled }),
  });
  if (!res.ok) throw new Error(`gps-sim: ${res.status}`);
}
