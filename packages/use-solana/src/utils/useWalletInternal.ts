import type { Network } from "@saberhq/solana-contrib";
import type { PublicKey } from "@solana/web3.js";
import stringify from "fast-json-stable-stringify";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { ConnectedWallet, WalletAdapter } from "../adapters/types";
import { WrappedWalletAdapter } from "../adapters/types";
import type { UseSolanaError } from "../error";
import {
  WalletActivateError,
  WalletAutomaticConnectionError,
  WalletDisconnectError,
} from "../error";
import type {
  WalletProviderInfo,
  WalletProviderMap,
  WalletTypeEnum,
} from "../providers";
import type { StorageAdapter } from "../storage";
import { usePersistedKVStore } from "./usePersistedKVStore";

/**
 * Wallet-related information.
 */
export interface UseWallet<
  WalletType extends WalletTypeEnum<WalletType>,
  Connected extends boolean = boolean
> {
  /**
   * Wallet.
   */
  wallet?: WalletAdapter<Connected>;
  /**
   * Wallet public key.
   */
  publicKey: Connected extends true ? PublicKey : undefined;
  /**
   * Information about the wallet used.
   */
  walletProviderInfo?: WalletProviderInfo;
  /**
   * Whether or not the wallet is connected.
   */
  connected: Connected;
  /**
   * Activates a new wallet.
   */
  activate: (
    walletType: WalletType[keyof WalletType],
    walletArgs?: Record<string, unknown>
  ) => Promise<void>;
  /**
   * Disconnects the wallet and prevents auto-reconnect.
   */
  disconnect: () => Promise<void>;
}

export interface UseWalletArgs<WalletType extends WalletTypeEnum<WalletType>> {
  onConnect: (
    wallet: WalletAdapter<true>,
    provider: WalletProviderInfo
  ) => void;
  onDisconnect: (
    wallet: WalletAdapter<false>,
    provider: WalletProviderInfo
  ) => void;
  onError: (err: UseSolanaError) => void;
  network: Network;
  endpoint: string;
  storageAdapter: StorageAdapter;
  walletProviders: WalletProviderMap<WalletType>;
}

interface WalletConfig<WalletType extends WalletTypeEnum<WalletType>> {
  walletType: keyof WalletType;
  walletArgs: Record<string, unknown> | null;
}

export const useWalletInternal = <
  WalletType extends WalletTypeEnum<WalletType>
>({
  onConnect,
  onDisconnect,
  network,
  endpoint,
  onError,
  storageAdapter,
  walletProviders,
}: UseWalletArgs<WalletType>): UseWallet<WalletType, boolean> => {
  const [walletConfigStr, setWalletConfigStr] = usePersistedKVStore<
    string | null
  >("use-solana/wallet-config", null, storageAdapter);

  const walletConfig: WalletConfig<WalletType> | null = useMemo(() => {
    try {
      return walletConfigStr
        ? (JSON.parse(walletConfigStr) as WalletConfig<WalletType>)
        : null;
    } catch (e) {
      console.warn("Error parsing wallet config", e);
      return null;
    }
  }, [walletConfigStr]);
  const { walletType, walletArgs } = walletConfig ?? {
    walletType: null,
    walletArgs: null,
  };

  const [connected, setConnected] = useState(false);

  const [walletProviderInfo, wallet]:
    | readonly [WalletProviderInfo, WalletAdapter]
    | readonly [undefined, undefined] = useMemo(() => {
    if (walletType) {
      const provider = walletProviders[walletType];
      console.debug("New wallet", provider.url, network);
      const adapter = provider.makeAdapter(provider.url, endpoint);
      return [provider, new WrappedWalletAdapter(adapter)];
    }
    return [undefined, undefined];
  }, [walletProviders, walletType, network, endpoint]);

  useEffect(() => {
    let disabled = false;
    let timeout: NodeJS.Timeout | null = null;

    if (wallet && walletProviderInfo) {
      timeout = setTimeout(() => {
        void wallet.connect(walletArgs).catch((e) => {
          onError(new WalletAutomaticConnectionError(e, walletProviderInfo));
        });
      }, 1_000);
      wallet.on("connect", () => {
        if (disabled) {
          return;
        }
        if (wallet.publicKey) {
          setConnected(true);
          onConnect(wallet as ConnectedWallet, walletProviderInfo);
        }
      });

      wallet.on("disconnect", () => {
        if (disabled) {
          return;
        }
        setConnected(false);
        onDisconnect(wallet as WalletAdapter<false>, walletProviderInfo);
      });
    }

    return () => {
      if (wallet && wallet.connected) {
        const disconnect = wallet.disconnect();
        if (disconnect) {
          disconnect.catch((e) => {
            onError(new WalletDisconnectError(e, walletProviderInfo));
          });
        }
      }
      if (timeout) {
        clearTimeout(timeout);
      }
      disabled = true;
    };
  }, [
    onConnect,
    onDisconnect,
    onError,
    wallet,
    walletArgs,
    walletProviderInfo,
  ]);

  const activate = useCallback(
    async (
      nextWalletType: WalletType[keyof WalletType],
      nextWalletArgs?: Record<string, unknown>
    ): Promise<void> => {
      const nextWalletConfigStr = stringify({
        walletType: nextWalletType,
        walletArgs: nextWalletArgs ?? null,
      });
      if (walletConfigStr === nextWalletConfigStr) {
        // reconnect
        try {
          await wallet?.connect(nextWalletArgs);
        } catch (e) {
          onError(
            new WalletActivateError<WalletType>(
              e,
              nextWalletType,
              nextWalletArgs
            )
          );
        }
      }
      await setWalletConfigStr(nextWalletConfigStr);
    },
    [onError, setWalletConfigStr, wallet, walletConfigStr]
  );

  const disconnect = useCallback(async () => {
    await wallet?.disconnect();
    await setWalletConfigStr(null);
  }, [setWalletConfigStr, wallet]);

  return {
    wallet,
    walletProviderInfo,
    connected,
    publicKey: wallet?.publicKey ?? undefined,
    activate,
    disconnect,
  };
};
