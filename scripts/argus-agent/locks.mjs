import { readFileSync } from "node:fs";
import { encodeFunctionData, getAddress, zeroAddress } from "viem";
import { timeLockAbi, MAX_LOCK_SECONDS } from "./generated/time-lock.mjs";
import { lockVaultAbi, approvalFor } from "./generated/v5-lock.mjs";
import { erc20Abi } from "./generated/abis.mjs";
import { findLaunch } from "./lines.mjs";

const bundle = JSON.parse(readFileSync(new URL("./vendor/argus-v4.json", import.meta.url), "utf8"));
const portal = getAddress(bundle.launchPortal);
const portalAbi = bundle.portal8.contracts.ArgusV5Portal.abi;
const publishedVault = getAddress(bundle.portal8.addresses.lockVault);
const UINT256_MAX = (1n << 256n) - 1n;

// Current sweep-enabled deployment, independently recorded in the indexer handoff.
// Callers must still supply it explicitly; there is no environment/default selection.
export const CURRENT_TIME_LOCK = getAddress("0xFEe1d11d4501D66D8eA1024dc198ee5663c2bf6B");
export const MIN_LOCK_LEAD_SECONDS = 300;

function fail(message, code = "INVALID_INPUT") {
  throw Object.assign(new Error(message), { code, safe: true });
}
function address(value, label) {
  let result;
  try { result = getAddress(value); } catch { fail(`${label} must be an address.`); }
  if (result === zeroAddress) fail(`${label} must not be the zero address.`);
  return result;
}
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
function uint(value, label, positive = false) {
  if (!(typeof value === "bigint" || (typeof value === "string" && /^\d+$/.test(value)))) {
    fail(`${label} must be an exact raw integer string or bigint.`);
  }
  const raw = BigInt(value);
  if (raw < (positive ? 1n : 0n) || raw > UINT256_MAX) fail(`${label} is outside the supported uint256 range.`);
  return raw;
}
function immutable(value) {
  const result = JSON.parse(JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item));
  function freeze(item) {
    if (item && typeof item === "object") { Object.values(item).forEach(freeze); Object.freeze(item); }
    return item;
  }
  return freeze(result);
}
const call = (to, abi, functionName, args, label) => ({
  to, data: encodeFunctionData({ abi, functionName, args }), value: "0", label, abi,
});

