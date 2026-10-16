import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { decodeFunctionData, getAddress, zeroAddress } from "viem";
import { createLockAdapter, CURRENT_TIME_LOCK } from "../scripts/argus-agent/locks.mjs";
// The runtime's compiled helper; the package test keeps it equal to the app's time-lock source.
import { MAX_LOCK_SECONDS } from "../scripts/argus-agent/generated/time-lock.mjs";

const bundle = JSON.parse(readFileSync(new URL("../scripts/argus-agent/vendor/argus-v4.json", import.meta.url), "utf8"));
const VAULT = getAddress(bundle.portal8.addresses.lockVault);
const A = getAddress("0x1111111111111111111111111111111111111111");
const B = getAddress("0x2222222222222222222222222222222222222222");
const TOKEN = getAddress("0x5555555555555555555555555555555555555555");
const HOOK = getAddress("0x6666666666666666666666666666666666666666");
const deployment = { timeLock: CURRENT_TIME_LOCK, lockVault: VAULT };
const input = (extra = {}) => ({ token: TOKEN, actor: A, beneficiary: B, amountRaw: "100", inventoryRaw: "200", unlockAt: "1300", ...extra });
const withdrawal = (extra = {}) => ({ token: TOKEN, actor: A, lockId: "7", amountRaw: "90", ...extra });
const decode = (step) => decodeFunctionData({ abi: step.abi, data: step.data });

function fixture(overrides = {}, lock = {}) {
  const calls = [];
  const defaults = { launches: [HOOK], balanceOf: 200n, allowance: 0n, MAX_LOCK_DURATION: BigInt(MAX_LOCK_SECONDS),
    lockVault: VAULT, locked: 500n, getLock: { token: TOKEN, unlockAt: 1000n, withdrawn: false, owner: A, lockedAt: 500n, amount: 90n, ...lock } };
  const client = {
    getChainId: async () => 5042,
    getBlock: async () => ({ number: 900n, timestamp: 1000n }),
    getCode: async (request) => { calls.push({ method: "getCode", ...request }); return "0x6000"; },
    readContract: async (request) => {
      calls.push(request);
      const value = request.functionName in overrides ? overrides[request.functionName] : defaults[request.functionName];
      if (value === undefined) throw new Error(`Unexpected read ${request.functionName}`);
      if (value instanceof Error) throw value;
      return typeof value === "function" ? value(request) : value;
    },
  };
  return { client, calls, adapter: createLockAdapter(client, deployment) };
}

test("time-lock calldata binds token, amount, beneficiary and deployment without predicting receipt credit", async () => {
  const { adapter, calls } = fixture();
  const plan = await adapter.prepareTimeLock(input());
  assert.equal(plan.steps.length, 2);
  assert.deepEqual(decode(plan.steps[0]), { functionName: "approve", args: [CURRENT_TIME_LOCK, 100n] });
  assert.deepEqual(decode(plan.steps[1]), { functionName: "lock", args: [TOKEN, 100n, 1300n, B] });
  assert.equal(plan.steps[1].to, CURRENT_TIME_LOCK);
  assert.equal(plan.expected.owner, B);
  assert.equal(plan.expected.actor, A);
  assert.equal(plan.expected.lockId, null);
  assert.equal(plan.expected.creditedAmountRaw, null);
  assert.equal(plan.expected.creditedAmountSource, "Locked.amount");
  assert.equal(plan.summary.observedTimestamp, "1000");
  assert.equal(plan.summary.spendUsdcRaw, "0");
  assert.match(plan.summary.feeNote, /gas.*separate budget/);
  assert.ok(plan.steps.every((step) => step.value === "0"));
  assert.ok(calls.every((request) => request.blockNumber === 900n));
  assert.doesNotThrow(() => JSON.stringify(plan));
  assert.throws(() => { plan.expected.amountRaw = "200"; }, TypeError);
  assert.ok(Object.isFrozen(plan.steps[0].abi));
});

