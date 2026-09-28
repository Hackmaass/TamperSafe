// Evidence: for one order, the on-chain record (every state change is a
// contract event with an explorer link), the settlement breakdown, and the
// hash-chain check that ties the off-chain device log to the anchored head.
import { useCallback, useEffect, useState } from "react";
import type { EventLog, Log } from "ethers";
import type { NetworkConfig } from "../config/networks";
import { explorerTxUrl } from "../config/networks";
import type { RelayerState } from "../hooks/useRelayer";
import { fetchOrderLog, type OrderLog } from "../lib/relayerApi";
import { getEscrowContract, getReadProvider, getTelemetryAnchorContract, statusLabel } from "../lib/contracts";
import { formatTMSTC } from "../lib/format";
import { alertName, RELEASE_KINDS, tamperName } from "../lib/codes";
import { Empty, Panel, Pill, shortHex } from "./ui";

interface ChainRow {
  key: string;
  block: number;
  index: number;
  name: string;
  detail: string;
  tx: string;
}

const ESCROW_EVENTS = [
  "OrderCreated",
  "ShipmentSealed",
  "UnlockRequested",
  "Delivered",
  "TamperDetected",
  "OrderCancelled",
  "OrderExpired",
  "FundsReleased",
] as const;

function describe(name: string, a: Record<string, unknown>): string {
  switch (name) {
    case "OrderCreated":
      return `escrowed ${formatTMSTC(a.amount as bigint)}`;
    case "ShipmentSealed":
      return `bond locked ${formatTMSTC(a.bond as bigint)}`;
    case "TamperDetected":
      return tamperName(Number(a.code));
    case "Delivered":
      return `GPS fix ${a.gpsFix ? "yes" : "no"} (evidence only)`;
    case "FundsReleased":
      return `${RELEASE_KINDS[Number(a.kind)] ?? "released"}: ${formatTMSTC(a.amount as bigint)} to ${shortHex(String(a.to))}`;
    case "Alert":
      return alertName(Number(a.code));
    case "Anchored":
      return `log head anchored at seq ${a.seq}`;
    default:
      return "";
  }
}

async function loadChainRows(network: NetworkConfig, id: number): Promise<ChainRow[]> {
  const provider = getReadProvider(network);
  const escrow = getEscrowContract(network, provider);
  const anchor = getTelemetryAnchorContract(network, provider);
  const rows: ChainRow[] = [];
  const push = (logs: (Log | EventLog)[]) => {
    for (const l of logs) {
      const ev = l as EventLog;
      if (!ev.fragment) continue;
      const args = Object.fromEntries(ev.fragment.inputs.map((inp, i) => [inp.name, ev.args[i]]));
      rows.push({
        key: `${l.transactionHash}-${l.index}`,
        block: l.blockNumber,
        index: l.index,
        name: ev.fragment.name,
        detail: describe(ev.fragment.name, args),
        tx: l.transactionHash,
      });
    }
  };
  for (const name of ESCROW_EVENTS) {
    push(await escrow.queryFilter(escrow.filters[name]!(id)));
  }
  push(await anchor.queryFilter(anchor.filters.Alert!(id)));
  push(await anchor.queryFilter(anchor.filters.Anchored!(id)));
  return rows.sort((a, b) => a.block - b.block || a.index - b.index);
}