/** Unsigned plans only. Inventory must come from the caller's verified action journal. */
export function createLockAdapter(client, { timeLock, lockVault } = {}) {
  const timed = address(timeLock, "Time-lock deployment");
  const permanent = address(lockVault, "Permanent-lock deployment");
  if (!same(timed, CURRENT_TIME_LOCK)) fail("Only the verified current time-lock deployment is supported.", "CONTRACT_MISMATCH");
  if (!same(permanent, publishedVault)) fail("The permanent-lock deployment differs from the published Portal8 bundle.", "CONTRACT_MISMATCH");

  async function snapshot(deployment) {
    if (await client.getChainId() !== 5042) fail("Arc mainnet (5042) is required.", "CHAIN_MISMATCH");
    const block = await client.getBlock();
    if (typeof block.number !== "bigint" || typeof block.timestamp !== "bigint") fail("A mined block snapshot is required.", "INVALID_SNAPSHOT");
    const code = await client.getCode({ address: deployment, blockNumber: block.number });
    if (!code || code === "0x") fail("The configured lock deployment has no contract code.", "CONTRACT_MISMATCH");
    const read = (to, abi, functionName, args = []) => client.readContract({ address: to, abi, functionName, args, blockNumber: block.number });
    return { block, read };
  }

  function deposit(input) {
    const token = address(input.token, "Token");
    const actor = address(input.actor, "Actor");
    const amountRaw = uint(input.amountRaw, "amountRaw", true);
    const inventoryRaw = uint(input.inventoryRaw, "Verified inventory");
    if (amountRaw > inventoryRaw) fail("The lock amount exceeds verified journal inventory.", "INSUFFICIENT_INVENTORY");
    return { token, actor, amountRaw, inventoryRaw };
  }

  async function approvals(input, deployment, read) {
    // The vaults take any ERC-20. Membership is the rule, as on the site: one of our Portals launched it.
    const [launch, balance, allowance] = await Promise.all([
      findLaunch(read, input.token),
      read(input.token, erc20Abi, "balanceOf", [input.actor]),
      read(input.token, erc20Abi, "allowance", [input.actor, deployment]),
    ]);
    if (!launch) fail("Only tokens launched by an Argus Portal can be locked by this agent.", "UNSUPPORTED");
    if (balance < input.amountRaw) fail("The actor does not hold the requested token amount.", "INSUFFICIENT_BALANCE");
    const steps = [];
    if (approvalFor(allowance, input.amountRaw) !== null) {
      if (allowance > 0n) steps.push(call(input.token, erc20Abi, "approve", [deployment, 0n], "Reset the lock token approval"));
      steps.push(call(input.token, erc20Abi, "approve", [deployment, input.amountRaw], "Approve the exact lock token amount"));
    }
    return steps;
  }

  function plan(kind, steps, expected, block, note) {
    return immutable({ steps, expected: { chainId: 5042, ...expected },
      summary: { kind, ...expected, spendUsdcRaw: "0", observedBlockNumber: block.number,
        observedTimestamp: block.timestamp, note,
        feeNote: "Token principal only; transaction gas still requires a separate budget reservation." } });
  }

  async function prepareTimeLock(input) {
    const fields = deposit(input);
    const beneficiary = address(input.beneficiary, "Beneficiary");
    const unlockAt = uint(input.unlockAt, "unlockAt", true);
    const { block, read } = await snapshot(timed);
    const maximum = await read(timed, timeLockAbi, "MAX_LOCK_DURATION");
    if (maximum !== BigInt(MAX_LOCK_SECONDS)) fail("The time-lock duration limit differs from the canonical contract.", "CONTRACT_MISMATCH");
    if (unlockAt < block.timestamp + BigInt(MIN_LOCK_LEAD_SECONDS)) fail("Unlock time must be at least 300 seconds after the observed chain timestamp.");
    if (unlockAt > block.timestamp + maximum) fail("Unlock time exceeds MAX_LOCK_DURATION.");
    const steps = await approvals(fields, timed, read);
    steps.push(call(timed, timeLockAbi, "lock", [fields.token, fields.amountRaw, unlockAt, beneficiary], "Create the approved time lock"));
    return plan("time_lock", steps, { ...fields, deployment: timed, owner: beneficiary, unlockAt,
      lockId: null, lockIdSource: "Locked.id", creditedAmountRaw: null, creditedAmountSource: "Locked.amount",
      minimumLeadSeconds: MIN_LOCK_LEAD_SECONDS, withdrawableAfterUnlock: true }, block,
    "The Locked receipt determines the deployment-scoped lock ID and actual credited amount. Revalidate the time window and balances before signing.");
  }

  async function prepareWithdraw(input) {
    const token = address(input.token, "Token");
    const actor = address(input.actor, "Actor");
    const lockId = uint(input.lockId, "lockId");
    const amountRaw = uint(input.amountRaw, "amountRaw", true);
    const { block, read } = await snapshot(timed);
    const record = await read(timed, timeLockAbi, "getLock", [lockId]);
    if (!same(record.token, token)) fail("The lock token differs from the approved token.", "CONTRACT_MISMATCH");
    if (!same(record.owner, actor)) fail("Only the current lock owner can withdraw.", "UNAUTHORIZED");
    if (record.withdrawn) fail("The lock was already withdrawn.", "ALREADY_WITHDRAWN");
    if (record.amount !== amountRaw) fail("The approved amount must equal the full current lock amount.", "AMOUNT_MISMATCH");
    if (block.timestamp < BigInt(record.unlockAt)) fail("The lock has not reached its on-chain unlock time.", "LOCKED");
    const steps = [call(timed, timeLockAbi, "withdraw", [lockId], "Withdraw the full unlocked token amount")];
    return plan("withdraw_lock", steps, { token, actor, deployment: timed, lockId, owner: actor, recipient: actor,
      amountRaw, unlockAt: record.unlockAt, withdrawn: true, walletReceivedAmountRaw: null }, block,
    "Withdrawal is the full recorded amount, payable to the current owner. Transfer taxes may reduce the owner's received amount; verify the receipt and balances.");
  }

  async function preparePermanentLock(input) {
    const fields = deposit(input);
    const { block, read } = await snapshot(permanent);
    const liveVault = await read(portal, portalAbi, "lockVault");
    if (!same(liveVault, permanent)) fail("The live Portal8 lock vault differs from the approved deployment.", "CONTRACT_MISMATCH");
    const lockedBeforeRaw = await read(permanent, lockVaultAbi, "locked", [fields.token]);
    const steps = await approvals(fields, permanent, read);
    steps.push(call(permanent, lockVaultAbi, "lock", [fields.token, fields.amountRaw], "Permanently lock the approved token amount"));
    return plan("permanent_lock", steps, { ...fields, deployment: permanent, lockedBeforeRaw,
      creditedAmountRaw: null, creditedAmountSource: "Locked.delta", lockedTotalSource: "Locked.totalLocked",
      irreversible: true, withdrawSupported: false }, block,
    "This lock is irreversible. There is no withdrawal or lock owner. The receipt's delta is the actual credited amount; a direct token transfer does not create a permanent lock.");
  }

  return Object.freeze({ prepareTimeLock, prepareWithdraw, preparePermanentLock });
}
