// OpenStreetMap (no API key) with the box's GPS trail. Leaflet is driven
// directly, not through react-leaflet. The GPS badge is always drawn on the
// map (invariant 4: GPS is evidence, and simulated GPS is always labelled).
import { useEffect, useRef } from "react";
import L from "leaflet";
import type { GpsBadge } from "../lib/relayerApi";
import { Pill } from "./ui";

export interface TrailPoint {
  lat: number;
  lon: number;
}

const DEFAULT_CENTER: L.LatLngTuple = [12.9716, 77.5946]; // Bangalore, used only when there is nothing to plot

export function TrackMap({ trail, badge }: { trail: TrailPoint[]; badge: GpsBadge }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const line = useRef<L.Polyline | null>(null);
  const dot = useRef<L.CircleMarker | null>(null);

  useEffect(() => {
    if (!el.current || map.current) return;
    const m = L.map(el.current, { zoomControl: true, attributionControl: true }).setView(DEFAULT_CENTER, 13);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(m);
    line.current = L.polyline([], { color: "#eb0c0d", weight: 3 }).addTo(m);
    dot.current = L.circleMarker(DEFAULT_CENTER, { radius: 7, color: "#fff", weight: 2, fillColor: "#eb0c0d", fillOpacity: 1 });
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m || !line.current || !dot.current) return;
    const pts = trail.map((p) => [p.lat, p.lon] as L.LatLngTuple);
    line.current.setLatLngs(pts);
    if (pts.length > 0) {
      const last = pts[pts.length - 1]!;
      dot.current.setLatLng(last).addTo(m);
      m.setView(last, Math.max(m.getZoom(), 15), { animate: false });
    } else {
      dot.current.remove();
    }
  }, [trail]);

  return (
    <div className="map-wrap">
      <div className="map-badge">
        <Pill tone={badge === "LIVE" ? "white" : badge === "SIMULATED" ? "red" : undefined}>
          GPS {badge === "NO_FIX" ? "no fix" : badge.toLowerCase()}
        </Pill>
      </div>
      <div ref={el} className="map" />
      {badge === "SIMULATED" && trail.length > 0 && (
        <div className="map-note">SIMULATED route for the demo. Display only: nothing on-chain uses it.</div>
      )}
      {trail.length === 0 && (
        <div className="map-note">
          {badge === "NO_FIX" ? "The box has no GPS. Use Simulate GPS to show a demo route. Escrow never depends on GPS." : "Waiting for a position."}
        </div>
      )}
    </div>
  );
}
