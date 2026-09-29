// The demo cast, read from deployments/accounts.json (addresses only, never keys),
// so the forms are pre-filled and nobody types an address on stage.
import accounts from "../../../deployments/accounts.json";

export const DEMO = {
  buyer: accounts.buyer,
  courier: accounts.courier,
  seller: accounts.seller,
  oracle: accounts.oracleRelayer,
  // Where the box is "delivered": central Bangalore, shown in the Buyer form.
  destLat: "12.9716",
  destLon: "77.5946",
  amount: "0.01",
  bond: "0.03", // covers two 0.01 orders (the bond must equal the order amount)
} as const;

/** Which demo role an address plays, for the header label. */
export function roleOf(address: string | null): "Buyer" | "Courier" | "Buyer + Courier" | "Seller" | "Relayer" | null {
  if (!address) return null;
  const a = address.toLowerCase();
  const isBuyer = a === DEMO.buyer.toLowerCase();
  const isCourier = a === DEMO.courier.toLowerCase();
  if (isBuyer && isCourier) return "Buyer + Courier"; // the demo uses one wallet for both
  if (isBuyer) return "Buyer";
  if (isCourier) return "Courier";
  if (a === DEMO.seller.toLowerCase()) return "Seller";
  if (a === DEMO.oracle.toLowerCase()) return "Relayer";
  return null;
}

/** A deadline three hours out, formatted for <input type="datetime-local">. */
export function defaultDeadline(): string {
  const d = new Date(Date.now() + 3 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
