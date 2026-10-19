import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createStore } from "../scripts/argus-agent/store.mjs";

const UNIT = 10n ** 18n;
const FROM = `0x${"11".repeat(20)}`;
const TOKEN = `0x${"22".repeat(20)}`;
const ASSET = `0x${"33".repeat(20)}`;
const USDC = `0x${"44".repeat(20)}`;
const LOCK = `0x${"55".repeat(20)}`;
const HASH = () => `0x${randomBytes(32).toString("hex")}`;
const GAS = (UNIT / 10n).toString();
const FEE = (UNIT / 25n).toString();
const runFile = promisify(execFile);

function fixture(t, options) {
  const dir = mkdtempSync(join(tmpdir(), "argus-agent-store-"));
  const stores = new Set();
  const connect = () => { const store = createStore(dir, options); stores.add(store); return store; };
  const store = connect();
  const restart = current => { current.close(); stores.delete(current); return connect(); };
  t.after(() => { for (const open of stores) open.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, connect, restart };
}
function request(extra = {}) {
  return { idempotencyKey: randomUUID(), kind: "launch", termsHash: "terms-v1", terms: { chainId: 5042, operator: FROM, openingBuy: "4" },
    expected: { chainId: 5042 }, summary: { name: "Proof" }, principalRaw: "4000000",
    steps: [{ kind: "approval", to: TOKEN, value: "0", gasReserveWei: GAS }, { kind: "launch", to: TOKEN, value: "0", gasReserveWei: GAS }], ...extra };
}
function submit(store, action, index, extra = {}) {
  store.beforeSubmit(action.id, index, { leaseId: action.leaseId, attemptId: randomUUID(), from: FROM, nonce: String(index), ...extra });
  const hash = HASH();
  store.submitted(action.id, index, { hash });
  return hash;
}
function confirm(store, action, index, hash, extra = {}) {
  return store.confirmStep(action.id, index, { state: "confirmed", verified: true, networkFeeWei: FEE, hash, ...extra });
}
function mainnetFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "argus-mainnet-journal-test-"));
  const identity = { experimentId: "six-path-test", chainId: 5042, circleWallet: TOKEN, fundingWallet: FROM };
  const options = { mode: "mainnet", budgetUsdcRaw: "10000000", identity };
  const stores = [];
  const initial = createStore(dir, { ...options, initialization: "create" }); stores.push(initial);
  const connect = () => { const store = createStore(dir, { ...options, initialization: "open" }); stores.push(store); return store; };
  t.after(() => { for (const store of stores) store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, options, identity, store: initial, connect };
}
const funding = (extra = {}) => ({ verified: true, chainId: 5042, hash: HASH(), from: FROM, to: TOKEN,
  amountUsdcRaw: "10000000", networkFeeWei: FEE, blockNumber: "100", blockHash: HASH(), ...extra });
function mainnetAction(expected = {}, extra = {}) {
  return request({ principalRaw: "0", expected: { chainId: 5042, ...expected }, steps: [{ from: TOKEN, gasReserveWei: GAS }], ...extra });
}
function settleMainnet(store, input, evidence = {}) {
  const action = store.reserveExecution(store.prepare(input).id);
  for (const step of action.steps) {
    const hash = submit(store, action, step.index, { from: TOKEN, nonce: undefined });
    confirm(store, action, step.index, hash, step.index === action.steps.length - 1 ? evidence : {});
  }
  return store.getAction(action.id);
}
function acquire(store, amount = "1000") {
  return settleMainnet(store, mainnetAction({ treasury: TOKEN, operator: TOKEN }), {
    tokenAddress: ASSET, treasury: TOKEN, openingTokensRaw: amount,
  });
}
function sell(amount = "100", extra = {}) {
  return mainnetAction({ token: ASSET, actor: TOKEN, side: "sell", currencyIn: ASSET, amountInRaw: amount }, { kind: "trade", ...extra });
}
function lock(operation, extra = {}) {
  return mainnetAction({ operation, token: ASSET, actor: TOKEN, deployment: LOCK, owner: TOKEN, amountRaw: "100", ...extra }, { kind: "lock" });
}

test("prepare reserves principal and every approval fee; idempotent retry survives restart without a second reservation", t => {
  const h = fixture(t);
  const input = request();
  const action = h.store.prepare(input);
  assert.equal(h.store.budget().reservedWei, (42n * UNIT / 10n).toString());
  assert.equal(action.steps[0].principalRaw, "0");
  assert.equal(action.steps[1].principalRaw, "4000000");
  const reopened = h.restart(h.store);
  assert.equal(reopened.prepare({ ...input, steps: [{ gasReserveWei: "1" }] }).id, action.id, "same terms recover the original immutable plan before replanning");
  assert.equal(reopened.getByIdempotencyKey(input.idempotencyKey).id, action.id);
  assert.equal(reopened.getByIdempotencyKey("missing"), null);
  assert.equal(reopened.listActions().length, 1);
  assert.equal(reopened.budget().reservedWei, (42n * UNIT / 10n).toString());
  assert.throws(() => reopened.prepare({ ...input, terms: { ...input.terms, openingBuy: "5" } }), { code: "IDEMPOTENCY_CONFLICT" });
  assert.throws(() => reopened.prepare({ ...input, termsHash: "other" }), { code: "IDEMPOTENCY_CONFLICT" });
  assert.throws(() => createStore(h.dir, { budgetUsdcRaw: "20000000" }), { code: "BUDGET_CONFIG_CONFLICT" });
});

