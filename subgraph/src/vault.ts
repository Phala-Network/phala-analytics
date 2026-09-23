import { BigInt, ethereum } from "@graphprotocol/graph-ts";
import { Claimed, Deposit, Withdraw } from "../generated/Vault/Vault";
import { VaultState, VaultStateCheckpoint } from "../generated/schema";

const STATE_ID = "current";

function apply(event: ethereum.Event, delta: BigInt): void {
  let state = VaultState.load(STATE_ID);
  if (state == null) {
    state = new VaultState(STATE_ID);
    state.vaultUnstakeLocked = BigInt.zero();
  }
  state.vaultUnstakeLocked = state.vaultUnstakeLocked.plus(delta);
  state.updatedAtBlock = event.block.number;
  state.updatedAtTimestamp = event.block.timestamp;
  state.save();

  const checkpoint = new VaultStateCheckpoint(
    event.transaction.hash.concatI32(event.logIndex.toI32()),
  );
  checkpoint.vaultUnstakeLocked = state.vaultUnstakeLocked;
  checkpoint.delta = delta;
  checkpoint.blockNumber = event.block.number;
  checkpoint.blockTimestamp = event.block.timestamp;
  checkpoint.transactionHash = event.transaction.hash;
  checkpoint.logIndex = event.logIndex;
  checkpoint.save();
}

// Unstake request: assets leave the share supply and stay locked in the Vault
// until claimed.
export function handleWithdraw(event: Withdraw): void {
  apply(event, event.params.assets);
}

// Unlocked assets paid out to the receiver.
export function handleClaimed(event: Claimed): void {
  apply(event, event.params.assets.neg());
}

// A Deposit sent by the Vault itself moves locked assets back into shares.
// Ordinary user deposits do not affect the locked amount.
export function handleDeposit(event: Deposit): void {
  if (!event.params.sender.equals(event.address)) {
    return;
  }
  apply(event, event.params.assets.neg());
}