export function EvidenceTab({ network, relayer }: { network: NetworkConfig; relayer: RelayerState }) {
  const { orders, online } = relayer;
  const [selected, setSelected] = useState<number | null>(null);
  const [rows, setRows] = useState<ChainRow[]>([]);
  const [chainErr, setChainErr] = useState<string | null>(null);
  const [log, setLog] = useState<OrderLog | null>(null);
  const [logErr, setLogErr] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);

  const orderId = selected ?? orders[orders.length - 1]?.id ?? null;
  const order = orders.find((o) => o.id === orderId);

  const loadChain = useCallback(async () => {
    if (orderId == null) return;
    try {
      setRows(await loadChainRows(network, orderId));
      setChainErr(null);
    } catch (err) {
      setChainErr(err instanceof Error ? err.message : String(err));
    }
  }, [network, orderId]);

  // Re-read on order selection and whenever the order's status changes.
  useEffect(() => {
    setLog(null);
    setLogErr(null);
    void loadChain();
  }, [loadChain, order?.status]);

  const verify = useCallback(async () => {
    if (orderId == null) return;
    setVerifying(true);
    setLogErr(null);
    try {
      setLog(await fetchOrderLog(orderId));
    } catch (err) {
      setLogErr(err instanceof Error ? err.message : String(err));
    } finally {
      setVerifying(false);
    }
  }, [orderId]);

  if (orders.length === 0) {
    return <Empty>{online ? "No orders yet." : "Relayer offline."} Evidence appears once an order exists.</Empty>;
  }

  const releases = rows.filter((r) => r.name === "FundsReleased");

  return (
    <div className="stack">
      <div className="seg" style={{ justifySelf: "start", flexWrap: "wrap" }}>
        {orders.map((o) => (
          <button key={o.id} className={o.id === orderId ? "on" : ""} onClick={() => setSelected(o.id)}>
            #{o.id} · {statusLabel(o.status)}
          </button>
        ))}
      </div>

      <Panel title="Device log check" right={<span className="tag-off">off-chain log vs on-chain anchor</span>}>
        <div className="verify">
          <button className="btn" onClick={() => void verify()} disabled={verifying}>
            {verifying ? "Verifying…" : "Verify log"}
          </button>
          {log && (
            <div>
              <div className={`verdict${log.match === false ? " fail" : ""}`}>
                {log.match === true ? "Match" : log.match === false ? "Mismatch" : "Nothing anchored yet"}
              </div>
              {log.anchored_seq > 0 && (
                <div className="hash">
                  seq {log.anchored_seq}
                  <br />
                  recomputed {log.computed_head_at_anchored_seq ?? "not in log"}
                  <br />
                  on-chain&nbsp;&nbsp;&nbsp;{log.anchored_head}
                </div>
              )}
            </div>
          )}
        </div>
        {logErr && <p className="error">{logErr}</p>}
      </Panel>

      <div className="grid-2">
        <Panel title="On-chain timeline" right={<span className="tag-chain">contract events</span>}>
          {chainErr && <p className="error">{chainErr}</p>}
          {rows.length === 0 && !chainErr ? (
            <span className="muted">No events for this order.</span>
          ) : (
            <ul className="timeline">
              {rows.map((r) => {
                const url = explorerTxUrl(network, r.tx);
                return (
                  <li key={r.key}>
                    <div>
                      <div className="name">{r.name}</div>
                      {r.detail && <div className="detail">{r.detail}</div>}
                    </div>
                    {url ? (
                      <a className="hash" href={url} target="_blank" rel="noreferrer">
                        {shortHex(r.tx, 8, 4)}
                      </a>
                    ) : (
                      <span className="hash" title="Local chain: no explorer">
                        {shortHex(r.tx, 8, 4)}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <div className="stack">
          <Panel title="Settlement">
            {releases.length === 0 ? (
              <span className="muted">
                {order ? `Order is ${statusLabel(order.status)}. Funds are released when it settles.` : "—"}
              </span>
            ) : (
              <ul className="timeline">
                {releases.map((r) => (
                  <li key={r.key}>
                    <div className="name">{r.detail}</div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {log && (
            <Panel title="Device events" right={<span className="tag-off">off-chain</span>}>
              {log.events.length === 0 ? (
                <span className="muted">No device events stored for this order's box.</span>
              ) : (
                <ul className="timeline">
                  {log.events
                    .filter((e) => e.type !== "TELEMETRY")
                    .slice(-12)
                    .reverse()
                    .map((e) => (
                      <li key={`${e.seq}-${e.head}`}>
                        <div>
                          <div className="name">
                            {e.type}
                            {e.type === "TAMPER" && ` · ${tamperName(e.code)}`}
                            {e.type === "ALERT" && ` · ${alertName(e.code)}`}
                          </div>
                          <div className="detail">seq {e.seq} · {e.state}</div>
                        </div>
                        <Pill>{shortHex(e.head, 6, 0)}</Pill>
                      </li>
                    ))}
                </ul>
              )}
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}