test("separate store instances cannot reserve the same remaining dollars and one wei overflow fails", t => {
  const h = fixture(t);
  h.store.prepare(request({ principalRaw: "9800000" }));
  assert.equal(h.store.budget().remainingWei, "0");
  assert.throws(() => h.connect().prepare(request({ principalRaw: "0", steps: [{ gasReserveWei: "1" }] })), { code: "BUDGET_EXCEEDED" });
  assert.equal(h.store.listActions().length, 1);
});

test("subprocess executors share a durable lease and only one can cross the pre-submit boundary", async t => {
  const h = fixture(t);
  const action = h.store.prepare(request());
  const moduleUrl = new URL("../scripts/argus-agent/store.mjs", import.meta.url).href;
  const source = `import {createStore} from ${JSON.stringify(moduleUrl)};
    const store=createStore(process.argv[1]);
    try { const a=store.reserveExecution(process.argv[2]); store.beforeSubmit(a.id,0,{leaseId:a.leaseId,attemptId:process.argv[3],from:${JSON.stringify(FROM)}}); console.log(JSON.stringify({ok:true})); }
    catch(e) { console.log(JSON.stringify({ok:false,code:e.code})); }
    finally {store.close();}`;
  const results = await Promise.all([0, 1].map(() => runFile(process.execPath, ["--input-type=module", "-e", source, h.dir, action.id, randomUUID()])));
  const parsed = results.map(result => JSON.parse(result.stdout));
  assert.equal(parsed.filter(result => result.ok).length, 1);
  assert.ok(["ACTION_LOCKED", "EXECUTION_LEASED"].includes(parsed.find(result => !result.ok).code));
  assert.equal(h.store.getAction(action.id).steps[0].status, "submitting");
});

test("a crash at the external-call boundary never permits replay or releases its budget", t => {
  const h = fixture(t);
  const action = h.store.reserveExecution(h.store.prepare(request()).id);
  const attempt = { leaseId: action.leaseId, attemptId: randomUUID(), from: FROM };
  h.store.beforeSubmit(action.id, 0, attempt);
  const reopened = h.restart(h.store);
  assert.throws(() => reopened.reserveExecution(action.id, { resume: true }), { code: "ACTION_LOCKED" });
  assert.throws(() => reopened.beforeSubmit(action.id, 0, attempt), { code: "STEP_LOCKED" });
  reopened.markUnknown(action.id, 0);
  assert.equal(reopened.budget().reservedWei, (42n * UNIT / 10n).toString());
  const hash = HASH();
  reopened.reconcileStep(action.id, 0, { hash, state: "confirmed", verified: true, networkFeeWei: FEE });
  assert.equal(reopened.getAction(action.id).steps[0].status, "confirmed");
  assert.equal(reopened.getAction(action.id).steps[1].status, "ready");
  assert.throws(() => reopened.reserveExecution(action.id), { code: "EXECUTION_LEASED" });
  const resumed = reopened.reserveExecution(action.id, { resume: true });
  assert.notEqual(resumed.leaseId, action.leaseId);
  assert.throws(() => reopened.beforeSubmit(action.id, 1, { ...attempt, attemptId: randomUUID() }), { code: "LEASE_MISMATCH" });
});

test("parallel actions cannot claim the same sender nonce, including after canonical settlement", t => {
  const h = fixture(t);
  const first = h.store.reserveExecution(h.store.prepare(request()).id);
  const other = h.connect();
  const second = other.reserveExecution(other.prepare(request()).id);
  h.store.beforeSubmit(first.id, 0, { leaseId: first.leaseId, attemptId: "first-nonce", from: FROM, nonce: "07", blockNumber: "123" });
  assert.equal(h.store.getAction(first.id).steps[0].attempt.nonce, "7");
  assert.equal(h.store.getAction(first.id).steps[0].attempt.blockNumber, "123");
  const collide = () => other.beforeSubmit(second.id, 0, { leaseId: second.leaseId, attemptId: "second-nonce", from: FROM.toUpperCase().replace("0X", "0x"), nonce: 7n });
  assert.throws(collide, { code: "NONCE_CONFLICT" });
  assert.equal(other.getAction(second.id).steps[0].status, "ready");
  const hash = HASH(); h.store.submitted(first.id, 0, { hash }); confirm(h.store, first, 0, hash);
  assert.throws(collide, { code: "NONCE_CONFLICT" });
  assert.doesNotThrow(() => other.beforeSubmit(second.id, 0, { leaseId: second.leaseId, attemptId: "second-nonce", from: FROM, nonce: 8n, blockNumber: 124n }));
});

