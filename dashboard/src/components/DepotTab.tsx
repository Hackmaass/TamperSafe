// Depot: seal a funded order into a box, and reset a box. These go through
// the relayer's REST API (the relayer holds the oracle role), never through
// the wallet.
import { useState } from "react";
import { isAddress } from "ethers";
import type { RelayerState } from "../hooks/useRelayer";
import { resetBox, sealOrder, setGpsSim } from "../lib/relayerApi";
import { formatTMSTC } from "../lib/format";
import { Empty, Panel, Pill, ago, shortHex } from "./ui";

export function DepotTab({ relayer, account }: { relayer: RelayerState; account: string | null }) {
  const { boxes, orders, online, refresh } = relayer;
  const [courier, setCourier] = useState("");
  const [pickBox, setPickBox] = useState<Record<number, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  if (!online && boxes.length === 0) {
    return <Empty>Relayer offline. Start it (npm start in relayer/) to seal orders and reset boxes.</Empty>;
  }

  const funded = orders.filter((o) => o.status === 1);
  const courierAddr = courier || account || "";
  const freeBoxes = boxes.filter((b) => !b.pendingCommand && (b.state === "IDLE" || b.state === null));

  async function run(label: string, fn: () => Promise<{ cmd_id: string; type: string } | void>) {
    setBusy(true);
    setMsg(null);
    try {
      const q = await fn();
      setMsg({ ok: true, text: q ? `${label}: queued ${q.type} (${q.cmd_id}). The box picks it up on its next report.` : `${label}: done` });
      await refresh();
    } catch (err) {
      setMsg({ ok: false, text: `${label}: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <Panel title="Funded orders, ready to seal">
        {funded.length === 0 ? (
          <span className="muted">No funded orders. A buyer creates one on the Buyer tab.</span>
        ) : (
          <>
            <label className="field" style={{ maxWidth: 460, marginBottom: "1em" }}>
              <span>Courier address (bond is locked from this account)</span>
              <input value={courier} onChange={(e) => setCourier(e.target.value)} placeholder={account ?? "0x…"} />
            </label>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Amount</th>
                    <th>Seller</th>
                    <th>Box</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {funded.map((o) => {
                    const chosen = pickBox[o.id] ?? freeBoxes[0]?.label ?? "";
                    return (
                      <tr key={o.id}>
                        <td className="mono">#{o.id}</td>
                        <td>{formatTMSTC(BigInt(o.amount))}</td>
                        <td className="mono">{shortHex(o.seller)}</td>
                        <td>
                          <select value={chosen} onChange={(e) => setPickBox({ ...pickBox, [o.id]: e.target.value })} style={{ minWidth: 140 }}>
                            {freeBoxes.length === 0 && <option value="">no free box</option>}
                            {freeBoxes.map((b) => (
                              <option key={b.label} value={b.label}>
                                {b.label}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <button
                            className="btn small"
                            disabled={busy || !chosen || !isAddress(courierAddr)}
                            onClick={() => void run(`Seal #${o.id}`, () => sealOrder(o.id, chosen, courierAddr))}
                          >
                            Seal
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!isAddress(courierAddr) && <p className="error">Enter a courier address (or connect a wallet) to seal.</p>}
          </>
        )}
      </Panel>

      <Panel title="Boxes">
        {boxes.length === 0 ? (
          <span className="muted">No boxes in this deployment.</span>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Box</th>
                  <th>State</th>
                  <th>Last seen</th>
                  <th>GPS</th>
                  <th>Pending</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {boxes.map((b) => (
                  <tr key={b.label}>
                    <td className="mono">{b.label}</td>
                    <td>
                      <Pill tone={b.state === "TAMPERED" ? "red" : b.state === "SEALED" ? "white" : undefined}>{b.state ?? "offline"}</Pill>
                    </td>
                    <td className="mono muted">{ago(b.lastSeenAt)}</td>
                    <td>
                      <Pill tone={b.gps === "SIMULATED" ? "red" : undefined}>{b.gps.replace("_", " ")}</Pill>
                    </td>
                    <td className="mono muted">{b.pendingCommand ? `${b.pendingCommand.type} ${b.pendingCommand.orderId ? `#${b.pendingCommand.orderId}` : ""}` : "—"}</td>
                    <td className="actions">
                      <button className="btn ghost small" disabled={busy} onClick={() => void run(`Reset ${b.label}`, () => resetBox(b.label))}>
                        Reset
                      </button>
                      <button
                        className="btn ghost small"
                        disabled={busy}
                        title="Display only: labels the map SIMULATED. Never changes what goes on-chain."
                        onClick={() => void run(`GPS sim ${b.label}`, () => setGpsSim(b.label, b.gps !== "SIMULATED"))}
                      >
                        {b.gps === "SIMULATED" ? "Stop GPS sim" : "GPS sim"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {msg && <p className={msg.ok ? "ok-text" : "error"}>{msg.text}</p>}
      </Panel>
    </div>
  );
}