test("lock approvals are exact, including resetting an excessive allowance", async () => {
  for (const allowance of [0n, 50n, 100n, 1000n]) {
    const { adapter } = fixture({ allowance });
    for (const method of ["prepareTimeLock", "preparePermanentLock"]) {
      const plan = await adapter[method](input());
      const amounts = plan.steps.slice(0, -1).map((step) => decode(step).args[1]);
      assert.deepEqual(amounts, allowance === 100n ? [] : allowance === 0n ? [100n] : [0n, 100n]);
    }
  }
});

test("deployment configuration is explicit, nonzero and restricted to the verified current contracts", () => {
  const { client } = fixture();
  assert.throws(() => createLockAdapter(client), /Time-lock deployment/);
  assert.throws(() => createLockAdapter(client, { timeLock: CURRENT_TIME_LOCK }), /Permanent-lock deployment/);
  for (const invalid of [zeroAddress, "not-an-address", undefined]) {
    assert.throws(() => createLockAdapter(client, { ...deployment, timeLock: invalid }), /deployment/);
  }
  assert.throws(() => createLockAdapter(client, { ...deployment, timeLock: A }), { code: "CONTRACT_MISMATCH" });
  assert.throws(() => createLockAdapter(client, { ...deployment, lockVault: A }), { code: "CONTRACT_MISMATCH" });
});

test("unsupported chains, pending snapshots, absent code and changed vaults fail closed", async () => {
  const { adapter, client } = fixture();
  client.getChainId = async () => 1;
  await assert.rejects(adapter.prepareTimeLock(input()), { code: "CHAIN_MISMATCH" });
  client.getChainId = async () => 5042;
  client.getBlock = async () => ({ number: null, timestamp: 1000n });
  await assert.rejects(adapter.prepareTimeLock(input()), { code: "INVALID_SNAPSHOT" });
  client.getBlock = async () => ({ number: 900n, timestamp: 1000n });
  client.getCode = async () => "0x";
  await assert.rejects(adapter.prepareTimeLock(input()), { code: "CONTRACT_MISMATCH" });
  await assert.rejects(adapter.prepareWithdraw(withdrawal()), { code: "CONTRACT_MISMATCH" });
  await assert.rejects(fixture({ lockVault: A }).adapter.preparePermanentLock(input()), { code: "CONTRACT_MISMATCH" });
});

test("deposit amounts must fit both journal inventory and the live balance without number rounding", async () => {
  const { adapter } = fixture();
  for (const amountRaw of ["0", "-1", "1.5", "1e2", 100, -1n, 1n << 256n]) {
    await assert.rejects(adapter.prepareTimeLock(input({ amountRaw })), { code: "INVALID_INPUT" });
  }
  await assert.rejects(adapter.prepareTimeLock(input({ inventoryRaw: undefined })), /Verified inventory/);
  await assert.rejects(adapter.prepareTimeLock(input({ inventoryRaw: "99" })), { code: "INSUFFICIENT_INVENTORY" });
  await assert.rejects(adapter.preparePermanentLock(input({ inventoryRaw: "0" })), { code: "INSUFFICIENT_INVENTORY" });
  await assert.rejects(fixture({ balanceOf: 99n }).adapter.prepareTimeLock(input()), { code: "INSUFFICIENT_BALANCE" });
  const equal = await adapter.prepareTimeLock(input({ amountRaw: 200n, inventoryRaw: 200n }));
  assert.equal(equal.expected.amountRaw, "200");
});

test("timing uses the same chain snapshot with inclusive 300-second and maximum-duration boundaries", async () => {
  const { adapter } = fixture();
  await assert.rejects(adapter.prepareTimeLock(input({ unlockAt: "1299" })), /300 seconds/);
  await adapter.prepareTimeLock(input({ unlockAt: "1300" }));
  const maximum = 1000n + BigInt(MAX_LOCK_SECONDS);
  await adapter.prepareTimeLock(input({ unlockAt: maximum }));
  await assert.rejects(adapter.prepareTimeLock(input({ unlockAt: maximum + 1n })), /MAX_LOCK_DURATION/);
  await assert.rejects(fixture({ MAX_LOCK_DURATION: 301n }).adapter.prepareTimeLock(input()), { code: "CONTRACT_MISMATCH" });
});

