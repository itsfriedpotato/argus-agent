import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PORTALS } from "./generated/addresses.mjs";

const UNIT = 10n ** 12n; // Six-decimal USDC amounts to Arc's 18-decimal gas units.
/** The cumulative mainnet USDC cap per workspace, in six-decimal units (100 USDC). */
export const MAINNET_BUDGET_CAP_USDC_RAW = 100_000_000n;
const inflight = new Set(["submitting", "submitted", "unknown"]);
const clean = value => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item));
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const digest = value => createHash("sha256").update(canonical(value)).digest("hex");

export class AgentStoreError extends Error {
  constructor(code, message) { super(message); this.name = "AgentStoreError"; this.code = code; }
}
const fail = (code, message) => { throw new AgentStoreError(code, message); };
function integer(value, label) {
  if (typeof value !== "string" || !/^\d{1,80}$/.test(value)) fail("INVALID_AMOUNT", `${label} must be a non-negative integer string.`);
  return BigInt(value);
}
function text(value, label, max = 256) {
  if (typeof value !== "string" || !value || value.length > max) fail("INVALID_INPUT", `${label} is required.`);
  return value;
}

function normalizeIdentity(identity) {
  if (!identity || Number(identity.chainId) !== 5042) fail("STATE_IDENTITY_REQUIRED", "The mainnet journal requires an Arc chain identity.");
  const experimentId = text(identity.experimentId, "experimentId", 128);
  for (const field of ["circleWallet", "fundingWallet"]) {
    if (!/^0x[\da-f]{40}$/i.test(identity[field] ?? "") || /^0x0{40}$/i.test(identity[field])) fail("STATE_IDENTITY_REQUIRED", `The mainnet journal requires a nonzero ${field} address.`);
  }
  return { experimentId, chainId: 5042, circleWallet: identity.circleWallet.toLowerCase(), fundingWallet: identity.fundingWallet.toLowerCase() };
}