test("recording provider IDs and then hashes is idempotent and cannot bind a submission to two actions", t => {
  const h = fixture(t);
  const action = h.store.reserveExecution(h.store.prepare(request()).id);
  h.store.beforeSubmit(action.id, 0, { leaseId: action.leaseId, attemptId: "one", from: FROM });
  h.store.submitted(action.id, 0, { providerId: "provider-transaction-1", attemptId: "one" });
  const hash = HASH();
  h.store.submitted(action.id, 0, { hash, providerId: "provider-transaction-1" });
  h.store.submitted(action.id, 0, { hash, providerId: "provider-transaction-1" });
  assert.throws(() => h.store.submitted(action.id, 0, { hash: HASH() }), { code: "SUBMISSION_CONFLICT" });
  const other = h.store.reserveExecution(h.store.prepare(request()).id);
  h.store.beforeSubmit(other.id, 0, { leaseId: other.leaseId, attemptId: "two", from: FROM });
  assert.throws(() => h.store.submitted(other.id, 0, { providerId: "provider-transaction-1" }), { code: "SUBMISSION_REUSED" });
  assert.throws(() => h.store.submitted(other.id, 0, { hash }), { code: "SUBMISSION_REUSED" });
  assert.equal(h.store.getAction(other.id).steps[0].status, "submitting");
});

test("confirmed costs settle once, approvals cost gas, and action principal is never credited back as proceeds", t => {
  const h = fixture(t);
  const action = h.store.reserveExecution(h.store.prepare(request()).id);
  const approvalHash = submit(h.store, action, 0);
  confirm(h.store, action, 0, approvalHash);
  assert.equal(h.store.budget().spentWei, FEE);
  const hash = submit(h.store, action, 1);
  const receipt = { state: "confirmed", verified: true, networkFeeWei: FEE, hash, actualAmountOut: "9000000", tokenAddress: TOKEN };
  h.store.confirmStep(action.id, 1, receipt);
  h.store.confirmStep(action.id, 1, receipt);
  assert.equal(h.store.budget().spentWei, (408n * UNIT / 100n).toString());
  assert.equal(h.store.budget().reservedWei, "0");
  assert.equal(h.store.getAction(action.id).status, "confirmed");
  assert.throws(() => h.store.confirmStep(action.id, 1, { ...receipt, networkFeeWei: "1" }), { code: "RECEIPT_CONFLICT" });
  assert.throws(() => h.store.reserveExecution(action.id), { code: "ACTION_LOCKED" });
});

test("a verified revert charges actual gas and releases only never-issued work", t => {
  const h = fixture(t);
  const action = h.store.reserveExecution(h.store.prepare(request()).id);
  const hash = submit(h.store, action, 0);
  confirm(h.store, action, 0, hash, { state: "reverted" });
  assert.equal(h.store.getAction(action.id).steps[1].status, "not-executed");
  assert.equal(h.store.budget().spentWei, FEE);
  assert.equal(h.store.budget().reservedWei, "0");
  assert.throws(() => h.store.beforeSubmit(action.id, 1, { leaseId: action.leaseId, attemptId: randomUUID(), from: FROM }), { code: "STEP_LOCKED" });
});

test("overrun is durably recorded and freezes every new execution instead of discarding the receipt", t => {
  const h = fixture(t);
  const action = h.store.reserveExecution(h.store.prepare(request()).id);
  const hash = submit(h.store, action, 0);
  confirm(h.store, action, 0, hash, { networkFeeWei: (UNIT / 5n).toString() });
  const reopened = h.restart(h.store);
  assert.equal(reopened.getAction(action.id).status, "blocked");
  assert.equal(reopened.budget().spentWei, (UNIT / 5n).toString());
  assert.equal(reopened.budget().blocked, true);
  assert.throws(() => reopened.prepare(request()), { code: "BUDGET_BLOCKED" });
});

