// Live view of the relayer: REST polling every 3 s (state of record) plus the
// SSE stream (telemetry / alert / tx / order) for instant updates. Nothing is
// simulated client-side -- if the relayer is down, `online` is false and the
// screens say so.
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchBoxes, fetchOrders, type DeviceEvent, type RelayerBox, type RelayerOrder } from "../lib/relayerApi";
import { alertName, tamperName } from "../lib/codes";

export interface FeedItem {
  id: string;
  at: number; // unix ms
  kind: "tamper" | "alert";
  boxId: string;
  orderId?: number;
  title: string;
  detail?: string;
  onChain?: boolean;
}

export interface TxItem {
  id: string;
  at: number;
  stage: "submitted" | "confirmed" | "failed";
  label: string;
  hash?: string;
  explorerUrl?: string | null;
  error?: string;
}

export interface TamperInfo {
  code: number;
  orderId: number;
}

const MAX_TRAIL = 300;
const MAX_FEED = 40;
const POLL_MS = 3000;

export function useRelayer() {
  const [boxes, setBoxes] = useState<RelayerBox[]>([]);
  const [orders, setOrders] = useState<RelayerOrder[]>([]);
  const [pollOk, setPollOk] = useState<boolean | null>(null); // null until the first poll answers
  const [sseOpen, setSseOpen] = useState(false);
  const [trails, setTrails] = useState<Record<string, DeviceEvent[]>>({});
  const [tamper, setTamper] = useState<Record<string, TamperInfo>>({});
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [txs, setTxs] = useState<TxItem[]>([]);
  const counter = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const [b, o] = await Promise.all([fetchBoxes(), fetchOrders()]);
      setBoxes(b);
      setOrders(o);
      setPollOk(true);
    } catch {
      setPollOk(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    const es = new EventSource("/api/stream");
    const nextId = () => `f${++counter.current}`;
    const parse = (e: Event) => JSON.parse((e as MessageEvent).data as string);

    es.onopen = () => setSseOpen(true);
    es.onerror = () => setSseOpen(false); // EventSource retries on its own

    es.addEventListener("telemetry", (e) => {
      const ev = parse(e) as DeviceEvent;
      setTrails((prev) => ({ ...prev, [ev.box_id]: [...(prev[ev.box_id] ?? []), ev].slice(-MAX_TRAIL) }));
      if (ev.type === "TAMPER") {
        setTamper((prev) => ({ ...prev, [ev.box_id]: { code: ev.code, orderId: ev.order_id } }));
        setFeed((prev) =>
          [
            {
              id: nextId(),
              at: Date.now(),
              kind: "tamper" as const,
              boxId: ev.box_id,
              orderId: ev.order_id,
              title: tamperName(ev.code),
              detail: "box latched TAMPERED",
            },
            ...prev,
          ].slice(0, MAX_FEED),
        );
      }
      if (ev.type === "RESET_DONE") {
        setTamper((prev) => {
          const next = { ...prev };
          delete next[ev.box_id];
          return next;
        });
      }
      void refresh();
    });

    es.addEventListener("alert", (e) => {
      const a = parse(e) as {
        boxId: string;
        orderId?: number;
        code?: number;
        type: string;
        message?: string;
        onChain?: boolean;
      };
      const title = a.type === "ALERT" && a.code != null ? alertName(a.code) : a.type;
      setFeed((prev) =>
        [
          {
            id: nextId(),
            at: Date.now(),
            kind: "alert" as const,
            boxId: a.boxId,
            orderId: a.orderId,
            title,
            detail: a.message,
            onChain: a.onChain,
          },
          ...prev,
        ].slice(0, MAX_FEED),
      );
    });

    es.addEventListener("tx", (e) => {
      const t = parse(e) as {
        stage: TxItem["stage"];
        label?: string;
        fn?: string;
        hash?: string;
        explorerUrl?: string | null;
        error?: string;
      };
      setTxs((prev) =>
        [
          {
            id: nextId(),
            at: Date.now(),
            stage: t.stage,
            label: t.label ?? t.fn ?? "transaction",
            hash: t.hash,
            explorerUrl: t.explorerUrl,
            error: t.error,
          },
          ...prev,
        ].slice(0, MAX_FEED),
      );
    });

    es.addEventListener("order", () => void refresh());

    return () => es.close();
  }, [refresh]);

  return { boxes, orders, connecting: pollOk === null && !sseOpen, online: pollOk === true || sseOpen, trails, tamper, feed, txs, refresh };
}

export type RelayerState = ReturnType<typeof useRelayer>;