/** One retained journal. Mainnet initialization is explicit; it never loads .env. */
export function createStore(stateDir, { budgetUsdcRaw = "10000000", mode = "local-fork", initialization = "auto", identity } = {}) {
  if (!["local-fork", "mainnet", "mainnet-mvp"].includes(mode) || !["auto", "create", "open"].includes(initialization)) fail("STATE_MODE_INVALID", "Choose a supported journal mode and initialization behavior.");
  const mainnet = ["mainnet", "mainnet-mvp"].includes(mode);
  const limitRaw = integer(budgetUsdcRaw, "budgetUsdcRaw");
  if (mainnet && (initialization === "auto" || limitRaw <= 0n || limitRaw > MAINNET_BUDGET_CAP_USDC_RAW)) {
    fail("MAINNET_STATE_POLICY", "Mainnet requires explicit create/open initialization and a positive cumulative limit no greater than 100 USDC.");
  }
  const boundIdentity = mainnet ? normalizeIdentity(identity) : null;
  const directory = resolve(text(stateDir, "stateDir", 4096));
  const filename = join(directory, "agent.sqlite");
  if (initialization === "open" && !existsSync(filename)) fail("STATE_NOT_FOUND", "The retained journal is missing. Execution cannot initialize another budget.");
  if (initialization !== "open") mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (initialization === "create") {
    try { closeSync(openSync(filename, "wx", 0o600)); }
    catch (error) { if (error.code === "EEXIST") fail("STATE_ALREADY_EXISTS", "The journal already exists. Reopen it without resetting its budget."); throw error; }
  }
  const db = new DatabaseSync(filename);
  const limit = limitRaw * UNIT;
  try {
    // Validate existing binding before any schema migration or journal-mode write.
    const hasConfig = Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'config'").get());
    const saved = hasConfig ? Object.fromEntries(db.prepare("SELECT key, value FROM config").all().map(row => [row.key, row.value])) : {};
    if (initialization === "open" && !saved.budget_wei) fail("STATE_NOT_INITIALIZED", "The journal has no retained budget identity. It cannot be initialized during execution.");
    if (saved.execution_mode && saved.execution_mode !== mode) fail("STATE_IDENTITY_CONFLICT", "This journal belongs to a different execution environment.");
    if (mainnet && initialization === "open" && (saved.execution_mode !== mode || saved.identity !== canonical(boundIdentity))) {
      fail("STATE_IDENTITY_CONFLICT", "The experiment, chain or wallet identity does not match the retained mainnet journal.");
    }
    if (saved.budget_wei && saved.budget_wei !== limit.toString()) fail("BUDGET_CONFIG_CONFLICT", "This state directory already has a different cumulative budget. Do not reset its journal to bypass that limit.");
    chmodSync(filename, 0o600);
    db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS actions (id TEXT PRIMARY KEY, idem TEXT UNIQUE NOT NULL, terms_hash TEXT NOT NULL, identity TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, action_id TEXT NOT NULL, step_index INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS nonce_claims (chain_id TEXT NOT NULL, sender TEXT NOT NULL, nonce TEXT NOT NULL, action_id TEXT NOT NULL, step_index INTEGER NOT NULL, PRIMARY KEY (chain_id, sender, nonce));
    CREATE TABLE IF NOT EXISTS submissions (locator TEXT PRIMARY KEY, action_id TEXT NOT NULL, step_index INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS projects (token TEXT NOT NULL, chain_id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (token, chain_id));
    CREATE TABLE IF NOT EXISTS external_funding_fees (hash TEXT PRIMARY KEY, fee_wei TEXT NOT NULL, json TEXT NOT NULL);`);
  } catch (error) { db.close(); throw error; }
  if (mode === "mainnet-mvp") db.exec(`
    CREATE TABLE IF NOT EXISTS recovered_positions (token TEXT NOT NULL, actor TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (token, actor));
    CREATE TABLE IF NOT EXISTS recovered_locks (deployment TEXT NOT NULL, lock_id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (deployment, lock_id));`);
  function transaction(fn) {
    db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  try {
    transaction(() => {
      const row = db.prepare("SELECT value FROM config WHERE key = 'budget_wei'").get();
      if (row && row.value !== limit.toString()) fail("BUDGET_CONFIG_CONFLICT", "This state directory already has a different cumulative budget. Do not reset its journal to bypass that limit.");
      db.prepare("INSERT OR IGNORE INTO config VALUES ('budget_wei', ?)").run(limit.toString());
      db.prepare("INSERT OR IGNORE INTO config VALUES ('execution_mode', ?)").run(mode);
      if (boundIdentity) db.prepare("INSERT OR IGNORE INTO config VALUES ('identity', ?)").run(canonical(boundIdentity));
    });
  } catch (error) { db.close(); throw error; }

  function listActions() { return db.prepare("SELECT json FROM actions ORDER BY rowid").all().map(row => JSON.parse(row.json)); }
  function getAction(id) {
    const row = db.prepare("SELECT json FROM actions WHERE id = ?").get(id);
    if (!row) fail("ACTION_NOT_FOUND", "This action does not exist in the selected state directory.");
    return JSON.parse(row.json);
  }
  function getByIdempotencyKey(key) {
    const row = db.prepare("SELECT json FROM actions WHERE idem = ?").get(key);
    return row ? JSON.parse(row.json) : null;
  }
  function write(action) {
    action.updatedAt = new Date().toISOString();
    db.prepare("UPDATE actions SET json = ? WHERE id = ?").run(JSON.stringify(action), action.id);
    return action;
  }
  const sameAddress = (left, right) => typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
  function inventoryAddress(value, label) {
    if (!/^0x[\da-f]{40}$/i.test(value ?? "") || /^0x0{40}$/i.test(value)) fail("INVALID_INPUT", `${label} must be a nonzero address.`);
    return value.toLowerCase();
  }
  function successfulFinal(action) {
    const step = action.steps.at(-1);
    return step?.status === "confirmed" && step.receipt?.verified === true && step.receipt.state === "confirmed" &&
      /^0x[\da-f]{64}$/i.test(step.hash ?? "") && sameAddress(step.receipt.hash, step.hash) ? step.receipt : null;
  }
  function inventoryDebit(action) {
    const expected = action.expected ?? {};
    const amount = action.kind === "trade" && expected.side === "sell" ? expected.amountInRaw
      : action.kind === "lock" && ["timed", "permanent"].includes(expected.operation) ? expected.amountRaw : undefined;
    if (amount === undefined) return null;
    const amountRaw = integer(amount, "inventory amount");
    if (amountRaw === 0n) fail("INVALID_AMOUNT", "Token inventory reservations must be positive.");
    return { token: inventoryAddress(expected.token, "Inventory token"), actor: inventoryAddress(expected.actor, "Inventory actor"), amountRaw };
  }
  function verifiedTimedLock(actions, expected) {
    const lockId = integer(String(expected.lockId), "lockId").toString();
    const matches = actions.filter(action => {
      const receipt = successfulFinal(action);
      return action.kind === "lock" && action.expected.operation === "timed" && receipt &&
        sameAddress(action.expected.token, expected.token) && sameAddress(action.expected.owner, expected.actor) &&
        sameAddress(action.expected.deployment, expected.deployment) && sameAddress(receipt.tokenAddress, expected.token) &&
        sameAddress(receipt.owner, expected.actor) && sameAddress(receipt.deployment, expected.deployment) &&
        typeof receipt.lockId === "string" && integer(receipt.lockId, "receipt lockId").toString() === lockId;
    });
    if (matches.length === 0 && mode === "mainnet-mvp") {
      const recovered = db.prepare("SELECT json FROM recovered_locks WHERE deployment = ? AND lock_id = ?").get(expected.deployment.toLowerCase(), lockId);
      const record = recovered ? JSON.parse(recovered.json) : null;
      if (record && record.verified === true && sameAddress(record.token, expected.token) && sameAddress(record.owner, expected.actor)) {
        return { id: `recovered-lock:${expected.deployment.toLowerCase()}:${lockId}`, steps: [{ receipt: { creditedAmountRaw: record.amountRaw } }] };
      }
    }
    if (matches.length !== 1) fail("LOCK_NOT_IN_JOURNAL", "Withdrawal requires one verified timed lock owned by this actor in the retained journal.");
    return matches[0];
  }
  function inventoryReleased(action) {
    const final = action.steps.at(-1);
    return final.status === "reverted" || (["reverted", "cancelled"].includes(action.status) && final.status === "not-executed");
  }
  /** Only canonical acquisition receipts create inventory. Balances and sale proceeds do not. */
  function getInventory(token, actor) {
    token = inventoryAddress(token, "Inventory token");
    actor = inventoryAddress(actor, "Inventory actor");
    if (boundIdentity && actor !== boundIdentity.circleWallet) fail("MANUAL_SIGNER_UNAVAILABLE", "Hosted execution only has a signer for the bound Circle wallet.");
    const saved = mode === "mainnet-mvp" ? db.prepare("SELECT json FROM recovered_positions WHERE token = ? AND actor = ?").get(token, actor) : null;
    const checkpoint = saved ? JSON.parse(saved.json) : null;
    const excluded = new Set(checkpoint?.includedActionIds ?? []);
    let acquired = checkpoint ? integer(checkpoint.balanceRaw, "recovered balance") : 0n; let consumed = 0n; let reserved = 0n;
    const actions = listActions();
    for (const action of actions) {
      if (excluded.has(action.id)) continue;
      const expected = action.expected ?? {};
      const receipt = successfulFinal(action);
      if (receipt && action.kind === "launch" && sameAddress(receipt.tokenAddress, token) && sameAddress(receipt.treasury, actor) && sameAddress(expected.treasury, actor)) {
        acquired += integer(receipt.openingTokensRaw, "verified opening tokens");
      } else if (receipt && action.kind === "trade" && expected.side === "buy" && sameAddress(expected.token, token) && sameAddress(expected.currencyOut, token) && sameAddress(expected.actor, actor)) {
        acquired += integer(receipt.actualOutputRaw, "verified bought tokens");
      } else if (receipt && action.kind === "lock" && expected.operation === "withdraw" && sameAddress(expected.token, token) && sameAddress(expected.actor, actor)) {
        const source = verifiedTimedLock(actions, expected);
        if (source.id !== action.inventorySourceActionId || !sameAddress(receipt.tokenAddress, token) ||
            !sameAddress(receipt.deployment, expected.deployment) || String(receipt.lockId) !== String(expected.lockId)) fail("INVENTORY_UNVERIFIED", "The withdrawal receipt does not match its journaled lock.");
        const received = integer(receipt.walletReceivedAmountRaw, "verified withdrawn tokens");
        if (received > integer(source.steps.at(-1).receipt.creditedAmountRaw, "verified locked tokens")) fail("INVENTORY_UNVERIFIED", "The withdrawn inventory exceeds the journaled lock credit.");
        acquired += received;
      }
      const debit = inventoryDebit(action);
      if (!debit || debit.token !== token || debit.actor !== actor) continue;
      if (receipt) consumed += debit.amountRaw;
      else if (!inventoryReleased(action)) reserved += debit.amountRaw;
    }
    const available = acquired - consumed - reserved;
    return { token, actor, acquiredRaw: acquired.toString(), consumedRaw: consumed.toString(), reservedRaw: reserved.toString(),
      availableRaw: (available > 0n ? available : 0n).toString(), blocked: available < 0n,
      ...(checkpoint ? { recoveredAtBlock: checkpoint.observedBlockNumber, recoveredBalanceRaw: checkpoint.balanceRaw } : {}) };
  }
  function admitMainnetInventory(value) {
    if (!boundIdentity) return {};
    const expected = value.expected ?? {};
    if (value.steps.some(step => step.nonce !== undefined)) fail("HOSTED_NONCE_UNSUPPORTED", "Circle hosted plans cannot supply an EOA nonce.");
    for (const sender of [expected.actor, ...(value.kind === "launch" ? [expected.operator, ...(mode === "mainnet" ? [expected.treasury] : [])] : []), ...value.steps.map(step => step.from)].filter(sender => sender !== undefined)) {
      if (!sameAddress(sender, boundIdentity.circleWallet)) fail("MANUAL_SIGNER_UNAVAILABLE", "Hosted execution only has a signer for the bound Circle wallet.");
    }
    const debit = inventoryDebit(value);
    if (debit) {
      if (value.kind === "trade" && !sameAddress(expected.currencyIn, debit.token)) fail("INVENTORY_UNVERIFIED", "A sell must spend the journaled token.");
      const current = getInventory(debit.token, debit.actor);
      if (current.blocked || debit.amountRaw > BigInt(current.availableRaw)) fail("INSUFFICIENT_INVENTORY", "This action exceeds unreserved token inventory acquired by verified journal receipts.");
    }
    if (value.kind !== "lock") return {};
    if (!["timed", "permanent", "withdraw"].includes(expected.operation)) fail("INVALID_INPUT", "A lock action requires a supported inventory operation.");
    if (expected.operation === "timed" && !sameAddress(expected.owner, boundIdentity.circleWallet) && !(mode === "mainnet-mvp" && sameAddress(expected.owner, boundIdentity.fundingWallet))) fail("MANUAL_SIGNER_UNAVAILABLE", "Timed locks must be owned by the bound Circle wallet or, in an MVP workspace, the human wallet.");
    if (expected.operation !== "withdraw") return {};
    const actions = listActions();
    const source = verifiedTimedLock(actions, expected);
    if (integer(expected.amountRaw, "withdraw amount") !== integer(source.steps.at(-1).receipt.creditedAmountRaw, "verified locked tokens")) fail("INVENTORY_UNVERIFIED", "Withdrawal must use the full actual credit of the journaled lock.");
    if (actions.some(action => action.inventorySourceActionId === source.id && !inventoryReleased(action))) fail("LOCK_ALREADY_RESERVED", "This journaled lock already has a pending or completed withdrawal.");
    return { inventorySourceActionId: source.id };
  }
  function budget() {
    let spent = 0n;
    let reserved = 0n;
    let blocked = false;
    for (const action of listActions()) {
      if (action.budgetViolation) blocked = true;
      for (const step of action.steps) {
        if (step.settledWei !== undefined) spent += BigInt(step.settledWei);
        else if (step.status !== "not-executed") reserved += BigInt(step.reservedWei);
      }
    }
    const externalFundingFeeWei = db.prepare("SELECT fee_wei FROM external_funding_fees").all().reduce((sum, row) => sum + BigInt(row.fee_wei), 0n);
    spent += externalFundingFeeWei;
    const remaining = limit - spent - reserved;
    return { currency: "USDC", decimals: 18, limitWei: limit.toString(), spentWei: spent.toString(), reservedWei: reserved.toString(),
      remainingWei: (remaining > 0n ? remaining : 0n).toString(), blocked: blocked || remaining < 0n,
      externalFundingFeeWei: externalFundingFeeWei.toString(), ...(boundIdentity ? { experimentId: boundIdentity.experimentId, reservationEnforcement: "application-accounting-only" } : {}) };
  }
  function assertBudget(extra = 0n) {
    const current = budget();
    if (current.blocked) fail("BUDGET_BLOCKED", "An observed transaction exceeded its reserved cost. Reconcile the journal before any further execution.");
    if (BigInt(current.spentWei) + BigInt(current.reservedWei) + extra > limit) fail("BUDGET_EXCEEDED", mainnet
      ? "Principal plus planned network-fee reservations exceeds the cumulative USDC budget."
      : "Principal plus maximum reserved gas exceeds the cumulative USDC budget.");
  }
  /** Trusted engine boundary: verified:true is an attestation, not an RPC proof.
   * The caller must independently verify the canonical receipt and exact USDC
   * funding transfer (or its revert). Only its network fee is a new expense.
   */
  function recordExternalFundingFee(input) {
    if (!mainnet || !boundIdentity) fail("FUNDING_SCOPE_INVALID", "External funding fees require an identity-bound mainnet journal.");
    const value = clean(input);
    if (value.verified !== true || Number(value.chainId) !== boundIdentity.chainId || !/^0x[\da-f]{64}$/i.test(value.hash ?? "") ||
        !/^0x[\da-f]{64}$/i.test(value.blockHash ?? "")) fail("FUNDING_UNVERIFIED", "Canonical verified funding receipt evidence is required.");
    if (typeof value.from !== "string" || typeof value.to !== "string" || value.from.toLowerCase() !== boundIdentity.fundingWallet || value.to.toLowerCase() !== boundIdentity.circleWallet) {
      fail("FUNDING_IDENTITY_CONFLICT", "The funding receipt must match the bound human funding wallet and Circle wallet.");
    }
    const state = value.state ?? "confirmed";
    if (!["confirmed", "reverted"].includes(state)) fail("FUNDING_UNVERIFIED", "Only a canonical confirmed or reverted funding receipt can settle its fee.");
    const amount = integer(value.amountUsdcRaw, "amountUsdcRaw");
    if ((state === "confirmed" && amount <= 0n) || (state === "reverted" && amount !== 0n)) fail("FUNDING_UNVERIFIED", "Funding amount must describe the verified transfer, or zero for a reverted transfer.");
    const fee = integer(value.networkFeeWei, "networkFeeWei");
    const record = { verified: true, hash: value.hash.toLowerCase(), chainId: boundIdentity.chainId, from: boundIdentity.fundingWallet, to: boundIdentity.circleWallet,
      state, amountUsdcRaw: amount.toString(), networkFeeWei: fee.toString(), blockNumber: integer(String(value.blockNumber), "blockNumber").toString(), blockHash: value.blockHash.toLowerCase() };
    return transaction(() => {
      const previous = db.prepare("SELECT json FROM external_funding_fees WHERE hash = ?").get(record.hash);
      if (previous) {
        if (canonical(JSON.parse(previous.json)) !== canonical(record)) fail("FUNDING_RECEIPT_CONFLICT", "Different evidence is already recorded for this funding transaction.");
        return JSON.parse(previous.json);
      }
      const locator = `hash:${record.hash}`;
      if (db.prepare("SELECT action_id FROM submissions WHERE locator = ?").get(locator)) fail("SUBMISSION_REUSED", "This transaction is already accounted for by an action.");
      db.prepare("INSERT INTO submissions VALUES (?, ?, ?)").run(locator, "external-funding-fee", -1);
      db.prepare("INSERT INTO external_funding_fees VALUES (?, ?, ?)").run(record.hash, fee.toString(), JSON.stringify(record));
      // The fee already happened: retain even an overrun, then budget() blocks
      // new execution. Rejecting the record would hide real expenditure.
      return record;
    });
  }
  function prepare(input) {
    const value = clean(input);
    const idem = text(value.idempotencyKey, "idempotencyKey");
    const termsHash = text(value.termsHash, "termsHash");
    text(value.kind, "kind", 64);
    const principal = integer(value.principalRaw, "principalRaw");
    // Caller hashes are not enough: the persisted request terms are compared too.
    const identity = digest({ kind: value.kind, terms: value.terms ?? {}, expected: value.expected ?? {}, principalRaw: value.principalRaw });
    return transaction(() => {
      const previous = db.prepare("SELECT id, terms_hash, identity FROM actions WHERE idem = ?").get(idem);
      if (previous) {
        if (previous.terms_hash !== termsHash || previous.identity !== identity) fail("IDEMPOTENCY_CONFLICT", "This idempotency key already belongs to different immutable terms.");
        return getAction(previous.id);
      }
      if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 16) fail("INVALID_INPUT", "An action needs between one and sixteen ordered transaction steps.");
      const inventoryFields = admitMainnetInventory(value);
      const explicitPrincipal = value.steps.some(step => step.principalRaw !== undefined || step.spendUsdcRaw !== undefined);
      const steps = value.steps.map((step, index) => {
        // Caller transaction metadata cannot inject journal or settlement state.
        for (const key of ["attempt", "hash", "providerId", "receipt", "settledWei", "reason"]) delete step[key];
        const principalRaw = step.principalRaw ?? step.spendUsdcRaw ?? (!explicitPrincipal && index === value.steps.length - 1 ? value.principalRaw : "0");
        let gasReserveWei = step.gasReserveWei;
        if (gasReserveWei === undefined && step.gas !== undefined && step.maxFeePerGas !== undefined) {
          gasReserveWei = (integer(step.gas, "step gas") * integer(step.maxFeePerGas, "step maxFeePerGas")).toString();
        }
        if (gasReserveWei === undefined && value.steps.length === 1) gasReserveWei = value.gasReserveWei ?? (value.gasReserveRaw !== undefined ? (integer(value.gasReserveRaw, "gasReserveRaw") * UNIT).toString() : undefined);
        const gas = integer(gasReserveWei, "step gasReserveWei");
        if (gas === 0n) fail("INVALID_AMOUNT", "Every transaction step needs a positive maximum gas reservation.");
        const spend = integer(principalRaw, "step principalRaw") * UNIT;
        if (step.value !== undefined && integer(step.value, "step value") > spend) fail("INVALID_AMOUNT", "The native value is not covered by this step's principal reservation.");
        return { ...step, index, status: "ready", principalRaw, gasReserveWei: gas.toString(), reservedWei: (spend + gas).toString() };
      });
      if (steps.reduce((sum, step) => sum + BigInt(step.principalRaw), 0n) !== principal) fail("INVALID_AMOUNT", "Step principal amounts must equal the immutable action principal.");
      const gas = steps.reduce((sum, step) => sum + BigInt(step.gasReserveWei), 0n);
      const suppliedGas = value.gasReserveWei ?? (value.gasReserveRaw !== undefined ? (integer(value.gasReserveRaw, "gasReserveRaw") * UNIT).toString() : undefined);
      if (suppliedGas !== undefined && integer(suppliedGas, "gasReserveWei") !== gas) fail("INVALID_AMOUNT", "Total gas reservation must equal the sum of the ordered step reservations.");
      assertBudget(principal * UNIT + gas);
      const now = new Date().toISOString();
      const action = { version: 1, id: randomUUID(), kind: value.kind, idempotencyKey: idem, termsHash,
        terms: value.terms ?? {}, expected: value.expected ?? {}, summary: value.summary ?? {}, ...(value.metadata ? { metadata: value.metadata } : {}),
        principalRaw: value.principalRaw, gasReserveWei: gas.toString(), status: "prepared", createdAt: now, updatedAt: now, steps, ...inventoryFields };
      db.prepare("INSERT INTO actions VALUES (?, ?, ?, ?, ?)").run(action.id, idem, termsHash, identity, JSON.stringify(action));
      return action;
    });
  }
  function cancelAction(id) {
    return transaction(() => {
      const action = getAction(id);
      if (action.status === "cancelled") return action;
      if (action.steps.some(step => inflight.has(step.status))) fail("CANCELLATION_UNSAFE", "An attempted transaction is unresolved. Reconcile it before cancelling any unsubmitted steps.");
      if (!action.steps.some(step => step.status === "ready")) fail("CANCELLATION_UNAVAILABLE", "There are no definitely unsubmitted transaction steps to cancel.");
      for (const step of action.steps) if (step.status === "ready") step.status = "not-executed";
      action.status = "cancelled";
      action.cancelledAt = new Date().toISOString();
      action.cancellationNote = "Only unsubmitted steps were cancelled. Confirmed approvals, fees and transaction evidence remain recorded; reuse does not replay this action.";
      return write(action);
    });
  }
  function reserveExecution(id, { resume = false } = {}) {
    return transaction(() => {
      const action = getAction(id);
      assertBudget();
      if (!["prepared", "executing"].includes(action.status) || action.steps.some(step => inflight.has(step.status))) fail("ACTION_LOCKED", "An unresolved or completed action cannot start another execution. Reconcile existing evidence without resubmitting.");
      if (action.leaseId && !resume) fail("EXECUTION_LEASED", "Another execution already holds this action's durable lease.");
      action.leaseId = randomUUID();
      action.leaseAcquiredAt = new Date().toISOString();
      action.status = "executing";
      return write(action);
    });
  }
  function selected(action, index) {
    if (!Number.isInteger(index) || !action.steps[index]) fail("STEP_NOT_FOUND", "The requested transaction step does not exist.");
    return action.steps[index];
  }
  function beforeSubmit(id, index, { attemptId, from, nonce, blockNumber, leaseId } = {}) {
    text(attemptId, "attemptId"); text(from, "from");
    if (!/^0x[\da-f]{40}$/i.test(from)) fail("INVALID_INPUT", "A transaction sender address is required.");
    const sender = from.toLowerCase();
    const normalizedNonce = nonce !== undefined ? integer(String(nonce), "nonce").toString() : undefined;
    const preparedBlock = blockNumber !== undefined ? integer(String(blockNumber), "blockNumber").toString() : undefined;
    if (boundIdentity && sender !== boundIdentity.circleWallet) fail("MANUAL_SIGNER_UNAVAILABLE", "Hosted execution only has a signer for the bound Circle wallet.");
    if (boundIdentity && normalizedNonce !== undefined) fail("HOSTED_NONCE_UNSUPPORTED", "Circle hosted submissions cannot reserve or supply an EOA nonce.");
    return transaction(() => {
      const action = getAction(id);
      assertBudget();
      if (!leaseId || action.leaseId !== leaseId) fail("LEASE_MISMATCH", "This executor does not hold the current action lease.");
      const step = selected(action, index);
      if (action.status !== "executing" || step.status !== "ready" || action.steps.find(candidate => candidate.status !== "confirmed")?.index !== index) fail("STEP_LOCKED", "The step has already been attempted or its prerequisite is unconfirmed. It cannot be resubmitted.");
      if (boundIdentity) {
        if (step.from && !sameAddress(step.from, sender)) fail("SENDER_MISMATCH", "The submitting wallet differs from the prepared sender.");
        const pending = listActions().some(previous => previous.steps.some(candidate => inflight.has(candidate.status) && sameAddress(candidate.attempt?.from, sender)));
        if (pending) fail("SENDER_INFLIGHT", "This Circle sender already has an unresolved submission. Reconcile it before submitting another action.");
      }
      if (db.prepare("SELECT id FROM attempts WHERE id = ?").get(attemptId)) fail("ATTEMPT_REUSED", "This submission attempt already belongs to an action.");
      if (normalizedNonce !== undefined) {
        const chainId = String(action.terms.chainId ?? action.expected.chainId ?? "unspecified");
        const claimed = db.prepare("SELECT action_id FROM nonce_claims WHERE chain_id = ? AND sender = ? AND nonce = ?").get(chainId, sender, normalizedNonce);
        // Retain compatibility with journals written before the nonce index existed.
        const historical = listActions().some(previous => String(previous.terms.chainId ?? previous.expected.chainId ?? "unspecified") === chainId &&
          previous.steps.some(candidate => candidate.attempt?.from?.toLowerCase() === sender && candidate.attempt.nonce !== undefined && BigInt(candidate.attempt.nonce).toString() === normalizedNonce));
        if (claimed || historical) fail("NONCE_CONFLICT", "This sender nonce already belongs to a recorded attempt. Reconcile that transaction; do not replace or resend it.");
        db.prepare("INSERT INTO nonce_claims VALUES (?, ?, ?, ?, ?)").run(chainId, sender, normalizedNonce, id, index);
      }
      db.prepare("INSERT INTO attempts VALUES (?, ?, ?)").run(attemptId, id, index);
      step.attempt = { id: attemptId, from: sender, ...(normalizedNonce !== undefined ? { nonce: normalizedNonce } : {}),
        ...(preparedBlock !== undefined ? { blockNumber: preparedBlock } : {}), startedAt: new Date().toISOString() };
      step.status = "submitting";
      action.status = "submitting";
      return write(action);
    });
  }
  function submitted(id, index, input = {}) {
    const { hash, providerId, attemptId } = input;
    if (!hash && !providerId) fail("SUBMISSION_EVIDENCE_REQUIRED", "A transaction hash or provider transaction ID is required.");
    if (hash && !/^0x[\da-f]{64}$/i.test(hash)) fail("INVALID_INPUT", "The transaction hash is invalid.");
    if (providerId) text(providerId, "providerId");
    return transaction(() => {
      const action = getAction(id);
      const step = selected(action, index);
      if (!step.attempt || ![...inflight, "confirmed", "reverted"].includes(step.status)) fail("STEP_NOT_ATTEMPTED", "Record an attempt before recording its submission evidence.");
      if (attemptId && step.attempt.id !== attemptId) fail("ATTEMPT_CONFLICT", "Submission evidence belongs to a different attempt.");
      for (const [field, value] of [["hash", hash?.toLowerCase()], ["providerId", providerId]]) {
        if (!value) continue;
        if (step[field] && step[field] !== value) fail("SUBMISSION_CONFLICT", "A different submission is already recorded for this step.");
        const locator = `${field}:${value}`;
        const used = db.prepare("SELECT action_id, step_index FROM submissions WHERE locator = ?").get(locator);
        if (used && (used.action_id !== id || Number(used.step_index) !== index)) fail("SUBMISSION_REUSED", "This submission already belongs to another step.");
        db.prepare("INSERT OR IGNORE INTO submissions VALUES (?, ?, ?)").run(locator, id, index);
        step[field] = value;
      }
      if (inflight.has(step.status)) { step.status = "submitted"; action.status = "submitted"; }
      return write(action);
    });
  }
  function markUnknown(id, index, reason = "Submission outcome is unknown. Reconcile existing evidence; do not send again.") {
    return transaction(() => {
      const action = getAction(id);
      const step = selected(action, index);
      if (!step.attempt || !inflight.has(step.status)) fail("STEP_LOCKED", "Only an unresolved attempted transaction can become unknown.");
      step.status = "unknown"; step.reason = text(reason, "reason", 1024); action.status = "unknown";
      return write(action);
    });
  }
  function confirmStep(id, index, evidence) {
    const receipt = clean(evidence);
    const state = receipt.state === "success" ? "confirmed" : receipt.state;
    if (!receipt.verified || !["confirmed", "reverted"].includes(state)) fail("RECEIPT_UNVERIFIED", "A caller-verified canonical confirmed or reverted receipt is required.");
    const fee = integer(receipt.networkFeeWei, "networkFeeWei");
    return transaction(() => {
      const action = getAction(id);
      const step = selected(action, index);
      if (!step.attempt || (!step.hash && !step.providerId)) fail("SUBMISSION_EVIDENCE_REQUIRED", "Persist transaction or provider evidence before settling its receipt.");
      if (receipt.hash && receipt.hash.toLowerCase() !== step.hash) fail("RECEIPT_CONFLICT", "The receipt hash does not match the recorded submission.");
      if (receipt.providerId && receipt.providerId !== step.providerId) fail("RECEIPT_CONFLICT", "The receipt provider ID does not match the recorded submission.");
      if (["confirmed", "reverted"].includes(step.status)) {
        if (digest(step.receipt) !== digest({ ...receipt, state })) fail("RECEIPT_CONFLICT", "A different terminal receipt is already recorded.");
        return action;
      }
      if (!inflight.has(step.status)) fail("STEP_LOCKED", "This step cannot accept receipt settlement.");
      const cost = fee + (state === "confirmed" ? BigInt(step.principalRaw) * UNIT : 0n);
      step.receipt = { ...receipt, state };
      step.settledWei = cost.toString();
      const envelopeExceeded = (receipt.gasLimit !== undefined && step.gas !== undefined && integer(receipt.gasLimit, "gasLimit") > BigInt(step.gas)) ||
        (receipt.maxFeePerGas !== undefined && step.maxFeePerGas !== undefined && integer(receipt.maxFeePerGas, "maxFeePerGas") > BigInt(step.maxFeePerGas));
      if (fee > BigInt(step.gasReserveWei) || cost > BigInt(step.reservedWei) || envelopeExceeded) {
        action.budgetViolation = true; action.status = "blocked"; step.status = state;
      } else {
        step.status = state;
        if (state === "reverted") {
          action.status = "reverted";
          for (const later of action.steps.slice(index + 1)) {
            if (later.status !== "ready") fail("STEP_ORDER", "A later step was issued before its prerequisite completed.");
            later.status = "not-executed";
          }
        } else action.status = action.steps.every(candidate => candidate.status === "confirmed") ? "confirmed" : "executing";
      }
      delete step.reason;
      return write(action);
    });
  }
  function reconcileStep(id, index, evidence = {}) {
    if (evidence.hash || evidence.providerId) submitted(id, index, evidence);
    return evidence.state ? confirmStep(id, index, evidence) : getAction(id);
  }
  function saveProject(input) {
    const record = clean(input);
    if (record.verified !== true) fail("PROJECT_UNVERIFIED", "Only a verified launch record can be published in the local project list.");
    if (!/^0x[\da-f]{40}$/i.test(record.token ?? "")) fail("INVALID_INPUT", "A verified token address is required.");
    return transaction(() => {
      const action = getAction(record.launchActionId);
      const launch = action.steps.at(-1);
      const token = launch.receipt?.tokenAddress ?? launch.receipt?.token;
      if (action.kind !== "launch" || action.status !== "confirmed" || launch.status !== "confirmed" || !token || token.toLowerCase() !== record.token.toLowerCase() ||
          !launch.hash || launch.hash !== record.launchTxHash?.toLowerCase()) fail("PROJECT_UNVERIFIED", "The project must match this journal's verified successful launch receipt.");
      const chainId = String(record.chainId);
      const expectedChain = action.terms.chainId ?? action.expected.chainId;
      if (!/^\d+$/.test(chainId) || (expectedChain !== undefined && String(expectedChain) !== chainId)) fail("PROJECT_UNVERIFIED", "The project chain does not match the saved launch.");
      const previous = db.prepare("SELECT json FROM projects WHERE token = ? AND chain_id = ?").get(record.token.toLowerCase(), chainId);
      if (previous) {
        const saved = JSON.parse(previous.json);
        if (mode === "mainnet-mvp" && saved.launchActionId === record.launchActionId && sameAddress(saved.launchTxHash, record.launchTxHash)) return saved;
        if (digest(saved) !== digest(record)) fail("PROJECT_CONFLICT", "A different verified record already exists for this token.");
        return JSON.parse(previous.json);
      }
      db.prepare("INSERT INTO projects VALUES (?, ?, ?)").run(record.token.toLowerCase(), chainId, JSON.stringify(record));
      return record;
    });
  }
  /** Trusted current-state verifier boundary. Token inventory never replenishes the USDC budget. */
  function saveRecoveredPosition(input) {
    if (mode !== "mainnet-mvp") fail("POSITION_RECOVERY_UNSUPPORTED", "Position recovery is available only in an independent MVP workspace.");
    const record = clean(input);
    if (record.verified !== true || record.source !== "canonical-position-snapshot" || record.chainId !== 5042 ||
        !sameAddress(record.actor, boundIdentity.circleWallet) || !/^0x[\da-f]{64}$/i.test(record.observedBlockHash ?? "")) fail("POSITION_UNVERIFIED", "A canonical balance snapshot for the configured Circle wallet is required.");
    const token = inventoryAddress(record.token, "Recovered token");
    const actor = inventoryAddress(record.actor, "Recovered actor");
    integer(record.balanceRaw, "recovered balance");
    const blockNumber = integer(record.observedBlockNumber, "recovery block");
    return transaction(() => {
      if (!db.prepare("SELECT token FROM projects WHERE token = ? AND chain_id = '5042'").get(token)) fail("PROJECT_UNVERIFIED", "Import the verified project before its position.");
      const actions = listActions();
      if (actions.some(action => !["confirmed", "reverted", "cancelled"].includes(action.status) || action.steps.some(step => inflight.has(step.status)))) fail("POSITION_ACTIONS_UNRESOLVED", "Finish or reconcile all existing actions before recovering current inventory. Recovery never discards pending reservations.");
      if (actions.some(action => action.steps.some(step => step.receipt?.blockNumber !== undefined && integer(String(step.receipt.blockNumber), "receipt block") > blockNumber))) fail("POSITION_STALE", "The recovered snapshot predates a retained action receipt.");
      const saved = db.prepare("SELECT json FROM recovered_positions WHERE token = ? AND actor = ?").get(token, actor);
      if (saved && BigInt(JSON.parse(saved.json).observedBlockNumber) > blockNumber) fail("POSITION_STALE", "The recovered snapshot predates the retained inventory checkpoint.");
      const checkpoint = { ...record, includedActionIds: actions.map(action => action.id) };
      if (record.lock) {
        const lock = record.lock;
        const deployment = inventoryAddress(lock.deployment, "Lock deployment");
        const lockId = integer(lock.lockId, "lockId").toString();
        if (deployment !== "0xfee1d11d4501d66d8ea1024dc198ee5663c2bf6b" || !sameAddress(lock.token, token) || lock.withdrawn !== false || integer(lock.amountRaw, "locked amount") <= 0n) fail("POSITION_UNVERIFIED", "Recovery requires a live lock in the supported deployment.");
        inventoryAddress(lock.owner, "Lock owner"); integer(lock.unlockAt, "unlock timestamp");
        const value = { ...lock, verified: true, observedBlockNumber: record.observedBlockNumber, observedBlockHash: record.observedBlockHash };
        db.prepare("INSERT INTO recovered_locks VALUES (?, ?, ?) ON CONFLICT(deployment, lock_id) DO UPDATE SET json = excluded.json").run(deployment, lockId, JSON.stringify(value));
      }
      db.prepare("INSERT INTO recovered_positions VALUES (?, ?, ?) ON CONFLICT(token, actor) DO UPDATE SET json = excluded.json").run(token, actor, JSON.stringify(checkpoint));
      return record;
    });
  }
  /** Trusted verifier boundary. References never create actions, spend authority or token inventory. */
  function saveImportedProject(input) {
    const record = clean(input);
    if (mode !== "mainnet-mvp") fail("PROJECT_IMPORT_UNSUPPORTED", "Project import is available in an independently initialized MVP workspace.");
    if (record.verified !== true || record.source !== "canonical-launch-receipt" || record.chainId !== 5042 ||
        !/^0x[\da-f]{40}$/i.test(record.token ?? "") || !/^0x[\da-f]{64}$/i.test(record.launchTxHash ?? "") ||
        !/^0x[\da-f]{64}$/i.test(record.launchBlockHash ?? "") || !/^\d+$/.test(record.launchBlock ?? "") ||
        record.launchActionId !== undefined || !/^\d+$/.test(record.observedBlockNumber ?? "")) {
      fail("PROJECT_UNVERIFIED", "An independently verified canonical launch receipt and current role snapshot are required.");
    }
    for (const field of ["operator", "controller", "portal"]) inventoryAddress(record[field], field);
    if (record.version === "v1") {
      const portal = PORTALS.find(item => sameAddress(item.address, record.portal));
      if (!portal || portal.generation !== record.portalGeneration || portal.line !== record.line
        || record.creatorRegistry !== null || record.escrow !== null)
        fail("PROJECT_UNVERIFIED", "A V1 project must name its supported historical deployment without V2 authority contracts.");
      for (const field of portal.line === "legacy" ? ["processor", "pool"] : ["hook", "splitter"])
        inventoryAddress(record[field], field);
    } else {
      if (record.version !== undefined && record.version !== "v2") fail("PROJECT_UNVERIFIED", "Unsupported project version.");
      for (const field of ["creatorRegistry", "hook", "escrow"]) inventoryAddress(record[field], field);
    }
    return transaction(() => {
      const previous = db.prepare("SELECT json FROM projects WHERE token = ? AND chain_id = ?").get(record.token.toLowerCase(), "5042");
      if (previous) {
        const saved = JSON.parse(previous.json);
        if (!sameAddress(saved.launchTxHash, record.launchTxHash) || saved.launchBlock !== record.launchBlock ||
            (saved.launchBlockHash && !sameAddress(saved.launchBlockHash, record.launchBlockHash))) fail("PROJECT_CONFLICT", "A different launch is already registered for this token.");
        // Preserve local action provenance when the same project is reverified.
        const updated = { ...saved, ...record, ...(saved.launchActionId ? { launchActionId: saved.launchActionId } : {}) };
        db.prepare("UPDATE projects SET json = ? WHERE token = ? AND chain_id = ?").run(JSON.stringify(updated), record.token.toLowerCase(), "5042");
        return updated;
      }
      if (Number(db.prepare("SELECT count(*) AS count FROM projects").get().count) >= 1000) fail("PROJECT_LIMIT", "A workspace supports at most 1000 saved projects.");
      db.prepare("INSERT INTO projects VALUES (?, ?, ?)").run(record.token.toLowerCase(), "5042", JSON.stringify(record));
      return record;
    });
  }
  const listProjects = () => db.prepare("SELECT json FROM projects ORDER BY rowid").all().map(row => JSON.parse(row.json));
  return { filename, prepare, cancelAction, getAction, getByIdempotencyKey, listActions, reserveExecution, beforeSubmit, submitted, confirmStep, markUnknown,
    reconcileStep, reconcile: reconcileStep, saveProject, saveImportedProject, saveRecoveredPosition, listProjects, getInventory, budget, recordExternalFundingFee, close: () => db.close() };
}