test("only matching verified receipts can settle and only their verified launch can enter projects", t => {
  const h = fixture(t);
  const action = h.store.reserveExecution(h.store.prepare(request({ steps: [{ gas: "100000", maxFeePerGas: "1000000000000", value: "0" }] })).id);
  const hash = submit(h.store, action, 0);
  assert.throws(() => h.store.confirmStep(action.id, 0, { state: "confirmed", networkFeeWei: FEE }), { code: "RECEIPT_UNVERIFIED" });
  assert.throws(() => confirm(h.store, action, 0, HASH()), { code: "RECEIPT_CONFLICT" });
  const record = { verified: true, token: TOKEN, chainId: 5042, launchActionId: action.id, launchTxHash: hash, launchBlock: "200", operator: FROM, controller: FROM, treasury: FROM, brand: "proof" };
  assert.throws(() => h.store.saveProject(record), { code: "PROJECT_UNVERIFIED" });
  confirm(h.store, action, 0, hash, { tokenAddress: TOKEN });
  h.store.saveProject(record);
  h.store.saveProject(record);
  assert.equal(h.connect().listProjects().length, 1);
  assert.throws(() => h.store.saveProject({ ...record, token: FROM }), { code: "PROJECT_UNVERIFIED" });
  assert.throws(() => h.store.saveProject({ ...record, chainId: 1 }), { code: "PROJECT_UNVERIFIED" });
  assert.throws(() => h.store.saveProject({ ...record, brand: "changed" }), { code: "PROJECT_CONFLICT" });
});

test("missing gas, mismatched principal and caller-injected settled state cannot bypass reservations", t => {
  const h = fixture(t);
  assert.throws(() => h.store.prepare(request({ steps: [{}] })), { code: "INVALID_AMOUNT" });
  assert.throws(() => h.store.prepare(request({ steps: [{ gasReserveWei: GAS, principalRaw: "0" }] })), { code: "INVALID_AMOUNT" });
  assert.throws(() => h.store.prepare(request({ steps: [{ gasReserveWei: GAS, value: (5n * UNIT).toString() }] })), { code: "INVALID_AMOUNT" });
  const action = h.store.prepare(request({ steps: [{ gasReserveWei: GAS, settledWei: "0", receipt: { verified: true }, hash: HASH(), attempt: { id: "injected" } }] }));
  assert.equal(action.steps[0].settledWei, undefined);
  assert.equal(action.steps[0].receipt, undefined);
  assert.equal(action.steps[0].attempt, undefined);
  assert.equal(h.store.budget().reservedWei, (41n * UNIT / 10n).toString());
});

test("mainnet requires explicit initialization, immutable experiment and wallet identity, and a cap no greater than 100", t => {
  const h = mainnetFixture(t);
  const missing = join(h.dir, "missing");
  assert.throws(() => createStore(missing, h.options), { code: "MAINNET_STATE_POLICY" });
  assert.throws(() => createStore(missing, { ...h.options, initialization: "open" }), { code: "STATE_NOT_FOUND" });
  assert.equal(existsSync(missing), false, "reopen-only must not create a replacement directory or allowance");
  assert.throws(() => createStore(h.dir, { ...h.options, initialization: "create" }), { code: "STATE_ALREADY_EXISTS" });
  assert.throws(() => createStore(h.dir), { code: "STATE_IDENTITY_CONFLICT" }, "local defaults cannot open a mainnet journal");
  for (const update of [{ experimentId: "new-test" }, { circleWallet: FROM }, { fundingWallet: TOKEN }]) {
    assert.throws(() => createStore(h.dir, { ...h.options, initialization: "open", identity: { ...h.identity, ...update } }), { code: "STATE_IDENTITY_CONFLICT" });
  }
  assert.throws(() => createStore(h.dir, { ...h.options, initialization: "open", identity: { ...h.identity, chainId: 1 } }), { code: "STATE_IDENTITY_REQUIRED" });
  assert.throws(() => createStore(h.dir, { ...h.options, initialization: "open", budgetUsdcRaw: "100000001" }), { code: "MAINNET_STATE_POLICY" });
  assert.throws(() => createStore(h.dir, { ...h.options, initialization: "open", budgetUsdcRaw: "9000000" }), { code: "BUDGET_CONFIG_CONFLICT" });
  assert.equal(h.connect().budget().experimentId, h.identity.experimentId);
  assert.equal(h.store.budget().reservationEnforcement, "application-accounting-only");
});

