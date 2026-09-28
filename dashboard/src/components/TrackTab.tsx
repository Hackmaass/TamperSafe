// Track: what the box is doing right now. Everything on this tab is
// off-chain telemetry except the "On-chain" list, which is the relayer's
// confirmed transactions (each with an explorer link on MST).
import { useEffect, useMemo, useState } from "react";
import type { RelayerState } from "../hooks/useRelayer";
import { fetchOrderLog, type RelayerBox } from "../lib/relayerApi";
import { tamperName } from "../lib/codes";
import { Empty, Panel, Pill, ago, shortHex } from "./ui";
import { TrackMap } from "./TrackMap";

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function TrackTab({ relayer }: { relayer: RelayerState }) {
  const { boxes, trails, tamper, feed, txs, online, connecting } = relayer;
  const [selected, setSelected] = useState<string | null>(null);
  const now = useNow();

  const box: RelayerBox | undefined = useMemo(
    () => boxes.find((b) => b.label === selected) ?? boxes.find((b) => b.snapshot) ?? boxes[0],
    [boxes, selected],
  );

  // The tamper code arrives on the live stream, but a page opened after the
  // fact missed it: recover it from the relayer's stored log for the order.
  const orderId = box?.snapshot?.orderId ?? 0;
  const tamperedNow = box?.snapshot?.state === "TAMPERED";
  const haveLive = box ? tamper[box.label] !== undefined : false;
  const [recovered, setRecovered] = useState<{ orderId: number; code: number } | null>(null);
  useEffect(() => {
    if (!tamperedNow || haveLive || orderId === 0 || recovered?.orderId === orderId) return;
    let cancelled = false;
    fetchOrderLog(orderId)
      .then((log) => {
        const t = [...log.events].reverse().find((e) => e.type === "TAMPER");
        if (!cancelled && t) setRecovered({ orderId, code: t.code });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [tamperedNow, haveLive, orderId, recovered?.orderId]);

  if (connecting) return <Empty>Connecting to the relayer…</Empty>;
  if (!online && boxes.length === 0) {
    return <Empty>Relayer offline. Start it (npm start in relayer/) and this page fills in on its own.</Empty>;
  }
  if (!box) return <Empty>No boxes registered in this deployment.</Empty>;

  const snap = box.snapshot;
  const state = snap?.state ?? "OFFLINE";
  const tampered = state === "TAMPERED";
  const info = tamper[box.label] ?? (recovered && recovered.orderId === orderId ? recovered : undefined);
  const tamperLabel = info ? tamperName(info.code) : null;

  const trail = (trails[box.label] ?? [])
    .filter((e) => e.lat_e6 !== 0 || e.lon_e6 !== 0)
    .map((e) => ({ lat: e.lat_e6 / 1e6, lon: e.lon_e6 / 1e6 }));
  if (trail.length === 0 && snap && (snap.lat_e6 !== 0 || snap.lon_e6 !== 0)) {
    trail.push({ lat: snap.lat_e6 / 1e6, lon: snap.lon_e6 / 1e6 });
  }

  const boxFeed = feed.filter((f) => f.boxId === box.label);
  const boxTxs = txs.filter((t) => t.stage !== "submitted").slice(0, 8);

  return (
    <div className="stack">
      {boxes.length > 1 && (
        <div className="seg" style={{ justifySelf: "start" }}>
          {boxes.map((b) => (
            <button key={b.label} className={b.label === box.label ? "on" : ""} onClick={() => setSelected(b.label)}>
              {b.label}
            </button>
          ))}
        </div>
      )}

      <Panel className={`hero${tampered ? " tampered" : ""}`}>
        <span className="label">
          {box.label}
          {snap && snap.orderId > 0 ? ` · order #${snap.orderId}` : ""}
        </span>
        <div className="hero-word">{tampered && tamperLabel ? tamperLabel.replace(/_/g, " ") : state.replace(/_/g, " ")}</div>
        <div className="hero-sub">
          {tampered && <Pill tone="solid">Tamper latched</Pill>}
          {!tampered && state === "SEALED" && <span>Sealed and in transit</span>}
          <span className="mono">{snap ? `last seen ${ago(snap.lastSeenAt, now)}` : "no telemetry yet"}</span>
        </div>
      </Panel>

      <div className="grid-4">
        <Tile label="Lid" value={snap ? (snap.lid === 1 ? "Closed" : "Open") : "—"} bad={state === "SEALED" && snap?.lid === 0} />
        <Tile label="Latch" value={snap ? (snap.lock === "L" ? "Locked" : "Unlocked") : "—"} />
        <Tile
          label="Motion"
          value={snap ? `${(snap.accel_mg / 1000).toFixed(2)} g` : "—"}
          sub={snap ? `tilt ${snap.tilt_deg}°` : undefined}
        />
        <Tile label="Battery" value={snap && snap.batt_mv > 0 ? `${(snap.batt_mv / 1000).toFixed(1)} V` : "—"} />
      </div>

      <div className="grid-2">
        <Panel title="Location">
          <TrackMap trail={trail} badge={box.gps} />
        </Panel>

        <div className="stack">
          <Panel title="Alerts" right={<span className="tag-off">off-chain evidence</span>}>
            {boxFeed.length === 0 ? (
              <span className="muted">Nothing yet. Alerts never move funds; only tamper does.</span>
            ) : (
              <ul className="feed">
                {boxFeed.slice(0, 8).map((f) => (
                  <li key={f.id}>
                    <span className="t">{new Date(f.at).toLocaleTimeString()}</span>
                    <span>
                      <span className={`name${f.kind === "tamper" ? " tamper" : ""}`}>{f.title}</span>
                      {f.detail && <div className="detail">{f.detail}</div>}
                    </span>
                    {f.onChain && <span className="tag-chain">on-chain</span>}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="On-chain" right={<span className="tag-chain">tx</span>}>
            {boxTxs.length === 0 ? (
              <span className="muted">No relayer transactions yet.</span>
            ) : (
              <ul className="tx-list">
                {boxTxs.map((t) => (
                  <li key={t.id} className={`tx-entry tx-${t.stage}`}>
                    <span className="tx-label">{t.label}</span>
                    <span className="tx-status">{t.stage}</span>
                    {t.hash &&
                      (t.explorerUrl ? (
                        <a className="tx-hash" href={t.explorerUrl} target="_blank" rel="noreferrer">
                          {shortHex(t.hash, 10, 0)}
                        </a>
                      ) : (
                        <span className="tx-hash" title="Local chain: no explorer">
                          {shortHex(t.hash, 10, 0)}
                        </span>
                      ))}
                    {t.error && <span className="tx-error">{t.error.slice(0, 90)}</span>}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function Tile({ label, value, sub, bad }: { label: string; value: string; sub?: string; bad?: boolean }) {
  return (
    <Panel className={`tile${bad ? " bad" : ""}`}>
      <span className="label">{label}</span>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </Panel>
  );
}
