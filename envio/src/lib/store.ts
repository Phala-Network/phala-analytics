import type { EvmOnEventContext } from "envio";
import type { Store } from "./state";

/** Load the two singletons once per handler call into mutable copies. */
export async function loadStore(context: EvmOnEventContext): Promise<Store> {
  const [chain, vault] = await Promise.all([
    context.ChainState.get("current"),
    context.VaultState.get("current"),
  ]);
  return {
    chain: chain ? { ...chain } : undefined,
    vault: vault ? { ...vault } : undefined,
    sink: {
      ChainDay: (e) => context.ChainDay.set(e),
      VaultDay: (e) => context.VaultDay.set(e),
      ClaimDay: (e) => context.ClaimDay.set(e),
      Latest: (e) => context.Latest.set(e),
    },
  };
}

/** Write the singletons back (graph-node's save()). */
export function saveStore(context: EvmOnEventContext, store: Store): void {
  if (store.chain) context.ChainState.set({ ...store.chain });
  if (store.vault) context.VaultState.set({ ...store.vault });
}
