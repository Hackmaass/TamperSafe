import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserProvider, type JsonRpcSigner } from "ethers";
import type { NetworkConfig } from "../config/networks";
import { discoverWallets, pickWallet, type InjectedProvider } from "../lib/wallets";

export interface WalletState {
  account: string | null;
  /** The chain id the wallet itself is currently on, NOT the dashboard's
   * selected network. The two can disagree (e.g. dropdown on "mst" while the
   * wallet is still on another chain); callers must check before sending. */
  chainId: number | null;
  /** Name of the wallet in use (BridgeKey when installed), null if none found. */
  walletName: string | null;
  connecting: boolean;
  error: string | null;
}

const NO_WALLET = "No wallet found. Install BridgeKey (bridgekey.io), the official MST wallet.";

/**
 * Wraps an injected EIP-1193 wallet, preferring BridgeKey (see lib/wallets.ts).
 * Keys never leave the wallet: this hook only asks it to connect, switch
 * network and sign.
 */
export function useWallet() {
  const [state, setState] = useState<WalletState>({
    account: null,
    chainId: null,
    walletName: null,
    connecting: false,
    error: null,
  });
  const [provider, setProvider] = useState<InjectedProvider | null>(null);
  const providerRef = useRef<InjectedProvider | null>(null);
  providerRef.current = provider;

  // Announcements can arrive after first render, so discover on mount.
  useEffect(() => {
    let cancelled = false;
    void discoverWallets().then((wallets) => {
      const picked = pickWallet(wallets);
      if (cancelled || !picked) return;
      setProvider(picked.provider);
      setState((s) => ({ ...s, walletName: picked.name }));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const requireProvider = useCallback(async (): Promise<InjectedProvider> => {
    if (providerRef.current) return providerRef.current;
    const picked = pickWallet(await discoverWallets());
    if (!picked) throw new Error(NO_WALLET);
    setProvider(picked.provider);
    setState((s) => ({ ...s, walletName: picked.name }));
    return picked.provider;
  }, []);

  const getBrowserProvider = useCallback(async () => new BrowserProvider(await requireProvider()), [requireProvider]);

  const refresh = useCallback(async () => {
    const p = providerRef.current;
    if (!p) return;
    try {
      const bp = new BrowserProvider(p);
      const accounts = (await bp.send("eth_accounts", [])) as string[];
      const network = await bp.getNetwork();
      setState((s) => ({ ...s, account: accounts[0] ?? null, chainId: Number(network.chainId) }));
    } catch {
      // Wallet may be locked or mid-transition; leave prior state as-is.
    }
  }, []);

  useEffect(() => {
    if (!provider) return;
    void refresh();
    if (!provider.on) return;
    const onChange = () => void refresh();
    provider.on("accountsChanged", onChange);
    provider.on("chainChanged", onChange);
    return () => {
      provider.removeListener?.("accountsChanged", onChange);
      provider.removeListener?.("chainChanged", onChange);
    };
  }, [provider, refresh]);

  const connect = useCallback(async () => {
    setState((s) => ({ ...s, connecting: true, error: null }));
    try {
      const bp = await getBrowserProvider();
      await bp.send("eth_requestAccounts", []);
      await refresh();
    } catch (err) {
      setState((s) => ({ ...s, error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setState((s) => ({ ...s, connecting: false }));
    }
  }, [getBrowserProvider, refresh]);

  const getSigner = useCallback(async (): Promise<JsonRpcSigner> => (await getBrowserProvider()).getSigner(), [getBrowserProvider]);

  /** wallet_switchEthereumChain, falling back to wallet_addEthereumChain on
   * error code 4902 ("Unrecognized chain ID"). Used for the explicit
   * "Add MST Testnet" button and silently before any write tx. */
  const switchOrAddNetwork = useCallback(
    async (network: NetworkConfig) => {
      const eth = await requireProvider();
      try {
        await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: network.chainIdHex }] });
      } catch (err) {
        const code = (err as { code?: number } | null)?.code;
        if (code !== 4902) throw err;
        await eth.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: network.chainIdHex,
              chainName: network.label,
              rpcUrls: [network.rpcUrl],
              nativeCurrency: network.nativeCurrency,
              blockExplorerUrls: network.explorerUrl ? [network.explorerUrl] : undefined,
            },
          ],
        });
      }
      await refresh();
    },
    [refresh, requireProvider],
  );

  return { ...state, connect, getSigner, switchOrAddNetwork, getBrowserProvider };
}