test("a mainnet journal can be created at the 100 USDC cap but not one unit above it or at zero", t => {
  const dir = mkdtempSync(join(tmpdir(), "argus-mainnet-cap-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const identity = { experimentId: "cap-test", chainId: 5042, circleWallet: TOKEN, fundingWallet: FROM };
  for (const mode of ["mainnet", "mainnet-mvp"]) {
    for (const budgetUsdcRaw of ["100000001", "0"]) {
      assert.throws(() => createStore(join(dir, mode, budgetUsdcRaw), { mode, initialization: "create", identity, budgetUsdcRaw }), { code: "MAINNET_STATE_POLICY" });
      assert.equal(existsSync(join(dir, mode, budgetUsdcRaw)), false);
    }
    for (const [budgetUsdcRaw, usdc] of [["100000000", 100n], ["50000000", 50n]]) {
      const store = createStore(join(dir, mode, budgetUsdcRaw), { mode, initialization: "create", identity, budgetUsdcRaw });
      try { assert.equal(store.budget().limitWei, (usdc * UNIT).toString()); } finally { store.close(); }
    }
  }
});

test("an existing local ledger cannot silently become the mainnet experiment", t => {
  const h = fixture(t);
  const identity = { experimentId: "mainnet-test", chainId: 5042, circleWallet: TOKEN, fundingWallet: FROM };
  assert.throws(() => createStore(h.dir, { mode: "mainnet", initialization: "open", identity }), { code: "STATE_IDENTITY_CONFLICT" });
  assert.equal(h.connect().budget().limitWei, (10n * UNIT).toString());
  assert.throws(() => h.store.recordExternalFundingFee(funding()), { code: "FUNDING_SCOPE_INVALID" });
});

test("all six mainnet interface connections share one principal-plus-fees allowance", t => {
  const h = mainnetFixture(t);
  const stores = Array.from({ length: 6 }, () => h.connect());
  stores[0].recordExternalFundingFee(funding({ networkFeeWei: GAS }));
  stores[1].prepare(request({ principalRaw: "4500000", steps: [{ gasReserveWei: GAS }] }));
  stores[2].prepare(request({ principalRaw: "4500000", steps: [{ gasReserveWei: GAS }] }));
  for (const store of stores) {
    assert.equal(store.budget().spentWei, GAS);
    assert.equal(store.budget().reservedWei, (92n * UNIT / 10n).toString());
    assert.equal(store.budget().remainingWei, (7n * UNIT / 10n).toString());
  }
  assert.throws(() => stores[5].prepare(request({ principalRaw: "700000", steps: [{ gasReserveWei: GAS }] })), { code: "BUDGET_EXCEEDED" });
  assert.equal(h.connect().listActions().length, 2);
});

test("verified funding charges only its network fee once and altered evidence cannot create credits", t => {
  const h = mainnetFixture(t);
  const receipt = funding();
  h.store.recordExternalFundingFee(receipt);
  h.connect().recordExternalFundingFee({ ...receipt, hash: receipt.hash.toUpperCase().replace("0X", "0x") });
  assert.equal(h.store.budget().spentWei, FEE, "transferred funding principal is internal allocation, not another launch/buy spend");
  assert.equal(h.store.budget().externalFundingFeeWei, FEE);
  assert.equal(h.store.budget().remainingWei, (10n * UNIT - BigInt(FEE)).toString());
  for (const update of [{ networkFeeWei: "0" }, { amountUsdcRaw: "9000000" }, { blockHash: HASH() }]) {
    assert.throws(() => h.store.recordExternalFundingFee({ ...receipt, ...update }), { code: "FUNDING_RECEIPT_CONFLICT" });
  }
  assert.throws(() => h.store.recordExternalFundingFee(funding({ from: TOKEN })), { code: "FUNDING_IDENTITY_CONFLICT" });
  assert.throws(() => h.store.recordExternalFundingFee(funding({ to: FROM })), { code: "FUNDING_IDENTITY_CONFLICT" });
  assert.throws(() => h.store.recordExternalFundingFee(funding({ verified: false })), { code: "FUNDING_UNVERIFIED" });
  assert.throws(() => h.store.recordExternalFundingFee(funding({ state: "pending" })), { code: "FUNDING_UNVERIFIED" });
  assert.throws(() => h.store.recordExternalFundingFee(funding({ networkFeeWei: "-1" })), { code: "INVALID_AMOUNT" });
  assert.equal(h.store.budget().spentWei, FEE);
});

test("funding fee and action receipts cannot account for the same transaction twice", t => {
  const h = mainnetFixture(t);
  const receipt = funding();
  h.store.recordExternalFundingFee(receipt);
  const action = h.store.reserveExecution(h.store.prepare(request()).id);
  h.store.beforeSubmit(action.id, 0, { leaseId: action.leaseId, attemptId: randomUUID(), from: TOKEN });
  assert.throws(() => h.store.submitted(action.id, 0, { hash: receipt.hash }), { code: "SUBMISSION_REUSED" });
  const actionHash = HASH(); h.store.submitted(action.id, 0, { hash: actionHash });
  assert.throws(() => h.store.recordExternalFundingFee(funding({ hash: actionHash })), { code: "SUBMISSION_REUSED" });
});

test("a reverted funding transfer still costs gas, and an observed fee overrun is retained and blocks execution", t => {
  const h = mainnetFixture(t);
  h.store.recordExternalFundingFee(funding({ state: "reverted", amountUsdcRaw: "0" }));
  assert.equal(h.store.budget().spentWei, FEE);
  assert.throws(() => h.store.recordExternalFundingFee(funding({ state: "reverted" })), { code: "FUNDING_UNVERIFIED" });
  h.store.recordExternalFundingFee(funding({ networkFeeWei: (10n * UNIT).toString() }));
  const reopened = h.connect();
  assert.equal(reopened.budget().spentWei, (10n * UNIT + BigInt(FEE)).toString());
  assert.equal(reopened.budget().remainingWei, "0");
  assert.equal(reopened.budget().blocked, true);
  assert.throws(() => reopened.prepare(request()), { code: "BUDGET_BLOCKED" });
});

test("mainnet hosted submissions bind the Circle sender and reject EOA nonce reservations", t => {
  const h = mainnetFixture(t);
  assert.throws(() => h.store.prepare(mainnetAction({ actor: FROM })), { code: "MANUAL_SIGNER_UNAVAILABLE" });
  assert.throws(() => h.store.prepare(mainnetAction({}, { steps: [{ from: FROM, gasReserveWei: GAS }] })), { code: "MANUAL_SIGNER_UNAVAILABLE" });
  assert.throws(() => h.store.prepare(mainnetAction({}, { steps: [{ from: TOKEN, nonce: "0", gasReserveWei: GAS }] })), { code: "HOSTED_NONCE_UNSUPPORTED" });
  const action = h.store.reserveExecution(h.store.prepare(mainnetAction()).id);
  const input = { leaseId: action.leaseId, attemptId: randomUUID(), from: TOKEN };
  assert.throws(() => h.store.beforeSubmit(action.id, 0, { ...input, from: FROM }), { code: "MANUAL_SIGNER_UNAVAILABLE" });
  assert.throws(() => h.store.beforeSubmit(action.id, 0, { ...input, nonce: "0" }), { code: "HOSTED_NONCE_UNSUPPORTED" });
  h.store.beforeSubmit(action.id, 0, input);
  assert.equal(h.store.getAction(action.id).steps[0].attempt.nonce, undefined);
});

test("mainnet subprocess actions serialize the Circle sender across one shared journal", async t => {
  const h = mainnetFixture(t);
  const actions = [h.store.prepare(mainnetAction()), h.store.prepare(mainnetAction())];
  const moduleUrl = new URL("../scripts/argus-agent/store.mjs", import.meta.url).href;
  const source = `import {createStore} from ${JSON.stringify(moduleUrl)};
    const store=createStore(process.argv[1],${JSON.stringify({ ...h.options, initialization: "open" })});
    try { const a=store.reserveExecution(process.argv[2]); store.beforeSubmit(a.id,0,{leaseId:a.leaseId,attemptId:process.argv[3],from:${JSON.stringify(TOKEN)}}); console.log(JSON.stringify({ok:true,id:a.id})); }
    catch(e) { console.log(JSON.stringify({ok:false,code:e.code})); }
    finally {store.close();}`;
  const results = await Promise.all(actions.map(action => runFile(process.execPath, ["--input-type=module", "-e", source, h.dir, action.id, randomUUID()])));
  const parsed = results.map(result => JSON.parse(result.stdout));
  assert.equal(parsed.filter(result => result.ok).length, 1);
  assert.equal(parsed.find(result => !result.ok).code, "SENDER_INFLIGHT");
  const pending = h.store.getAction(parsed.find(result => result.ok).id);
  const remaining = h.store.getAction(actions.find(action => action.id !== pending.id).id);
  const attempt = { leaseId: remaining.leaseId, attemptId: randomUUID(), from: TOKEN };
  h.store.markUnknown(pending.id, 0);
  assert.throws(() => h.connect().beforeSubmit(remaining.id, 0, attempt), { code: "SENDER_INFLIGHT" });
  const hash = HASH(); h.store.submitted(pending.id, 0, { hash, providerId: "hosted-one" });
  assert.throws(() => h.store.beforeSubmit(remaining.id, 0, attempt), { code: "SENDER_INFLIGHT" });
  confirm(h.store, pending, 0, hash);
  assert.doesNotThrow(() => h.store.beforeSubmit(remaining.id, 0, attempt));
});

test("a legacy sell reserves the sell tax its token charges from the remaining balance, never less than it sells", t => {
  const h = mainnetFixture(t);
  acquire(h.store);
  const surcharged = (amount, debit) => mainnetAction({ token: ASSET, actor: TOKEN, side: "sell", currencyIn: ASSET, amountInRaw: amount, inventoryDebitRaw: debit }, { kind: "trade" });
  h.store.prepare(surcharged("900", "909"));
  assert.equal(h.store.getInventory(ASSET, TOKEN).reservedRaw, "909");
  assert.equal(h.store.getInventory(ASSET, TOKEN).availableRaw, "91");
  assert.throws(() => h.store.prepare(surcharged("91", "92")), { code: "INSUFFICIENT_INVENTORY" });
  assert.throws(() => h.store.prepare(surcharged("50", "49")), { code: "INVALID_AMOUNT" });
  assert.doesNotThrow(() => h.store.prepare(surcharged("90", "91")));
});

test("mainnet sells reserve only verified launch and buy inventory and do not credit USDC proceeds", t => {
  const h = mainnetFixture(t);
  assert.equal(h.store.getInventory(ASSET, TOKEN).availableRaw, "0");
  assert.throws(() => h.store.prepare(sell()), { code: "INSUFFICIENT_INVENTORY" });
  assert.throws(() => h.store.getInventory(ASSET, FROM), { code: "MANUAL_SIGNER_UNAVAILABLE" });
  acquire(h.store);
  settleMainnet(h.store, mainnetAction({ token: ASSET, actor: TOKEN, side: "buy", currencyOut: ASSET }, { kind: "trade", principalRaw: "1000000" }), { actualOutputRaw: "200" });
  const first = h.store.prepare(sell("900"));
  assert.equal(h.connect().getInventory(ASSET, TOKEN).availableRaw, "300");
  assert.throws(() => h.connect().prepare(sell("301")), { code: "INSUFFICIENT_INVENTORY" });
  assert.equal(h.store.prepare({ ...sell("900"), idempotencyKey: first.idempotencyKey }).id, first.id);
  const executing = h.store.reserveExecution(first.id);
  const before = h.store.budget();
  const hash = submit(h.store, executing, 0, { from: TOKEN, nonce: undefined });
  confirm(h.store, executing, 0, hash, { actualOutputRaw: "9000000" });
  assert.deepEqual(h.store.getInventory(ASSET, TOKEN), { token: ASSET, actor: TOKEN, acquiredRaw: "1200", consumedRaw: "900", reservedRaw: "0", availableRaw: "300", blocked: false });
  assert.equal(BigInt(h.store.budget().spentWei), BigInt(before.spentWei) + BigInt(FEE), "sale proceeds never offset experiment spending");
});

test("mainnet token inventory remains reserved across approval interruption and unknown final execution", t => {
  const h = mainnetFixture(t);
  acquire(h.store);
  const action = h.store.reserveExecution(h.store.prepare(sell("700", { steps: [{ from: TOKEN, gasReserveWei: GAS }, { from: TOKEN, gasReserveWei: GAS }] })).id);
  const approval = submit(h.store, action, 0, { from: TOKEN, nonce: undefined });
  confirm(h.store, action, 0, approval);
  assert.equal(h.connect().getInventory(ASSET, TOKEN).reservedRaw, "700");
  h.store.beforeSubmit(action.id, 1, { leaseId: action.leaseId, attemptId: randomUUID(), from: TOKEN });
  h.store.markUnknown(action.id, 1);
  assert.equal(h.connect().getInventory(ASSET, TOKEN).reservedRaw, "700");
  assert.throws(() => h.store.prepare(sell("301")), { code: "INSUFFICIENT_INVENTORY" });
  const hash = HASH(); h.store.submitted(action.id, 1, { hash });
  confirm(h.store, action, 1, hash, { state: "reverted" });
  assert.equal(h.store.getInventory(ASSET, TOKEN).availableRaw, "1000");
  assert.equal(h.store.getInventory(ASSET, TOKEN).consumedRaw, "0");
});

test("a canonical reverted predecessor releases unissued token inventory only", t => {
  const h = mainnetFixture(t);
  acquire(h.store);
  const action = h.store.reserveExecution(h.store.prepare(sell("800", { steps: [{ from: TOKEN, gasReserveWei: GAS }, { from: TOKEN, gasReserveWei: GAS }] })).id);
  const hash = submit(h.store, action, 0, { from: TOKEN, nonce: undefined });
  confirm(h.store, action, 0, hash, { state: "reverted" });
  assert.equal(h.store.getAction(action.id).steps[1].status, "not-executed");
  assert.equal(h.store.getInventory(ASSET, TOKEN).availableRaw, "1000");
  assert.doesNotThrow(() => h.connect().prepare(sell("1000")));
});

test("inventory excludes unconfirmed acquisitions, wrong recipients and non-token buy outputs", t => {
  const h = mainnetFixture(t);
  h.store.prepare(mainnetAction({ treasury: TOKEN, operator: TOKEN }));
  settleMainnet(h.store, mainnetAction({ treasury: TOKEN, operator: TOKEN }), { tokenAddress: ASSET, treasury: FROM, openingTokensRaw: "1000" });
  settleMainnet(h.store, mainnetAction({ token: ASSET, actor: TOKEN, side: "buy", currencyOut: USDC }, { kind: "trade" }), { actualOutputRaw: "1000" });
  assert.equal(h.store.getInventory(ASSET, TOKEN).availableRaw, "0");
  assert.throws(() => h.store.prepare(sell("1")), { code: "INSUFFICIENT_INVENTORY" });
});

test("provider evidence without a canonical hash or a verified revert cannot create inventory", t => {
  const h = mainnetFixture(t);
  const action = h.store.reserveExecution(h.store.prepare(mainnetAction({ treasury: TOKEN, operator: TOKEN })).id);
  h.store.beforeSubmit(action.id, 0, { leaseId: action.leaseId, attemptId: randomUUID(), from: TOKEN });
  h.store.submitted(action.id, 0, { providerId: "provider-only" });
  h.store.confirmStep(action.id, 0, { verified: true, state: "confirmed", networkFeeWei: FEE, tokenAddress: ASSET, treasury: TOKEN, openingTokensRaw: "1000" });
  settleMainnet(h.store, mainnetAction({ treasury: TOKEN, operator: TOKEN }), { state: "reverted", tokenAddress: ASSET, treasury: TOKEN, openingTokensRaw: "1000" });
  assert.equal(h.store.getInventory(ASSET, TOKEN).availableRaw, "0");
});

test("timed and permanent locks reserve inventory shared with sells and debit the full requested amount", t => {
  const h = mainnetFixture(t);
  acquire(h.store, "300");
  const timed = h.store.prepare(lock("timed"));
  h.connect().prepare(sell("100"));
  assert.throws(() => h.store.prepare(lock("permanent", { amountRaw: "101" })), { code: "INSUFFICIENT_INVENTORY" });
  settleMainnet(h.store, lock("permanent"), { creditedAmountRaw: "90", lockedTotalRaw: "90" });
  const inventory = h.store.getInventory(ASSET, TOKEN);
  assert.equal(inventory.consumedRaw, "100", "transfer-tax loss is not silently made spendable");
  assert.equal(inventory.reservedRaw, "200");
  assert.equal(inventory.availableRaw, "0");
  assert.equal(h.store.getAction(timed.id).status, "prepared");
  assert.throws(() => h.store.prepare(lock("timed", { owner: FROM, amountRaw: "1" })), { code: "INSUFFICIENT_INVENTORY" });
});

test("withdrawal requires a journaled timed lock and credits only verified wallet receipt units once", t => {
  const h = mainnetFixture(t);
  acquire(h.store, "300");
  assert.throws(() => h.store.prepare(lock("withdraw", { lockId: "7" })), { code: "LOCK_NOT_IN_JOURNAL" });
  assert.throws(() => h.store.prepare(lock("timed", { owner: FROM })), { code: "MANUAL_SIGNER_UNAVAILABLE" });
  const deposit = settleMainnet(h.store, lock("timed"), { tokenAddress: ASSET, owner: TOKEN, deployment: LOCK, lockId: "7", creditedAmountRaw: "90" });
  assert.equal(h.store.getInventory(ASSET, TOKEN).availableRaw, "200");
  assert.throws(() => h.store.prepare(lock("withdraw", { lockId: "7" })), { code: "INVENTORY_UNVERIFIED" });
  const withdrawal = h.store.prepare(lock("withdraw", { lockId: "7", amountRaw: "90" }));
  assert.equal(withdrawal.inventorySourceActionId, deposit.id);
  assert.throws(() => h.connect().prepare(lock("withdraw", { lockId: "7", amountRaw: "90" })), { code: "LOCK_ALREADY_RESERVED" });
  const executing = h.store.reserveExecution(withdrawal.id);
  const hash = submit(h.store, executing, 0, { from: TOKEN, nonce: undefined });
  h.store.markUnknown(executing.id, 0);
  assert.equal(h.store.getInventory(ASSET, TOKEN).availableRaw, "200");
  confirm(h.store, executing, 0, hash, { walletReceivedAmountRaw: "81", tokenAddress: ASSET, deployment: LOCK, lockId: "7" });
  assert.equal(h.connect().getInventory(ASSET, TOKEN).availableRaw, "281");
  assert.throws(() => h.store.prepare(lock("withdraw", { lockId: "7", amountRaw: "90" })), { code: "LOCK_ALREADY_RESERVED" });
});

test("a verified reverted withdrawal permits a new withdrawal while unknown outcomes do not", t => {
  const h = mainnetFixture(t);
  acquire(h.store);
  settleMainnet(h.store, lock("timed"), { tokenAddress: ASSET, owner: TOKEN, deployment: LOCK, lockId: "8", creditedAmountRaw: "100" });
  const action = h.store.reserveExecution(h.store.prepare(lock("withdraw", { lockId: "8" })).id);
  const hash = submit(h.store, action, 0, { from: TOKEN, nonce: undefined });
  confirm(h.store, action, 0, hash, { state: "reverted" });
  assert.equal(h.store.getInventory(ASSET, TOKEN).availableRaw, "900");
  assert.doesNotThrow(() => h.connect().prepare(lock("withdraw", { lockId: "8" })));
});