test("token membership and read availability gate both deposits; addresses must be explicit", async () => {
  for (const method of ["prepareTimeLock", "preparePermanentLock"]) {
    await assert.rejects(fixture({ launches: [zeroAddress] }).adapter[method](input()), { code: "UNSUPPORTED" });
    await assert.rejects(fixture({ launches: new Error("RPC unavailable") }).adapter[method](input()), /RPC unavailable/);
    for (const field of ["token", "actor"]) await assert.rejects(fixture().adapter[method](input({ [field]: zeroAddress })), /zero address/);
  }
  await assert.rejects(fixture().adapter.prepareTimeLock(input({ beneficiary: undefined })), /Beneficiary/);
  await assert.rejects(fixture().adapter.prepareTimeLock(input({ beneficiary: zeroAddress })), /zero address/);
});

test("withdrawal is owner-only, full amount, at the exact unlock boundary, with no approval or recipient calldata", async () => {
  const { adapter, calls } = fixture();
  const plan = await adapter.prepareWithdraw(withdrawal());
  assert.equal(plan.steps.length, 1);
  assert.deepEqual(decode(plan.steps[0]), { functionName: "withdraw", args: [7n] });
  assert.equal(plan.steps[0].to, CURRENT_TIME_LOCK);
  assert.equal(plan.expected.recipient, A);
  assert.equal(plan.expected.amountRaw, "90");
  assert.equal(plan.expected.lockId, "7");
  assert.equal(plan.expected.withdrawn, true);
  assert.equal(plan.expected.walletReceivedAmountRaw, null);
  assert.ok(calls.every((request) => request.blockNumber === 900n));
  assert.ok(!calls.some((request) => request.functionName === "allowance"));
  await assert.rejects(adapter.prepareWithdraw(withdrawal({ actor: B })), { code: "UNAUTHORIZED" });
  await assert.rejects(adapter.prepareWithdraw(withdrawal({ amountRaw: "89" })), { code: "AMOUNT_MISMATCH" });
  await assert.rejects(adapter.prepareWithdraw(withdrawal({ token: B })), { code: "CONTRACT_MISMATCH" });
  await assert.rejects(adapter.prepareWithdraw(withdrawal({ lockId: "-1" })), { code: "INVALID_INPUT" });
});

test("a pending owner has no withdrawal permission, early and repeated withdrawals are refused", async () => {
  await assert.rejects(fixture({ pendingOwnerOf: B }).adapter.prepareWithdraw(withdrawal({ actor: B })), { code: "UNAUTHORIZED" });
  await assert.rejects(fixture({}, { unlockAt: 1001n }).adapter.prepareWithdraw(withdrawal()), { code: "LOCKED" });
  await assert.rejects(fixture({}, { withdrawn: true }).adapter.prepareWithdraw(withdrawal()), { code: "ALREADY_WITHDRAWN" });
});

test("permanent lock calls lock rather than transfer and offers no withdrawal fiction", async () => {
  const { adapter, calls } = fixture({ allowance: 100n });
  const plan = await adapter.preparePermanentLock(input());
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].to, VAULT);
  assert.deepEqual(decode(plan.steps[0]), { functionName: "lock", args: [TOKEN, 100n] });
  assert.equal(plan.expected.irreversible, true);
  assert.equal(plan.expected.withdrawSupported, false);
  assert.equal(plan.expected.lockedBeforeRaw, "500");
  assert.equal(plan.expected.creditedAmountRaw, null);
  assert.equal(plan.expected.creditedAmountSource, "Locked.delta");
  assert.equal(plan.expected.lockedTotalSource, "Locked.totalLocked");
  assert.equal(plan.expected.owner, undefined);
  assert.equal(plan.expected.unlockAt, undefined);
  assert.equal(adapter.preparePermanentWithdraw, undefined);
  assert.ok(calls.some((request) => request.functionName === "lockVault" && request.address === getAddress(bundle.launchPortal)));
  assert.ok(calls.every((request) => request.blockNumber === 900n));
  assert.match(plan.summary.note, /irreversible/);
});
