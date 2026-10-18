import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, parseAbi, parseUnits } from 'viem';
import { CIRCLE_BATCH_ABI } from '../scripts/argus-agent/batch.mjs';
import { validateOperation } from '../scripts/argus-agent/catalog.mjs';
import { createArgusAgent } from '../scripts/argus-agent/sdk.mjs';
import { createStore } from '../scripts/argus-agent/store.mjs';
import { CURRENT_TIME_LOCK } from '../scripts/argus-agent/locks.mjs';
import { PORTALS } from '../scripts/argus-agent/generated/addresses.mjs';
import { poolIdFor, poolKeyFor } from '../scripts/argus-agent/generated/pool.mjs';
import { legacySelfClaimAbi, legacySplitterAbi } from '../scripts/argus-agent/legacy-contracts.mjs';

const bundle = JSON.parse(readFileSync(new URL('../scripts/argus-agent/vendor/argus-v4.json', import.meta.url), 'utf8'));
const addresses = bundle.portal8.addresses;
const portalAbi = bundle.portal8.contracts.ArgusV5Portal.abi;
const transferAbi = parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const timeLockAbi = parseAbi(['event Locked(uint256 indexed id,address indexed token,address indexed owner,address depositor,uint256 amount,uint64 unlockAt)', 'event Withdrawn(uint256 indexed id,address indexed token,address indexed owner,uint256 amount)']);
const vaultAbi = parseAbi(['event Locked(address indexed token,address indexed from,uint256 delta,uint256 totalLocked)']);
const CIRCLE = `0x${'11'.repeat(20)}`;
const HUMAN = `0x${'22'.repeat(20)}`;
const TOKEN = `0x${'33'.repeat(20)}`;
const HOOK = `0x${'44'.repeat(20)}`;
const ESCROW = `0x${'55'.repeat(20)}`;
const BUNDLER = `0x${'66'.repeat(20)}`;
const hash = value => `0x${BigInt(value).toString(16).padStart(64, '0')}`;
const request = key => ({ idempotencyKey: key, seedUsdc: '4.5', brand: { name: 'Fixture', symbol: 'FIX', description: 'Isolated test', imageURI: 'ipfs://fixture' } });
const event = (address, abi, eventName, args) => {
  const entry = abi.find(item => item.type === 'event' && item.name === eventName);
  const fields = entry.inputs.filter(item => !item.indexed);
  return { address, topics: encodeEventTopics({ abi, eventName, args }), data: encodeAbiParameters(fields, fields.map(item => args[item.name])) };
};
const transfer = (token, from, to, value) => event(token, transferAbi, 'Transfer', { from, to, value });

async function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'argus-mainnet-sdk-fixture-'));
  const config = { mode: options.mode ?? 'mainnet', executionEnabled: true, chainId: 5042, rpcUrl: 'https://rpc.mainnet.arc.io', stateDir: directory,
    budgetUsdcRaw: '10000000', identity: { experimentId: 'isolated-mainnet-sdk-fixture', chainId: 5042, circleWallet: CIRCLE, fundingWallet: HUMAN },
    actors: { operator: CIRCLE, controller: HUMAN, treasury: options.treasury ?? CIRCLE }, executor: { kind: 'circle-hosted' } };
  const store = createStore(directory, { mode: config.mode, initialization: 'create', identity: config.identity });
  const agents = [];
  t.after(() => { agents.forEach(agent => agent.close()); store.close(); rmSync(directory, { recursive: true, force: true }); });
  let blockNumber = 100n;
  let nextCall = 0;
  const plans = new Map();
  const receipts = new Map();
  const sends = [];
  const estimates = [];
  const records = new Map();
  let vaultTotal = 0n;
  const client = {
    getChainId: async () => 5042,
    getBlockNumber: async () => blockNumber,
    getBlock: async () => ({ number: blockNumber, hash: hash(blockNumber), timestamp: 1000n }),
    getBalance: async () => parseUnits('9.9', 18),
    getTransactionCount: async () => { throw new Error('EOA nonce must never be requested for Circle SCA'); },
    call: async input => { assert.equal(input.gas, undefined); return { data: '0x' }; },
    waitForTransactionReceipt: async ({ hash: id }) => receipts.get(id),
    readContract: async ({ functionName, args }) => functionName === 'getLock' ? records.get(String(args[0])) : functionName === 'locked' ? vaultTotal : HUMAN,
    ...options.client,
  };
  function plan(expected, spendUsdcRaw = '0', approve = false, calldata) {
    const steps = Array.from({ length: typeof approve === 'number' ? approve + 1 : approve ? 2 : 1 }, () => ({ to: addresses.portal, data: calldata ?? `0x${(++nextCall).toString(16).padStart(8, '0')}`, value: '0', abi: [] }));
    const value = { steps, expected, summary: { spendUsdcRaw } };
    plans.set(steps.at(-1).data, value);
    return value;
  }
  const contracts = {
    prepareProject: async input => plan({ chainId: 5042, operator: input.operator, controller: input.controller, treasury: input.treasury,
      seedUsdcRaw: parseUnits(input.seedUsdc, 6).toString(), hook: HOOK, escrow: ESCROW, brand: input.brand }, parseUnits(input.seedUsdc, 6).toString(), true),
    readProject: async () => ({ controller: HUMAN, proposed: HUMAN, split: [] }),
    prepareTrade: async input => plan({ token: input.token, actor: input.actor, side: input.side, amountInRaw: input.side === 'buy' ? parseUnits(input.amountIn, 6).toString() : input.amountIn,
      currencyIn: input.side === 'buy' ? addresses.defaultQuoteAsset : TOKEN, currencyOut: input.side === 'buy' ? TOKEN : addresses.defaultQuoteAsset,
      minimumAmountOutRaw: '1' }, input.side === 'buy' ? parseUnits(input.amountIn, 6).toString() : '0', options.tradeApprovals ?? 2),
    prepareManagement: async () => { throw new Error('Human controller must never reach hosted planner'); },
  };
  const locks = {
    prepareTimeLock: async input => plan({ ...input, deployment: CURRENT_TIME_LOCK, owner: input.beneficiary, unlockAt: input.unlockAt }, '0', true),
    preparePermanentLock: async input => plan({ ...input, deployment: addresses.lockVault, lockedBeforeRaw: vaultTotal.toString() }, '0', true),
    prepareWithdraw: async input => plan({ ...input, deployment: CURRENT_TIME_LOCK, owner: input.actor, recipient: input.actor }),
  };
  function expectedPlan(tx) {
    if (tx.to.toLowerCase() !== CIRCLE) return plans.get(tx.data);
    const decoded = decodeFunctionData({ abi: CIRCLE_BATCH_ABI, data: tx.data });
    return plans.get(decoded.args[0].at(-1).data);
  }
  function mine(tx) {
    const id = hash(++blockNumber);
    const expected = expectedPlan(tx)?.expected;
    let logs = [];
    if (expected?.seedUsdcRaw) logs = [
      event(addresses.portal, portalAbi, 'Launched', { token: TOKEN, creator: CIRCLE, hook: HOOK, escrow: ESCROW, locker: CURRENT_TIME_LOCK, positionId: 1n, tickStart: -100, tickBond: 100 }),
      event(addresses.portal, portalAbi, 'LaunchMetadata', { token: TOKEN, ...expected.brand }),
      event(addresses.portal, portalAbi, 'BundleBought', { token: TOKEN, wallets: 1n, quoteIn: BigInt(expected.seedUsdcRaw), tokensOut: 500n }),
      transfer(TOKEN, addresses.portal, expected.treasury, 500n),
    ];
    else if (expected?.side) logs = [transfer(expected.currencyOut, addresses.portal, CIRCLE, expected.side === 'buy' ? 100n : 1_000_000n)];
    else if (expected?.operation === 'timed') {
      const amount = BigInt(expected.amountRaw) - 1n;
      records.set('1', { token: TOKEN, owner: expected.owner, amount, unlockAt: BigInt(expected.unlockAt), withdrawn: false });
      logs = [event(CURRENT_TIME_LOCK, timeLockAbi, 'Locked', { id: 1n, token: TOKEN, owner: expected.owner, depositor: CIRCLE, amount, unlockAt: BigInt(expected.unlockAt) }), transfer(TOKEN, CIRCLE, CURRENT_TIME_LOCK, BigInt(expected.amountRaw))];
    } else if (expected?.operation === 'permanent') {
      const delta = BigInt(expected.amountRaw) - 1n; vaultTotal += delta;
      logs = [event(addresses.lockVault, vaultAbi, 'Locked', { token: TOKEN, from: CIRCLE, delta, totalLocked: vaultTotal }), transfer(TOKEN, CIRCLE, addresses.lockVault, BigInt(expected.amountRaw))];
    } else if (expected?.operation === 'withdraw') {
      const record = records.get(expected.lockId); record.withdrawn = true;
      logs = [event(CURRENT_TIME_LOCK, timeLockAbi, 'Withdrawn', { id: BigInt(expected.lockId), token: TOKEN, owner: CIRCLE, amount: record.amount }), transfer(TOKEN, CURRENT_TIME_LOCK, CIRCLE, record.amount - 1n)];
    }
    const receipt = { status: 'success', transactionHash: id, blockNumber, blockHash: hash(blockNumber), logs };
    options.changeReceipt?.(receipt, expected);
    receipts.set(id, receipt);
    return { status: 'submitted', hash: id };
  }
  const executor = {
    preflight: async () => ({ ready: true }),
    estimate: async tx => {
      estimates.push(tx);
      return { ok: true, chainId: 5042, account: tx.account, calldataHash: keccak256(tx.data), fees: { networkFee: typeof options.feeEstimate === 'function' ? options.feeEstimate(expectedPlan(tx)?.expected) : options.feeEstimate ?? '0.01' } };
    },
    execute: async tx => { sends.push(tx); return options.execute ? options.execute(tx, mine) : mine(tx); },
    ...options.executor,
  };
  const verifier = async (_client, { hash: id, action, step }) => {
    const receipt = receipts.get(id);
    if (!receipt) throw Object.assign(new Error('Pending'), { name: 'TransactionReceiptNotFoundError' });
    const result = { verified: true, state: options.revertStep === step.index ? 'reverted' : 'confirmed', hash: id,
      networkFeeWei: parseUnits(options.actualFee ?? '0.01', 18).toString(), blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash,
      receipt, transaction: { from: BUNDLER, to: addresses.portal }, feeAccounting: 'conservative-user-operation-cost' };
    return options.verify ? options.verify(result, action, step) : result;
  };
  async function connect(override = {}, dependencies = {}) {
    const agent = await createArgusAgent({ ...config, ...override }, { client, contracts, locks, executor, verifyCircleSCAReceipt: verifier, readIntervalMs: 0, ...dependencies });
    agents.push(agent); return agent;
  }
  const agent = await connect();
  return { agent, config, store, client, contracts, executor, sends, estimates, receipts, records, connect, plan };
}
async function prepare(h, key = 'mainnet-project-fixture') {
  const result = await h.agent.dispatch('argus_prepare_project', request(key));
  assert.equal(result.error, undefined, JSON.stringify(result)); return result.action;
}
const execute = (h, action) => h.agent.dispatch('argus_execute_action', { actionId: action.id });
async function launch(h) { const action = await prepare(h); const result = await execute(h, action); assert.equal(result.error, undefined, JSON.stringify(result)); return action; }

// Every wallet/RPC operation below is an injected fixture; only temporary SQLite files are real.
test('mainnet requires explicit enablement, official HTTPS RPC, exact roles, executor, chain and retained identity', async t => {
  const h = await fixture(t);
  for (const [override, code] of [
    [{ executionEnabled: false }, 'ARGUS_EXECUTION_DISABLED'], [{ executionEnabled: undefined }, 'ARGUS_EXECUTION_DISABLED'],
    [{ rpcUrl: 'http://rpc.mainnet.arc.io' }, 'ARGUS_RPC_UNSAFE'], [{ rpcUrl: 'https://rpc.mainnet.arc.io.evil.invalid' }, 'ARGUS_RPC_UNSAFE'],
    [{ rpcUrl: 'https://rpc.mainnet.arc.io/?token=secret' }, 'ARGUS_RPC_UNSAFE'], [{ rpcUrl: 'https://user@rpc.mainnet.arc.io' }, 'ARGUS_RPC_UNSAFE'],
    [{ chainId: 1 }, 'ARGUS_CONFIG_UNSAFE'], [{ budgetUsdcRaw: '10000001' }, 'ARGUS_CONFIG_UNSAFE'], [{ budgetUsdcRaw: '100000000' }, 'ARGUS_CONFIG_UNSAFE'], [{ executor: { kind: 'anvil' } }, 'ARGUS_CONFIG_UNSAFE'],
    [{ actors: { ...h.config.actors, treasury: HUMAN } }, 'ARGUS_ROLES_INVALID'], [{ identity: { ...h.config.identity, experimentId: 'another-experiment' } }, 'STATE_IDENTITY_CONFLICT'],
  ]) await assert.rejects(h.connect(override), error => { assert.equal(error.code, code); return true; });
  await assert.rejects(h.connect({ stateDir: join(h.config.stateDir, 'missing') }), error => /missing|exist|initialized/i.test(error.message));
  assert.equal(h.sends.length, 0);
});

test('QuickNode is an explicit allowlisted origin with the same strict URL guards', async t => {
  const h = await fixture(t);
  const configured = await h.connect({ rpcUrl: 'https://rpc.quicknode.mainnet.arc.io' });
  assert.equal(configured.evidence().identity.experimentId, h.config.identity.experimentId);
  for (const rpcUrl of ['https://rpc.quicknode.mainnet.arc.io.evil.invalid', 'https://rpc.quicknode-mainnet.arc.io',
    'http://rpc.quicknode.mainnet.arc.io', 'https://rpc.quicknode.mainnet.arc.io/path', 'https://rpc.quicknode.mainnet.arc.io/?token=secret',
    'https://user@rpc.quicknode.mainnet.arc.io', 'https://rpc.quicknode.mainnet.arc.io:8443', 'https://rpc.quicknode.mainnet.arc.io/#fragment']) {
    await assert.rejects(h.connect({ rpcUrl }), { code: 'ARGUS_RPC_UNSAFE' });
  }
  assert.equal(h.sends.length, 0);
});

test('mainnet hosted launch shares one budget, preserves human control and never passes EOA gas or nonce fields', async t => {
  const h = await fixture(t); const action = await prepare(h);
  assert.equal(h.agent.evidence().coverage.mainnetTransactions, false);
  assert.equal(h.agent.evidence().coverage.mainnetExecutionMode, true);
  assert.equal(action.gasReserveWei, parseUnits('0.75', 18).toString());
  assert.equal(action.expected.controller.toLowerCase(), HUMAN);
  const result = await execute(h, action);
  assert.equal(result.error, undefined, JSON.stringify(result)); assert.equal(result.action.status, 'confirmed');
  assert.equal(result.budget.spentWei, parseUnits('4.52', 18).toString());
  assert.equal(result.coverage.exactFeeCeiling, false); assert.equal(result.coverage.mainnetTransactions, true);
  assert.equal(h.sends.length, 2); assert.equal(h.estimates.length, 2);
  for (const tx of [...h.sends, ...h.estimates]) for (const field of ['nonce', 'gas', 'gasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas']) assert.equal(tx[field], undefined);
  const restarted = await h.connect();
  const replay = await restarted.dispatch('argus_prepare_project', request('mainnet-project-fixture'));
  assert.equal(replay.action.id, action.id); assert.equal(replay.budget.spentWei, result.budget.spentWei);
  assert.equal((await restarted.dispatch('argus_execute_action', { actionId: action.id })).action.status, 'confirmed'); assert.equal(h.sends.length, 2);
  assert.equal(h.store.getInventory(TOKEN, CIRCLE).availableRaw, '500');
});

test('hosted estimates and native USDC balance refuse before durably creating any submission', async t => {
  for (const [options, code] of [ [{ feeEstimate: '0.041' }, 'ARGUS_FEE_CHANGED'], [{ feeEstimate: '0.0000000000000000001' }, 'ARGUS_FEE_UNAVAILABLE'],
    [{ client: { getBalance: async () => parseUnits('5.24', 18) } }, 'ARGUS_BALANCE_INSUFFICIENT'] ]) {
    await t.test(code, async t => { const h = await fixture(t, options); const action = await prepare(h); const result = await execute(h, action);
      assert.equal(result.error.code, code); assert.equal(h.sends.length, 0); assert.equal(h.store.getAction(action.id).steps[0].attempt, undefined); });
  }
});

test('unknown hosted submission cannot be scanned by EOA nonce, retried or bypassed with another action', async t => {
  const h = await fixture(t); await launch(h);
  h.executor.execute = async tx => { h.sends.push(tx); return { status: 'unknown' }; };
  const trade = key => h.agent.dispatch('argus_prepare_trade', { idempotencyKey: key, token: TOKEN, side: 'buy', amountIn: '0.1' });
  const first = (await trade('unknown-mainnet-buy')).action; await execute(h, first);
  const restarted = await h.connect();
  assert.equal((await restarted.dispatch('argus_execute_action', { actionId: first.id })).error.code, 'ARGUS_OUTCOME_UNKNOWN');
  const second = (await trade('another-mainnet-buy')).action;
  assert.ok((await execute(h, second)).error); assert.equal(h.sends.length, 3);
  assert.equal(h.store.getAction(first.id).steps[0].status, 'unknown');
});

test('hosted receipt envelope refusal preserves reservation and fee overrun freezes further actions', async t => {
  for (const options of [{ verify: result => ({ ...result, verified: false }) }, { actualFee: '0.051' }]) await t.test(JSON.stringify(options), async t => {
    const h = await fixture(t, options); const action = await prepare(h); const result = await execute(h, action);
    assert.equal(h.sends.length, 1);
    if (options.actualFee) { assert.equal(result.action.status, 'blocked'); assert.equal(h.store.budget().blocked, true); }
    else { assert.ok(result.error); assert.equal(h.store.getAction(action.id).steps[0].status, 'unknown'); }
  });
});

test('inner SCA revert overrides outer successful receipt and never credits acquisition inventory', async t => {
  const h = await fixture(t, { revertStep: 1 }); const action = await prepare(h); const result = await execute(h, action);
  assert.equal(result.action.status, 'reverted'); assert.equal(result.budget.spentWei, parseUnits('0.02', 18).toString());
  assert.equal(h.store.getInventory(TOKEN, CIRCLE).availableRaw, '0');
});

test('controller operations require the unavailable manual signer; sells reserve only confirmed pilot token units', async t => {
  const h = await fixture(t); await launch(h);
  const managed = await h.agent.dispatch('argus_prepare_management', { idempotencyKey: 'human-controller-fixture', token: TOKEN, operation: 'propose_owner', newController: CIRCLE });
  assert.equal(managed.error.code, 'ARGUS_MANUAL_SIGNER_UNAVAILABLE');
  const sell = await h.agent.dispatch('argus_prepare_trade', { idempotencyKey: 'sell-pilot-inventory', token: TOKEN, side: 'sell', amountIn: '400' });
  assert.equal(sell.error, undefined, JSON.stringify(sell));
  const excessive = await h.agent.dispatch('argus_prepare_trade', { idempotencyKey: 'sell-inventory-again', token: TOKEN, side: 'sell', amountIn: '101' });
  assert.ok(excessive.error); assert.equal(h.store.getInventory(TOKEN, CIRCLE).availableRaw, '100');
  const result = await execute(h, sell.action); assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(result.budget.spentWei, parseUnits('4.53', 18).toString());
  assert.equal(h.store.getInventory(TOKEN, CIRCLE).availableRaw, '100');
});

test('timed/permanent locks reserve journal units; withdrawal credits only actual returned token units', async t => {
  const h = await fixture(t); await launch(h);
  const timed = await h.agent.dispatch('argus_prepare_lock', { idempotencyKey: 'timed-lock-fixture', token: TOKEN, operation: 'timed', amountRaw: '100', unlockAt: '1400' });
  assert.equal(timed.error, undefined, JSON.stringify(timed));
  const timedResult = await execute(h, timed.action);
  assert.equal(timedResult.error, undefined, JSON.stringify(timedResult));
  assert.equal(timedResult.action.steps.at(-1).receipt.creditedAmountRaw, '99');
  assert.equal(h.store.getInventory(TOKEN, CIRCLE).availableRaw, '400');
  const permanent = await h.agent.dispatch('argus_prepare_lock', { idempotencyKey: 'permanent-lock-fixture', token: TOKEN, operation: 'permanent', amountRaw: '100' });
  assert.equal(permanent.error, undefined, JSON.stringify(permanent));
  assert.equal((await execute(h, permanent.action)).error, undefined);
  const withdraw = await h.agent.dispatch('argus_prepare_lock', { idempotencyKey: 'withdraw-lock-fixture', token: TOKEN, operation: 'withdraw', lockId: '1', amountRaw: '99' });
  assert.equal(withdraw.error, undefined, JSON.stringify(withdraw));
  const withdrawn = await execute(h, withdraw.action); assert.equal(withdrawn.error, undefined, JSON.stringify(withdrawn));
  assert.equal(h.store.getInventory(TOKEN, CIRCLE).availableRaw, '398');
});


test('launch fee reservation accepts the qualified estimate with 95 percent headroom and rejects one wei beyond it', async t => {
  for (const fee of ['0.60', '0.665000000000000001']) await t.test(fee, async t => {
    const h = await fixture(t, { feeEstimate: expected => expected?.seedUsdcRaw ? fee : '0.01' });
    const action = await prepare(h); const result = await execute(h, action);
    if (fee === '0.60') { assert.equal(result.error, undefined); assert.equal(h.sends.length, 2); }
    else { assert.equal(result.error.code, 'ARGUS_FEE_CHANGED'); assert.equal(h.sends.length, 1); assert.equal(h.store.getAction(action.id).steps[1].attempt, undefined); }
  });
});

test('a known hosted provider ID recovers its original hash and never resends the approved step', async t => {
  let originalHash;
  const h = await fixture(t, { execute: (tx, mine) => {
    const result = mine(tx);
    if (!originalHash) { originalHash = result.hash; return { status: 'submitted', providerId: 'known-provider-id' }; }
    return result;
  }, executor: { lookup: async () => ({ status: 'unknown' }) } });
  const action = await prepare(h); const waiting = await execute(h, action);
  assert.equal(waiting.action.status, 'submitted'); assert.equal(h.sends.length, 1);
  h.executor.lookup = async input => {
    assert.deepEqual(input, { providerId: 'known-provider-id', account: CIRCLE });
    return { hash: originalHash };
  };
  const recovered = await h.agent.dispatch('argus_get_action', { actionId: action.id });
  assert.equal(recovered.action.steps[0].status, 'confirmed'); assert.equal(h.sends.length, 1);
  assert.equal((await execute(h, action)).action.status, 'confirmed'); assert.equal(h.sends.length, 2);
});

test('a malformed lock event cannot settle or restore reserved inventory', async t => {
  const h = await fixture(t, { changeReceipt: (receipt, expected) => {
    if (expected?.operation === 'timed') receipt.logs = receipt.logs.filter(log => log.address !== CURRENT_TIME_LOCK);
  } });
  await launch(h);
  const prepared = await h.agent.dispatch('argus_prepare_lock', { idempotencyKey: 'malformed-timed-lock', token: TOKEN, operation: 'timed', amountRaw: '100', unlockAt: '1400' });
  const result = await execute(h, prepared.action);
  assert.ok(result.error); assert.equal(h.store.getAction(prepared.action.id).steps.at(-1).status, 'unknown');
  assert.equal(h.store.getInventory(TOKEN, CIRCLE).reservedRaw, '100');
});

test('the mainnet SDK shares one paced client across real project reads from concurrent requests', async t => {
  const h = await fixture(t); await launch(h);
  let active = 0; let peak = 0; let reads = 0;
  const base = { ...h.client, getLogs: async () => [], readContract: async ({ functionName, address }) => {
    if (functionName === 'creatorRegistry') return addresses.creatorRegistry;
    if (functionName === 'launches') return [HOOK, ESCROW, CIRCLE, 1n, 0, 200, false];
    if (functionName === 'payoutOf') return HUMAN;
    if (functionName === 'proposedPayout') return `0x${'00'.repeat(20)}`;
    if (functionName === 'escrowOf') return ESCROW;
    if (functionName === 'payoutSplit') return [[], []];
    if (functionName === 'balanceOf') return address.toLowerCase() === TOKEN ? 500n : 5_000_000n;
    if (functionName === 'name') return 'Paced Fixture';
    if (functionName === 'symbol') return 'PACE';
    if (functionName === 'logo') return 'ipfs://fixture';
    if (functionName === 'owedCreator') return 0n;
    throw new Error('Unexpected fixture read');
  } };
  const client = Object.fromEntries(Object.entries(base).map(([method, fn]) => [method, async (...args) => {
    active++; reads++; peak = Math.max(peak, active);
    try { await new Promise(resolve => setTimeout(resolve, 1)); return await fn(...args); } finally { active--; }
  }]));
  const agent = await h.connect({}, { client, contracts: undefined, readIntervalMs: 2 });
  const [first, second] = await Promise.all([
    agent.dispatch('argus_get_project', { token: TOKEN }), agent.dispatch('argus_get_project', { token: TOKEN }),
  ]);
  assert.equal(first.error, undefined, JSON.stringify(first)); assert.equal(second.error, undefined, JSON.stringify(second));
  assert.equal(first.project.name, 'Paced Fixture'); assert.equal(first.project.balances.length, 3);
  assert.equal(first.project.metadataStatus, 'not_found_in_requested_range');
  assert.equal(peak, 1); assert.equal(reads, 39, 'all 19 reads per project plus engine chain admission still run');
});

test('user configuration cannot disable the mainnet read queue', async t => {
  const h = await fixture(t);
  const starts = [];
  const client = { ...h.client, getChainId: async () => { starts.push(Date.now()); return 5042; } };
  const agent = await h.connect({ readIntervalMs: 0 }, { client, readIntervalMs: undefined });
  const result = await agent.dispatch('argus_prepare_project', request('config-pacing-fixture'));
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.ok(starts[1] - starts[0] >= 230, 'SDK retains the 250ms production default instead of reading a user-config override');
});

test('MVP launch sends opening tokens to human treasury while Circle remains executor', async t => {
  const h = await fixture(t, { mode: 'mainnet-mvp', treasury: HUMAN });
  const action = await prepare(h);
  assert.equal(action.expected.treasury.toLowerCase(), HUMAN);
  const result = await execute(h, action);
  assert.equal(result.error, undefined, JSON.stringify(result)); assert.equal(result.action.status, 'confirmed');
  assert.equal(result.action.steps.at(-1).receipt.treasury.toLowerCase(), HUMAN);
  assert.equal(h.store.getInventory(TOKEN, CIRCLE).availableRaw, '0');
  assert.ok(h.sends.every(tx => tx.account.toLowerCase() === CIRCLE));
});

test('MVP Circle working treasury creates timed locks for human beneficiary and hands withdrawal to human', async t => {
  const h = await fixture(t, { mode: 'mainnet-mvp' }); await launch(h);
  const prepared = await h.agent.dispatch('argus_prepare_lock', { idempotencyKey: 'human-lock-beneficiary', token: TOKEN,
    operation: 'timed', amountRaw: '100', unlockAt: '1400' });
  assert.equal(prepared.error, undefined, JSON.stringify(prepared)); assert.equal(prepared.action.expected.owner.toLowerCase(), HUMAN);
  const result = await execute(h, prepared.action); assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(result.action.steps.at(-1).receipt.owner.toLowerCase(), HUMAN);
  const withdraw = await h.agent.dispatch('argus_prepare_lock', { idempotencyKey: 'human-lock-withdraw', token: TOKEN,
    operation: 'withdraw', amountRaw: '99', lockId: '1' });
  assert.equal(withdraw.status, 'needs_human_signature'); assert.equal(withdraw.management.requiredSigner.toLowerCase(), HUMAN);
});

test('explicit transaction evidence recovers a lost hosted response without sending again or increasing budget', async t => {
  let mined;
  const h = await fixture(t, { mode: 'mainnet-mvp', execute: (tx, mine) => { mined = mine(tx); return { status: 'unknown' }; } });
  const action = await prepare(h);
  const lost = await execute(h, action); assert.equal(lost.error.code, 'ARGUS_OUTCOME_UNKNOWN');
  const before = h.store.budget(); const sends = h.sends.length;
  const readonly = await h.connect({ executionEnabled: false, executor: undefined }, { executor: undefined });
  const recovered = await readonly.dispatch('argus_reconcile_transaction', { actionId: action.id, stepIndex: 0, transactionHash: mined.hash });
  assert.equal(recovered.error, undefined, JSON.stringify(recovered));
  assert.equal(recovered.action.steps[0].status, 'confirmed'); assert.equal(recovered.action.steps[1].status, 'ready');
  assert.equal(h.sends.length, sends); assert.equal(recovered.budget.limitWei, before.limitWei);
  assert.equal(recovered.budget.spentWei, parseUnits('0.01', 18).toString());
  const cancelled = await readonly.dispatch('argus_cancel_action', { actionId: action.id });
  assert.equal(cancelled.action.status, 'cancelled'); assert.equal(cancelled.budget.reservedWei, '0');
});

test('recovery rejects incorrect hashes and unattempted steps without changing the quarantined action', async t => {
  const h = await fixture(t, { mode: 'mainnet-mvp', execute: (tx, mine) => { mine(tx); return { status: 'unknown' }; } });
  const action = await prepare(h); await execute(h, action);
  const before = h.store.getAction(action.id); const budget = h.store.budget();
  const wrong = await h.agent.dispatch('argus_reconcile_transaction', { actionId: action.id, stepIndex: 0, transactionHash: hash(999999) });
  assert.ok(wrong.error); assert.deepEqual(h.store.getAction(action.id), before); assert.deepEqual(h.store.budget(), budget);
  const next = await h.agent.dispatch('argus_reconcile_transaction', { actionId: action.id, stepIndex: 1, transactionHash: hash(999999) });
  assert.equal(next.error.code, 'ARGUS_RECOVERY_NOT_PENDING'); assert.deepEqual(h.store.getAction(action.id), before);
  h.store.submitted(action.id, 0, { hash: hash(101) });
  const known = h.store.getAction(action.id);
  const conflict = await h.agent.dispatch('argus_reconcile_transaction', { actionId: action.id, stepIndex: 0, transactionHash: hash(999999) });
  assert.equal(conflict.error.code, 'ARGUS_RECOVERY_HASH_CONFLICT'); assert.deepEqual(h.store.getAction(action.id), known);
});

test('canonical verifier rejection leaves explicit recovery unresolved and never attaches the candidate hash', async t => {
  let mined;
  const h = await fixture(t, { mode: 'mainnet-mvp', execute: (tx, mine) => { mined = mine(tx); return { status: 'unknown' }; },
    verify: () => { throw Object.assign(new Error('Exact saved calldata or temporal bounds mismatch'), { code: 'ARGUS_RECEIPT_MISMATCH', safe: true }); } });
  const action = await prepare(h); await execute(h, action);
  const before = h.store.getAction(action.id);
  const result = await h.agent.dispatch('argus_reconcile_transaction', { actionId: action.id, stepIndex: 0, transactionHash: mined.hash });
  assert.equal(result.error.code, 'ARGUS_RECEIPT_MISMATCH'); assert.deepEqual(h.store.getAction(action.id), before);
  assert.equal(h.sends.length, 1);
});

test('hosted buys and sells submit their approvals and swap once and settle one fee', async t => {
  const h = await fixture(t, { mode: 'mainnet-mvp' }); await launch(h);
  for (const side of ['buy', 'sell']) {
    const before = h.sends.length;
    const result = await h.agent.dispatch('argus_prepare_trade', { idempotencyKey: `atomic-${side}-fixture`, token: TOKEN, side, amountIn: side === 'buy' ? '0.1' : '50' });
    assert.equal(result.error, undefined, JSON.stringify(result));
    const { action } = result;
    assert.equal(action.steps.length, 1);
    assert.equal(action.steps[0].batchCalls.length, 3);
    assert.equal(action.steps[0].to.toLowerCase(), CIRCLE);
    assert.equal(action.steps[0].principalRaw, side === 'buy' ? '100000' : '0');
    assert.equal(action.gasReserveWei, parseUnits('0.18', 18).toString(), 'Keep conservative headroom until actual batch fees are measured');
    assert.deepEqual([action.summary.execution, action.summary.contractCalls, action.summary.submissions], ['atomic-batch', 3, 1]);
    const confirmed = await execute(h, action);
    assert.equal(confirmed.error, undefined, JSON.stringify(confirmed));
    assert.equal(confirmed.action.status, 'confirmed');
    assert.equal(confirmed.action.steps.length, 1);
    assert.equal(h.sends.length, before + 1); assert.equal(h.estimates.length, h.sends.length);
    assert.equal(confirmed.action.steps[0].receipt.networkFeeWei, parseUnits('0.01', 18).toString());
    const replay = await execute(h, action);
    assert.equal(replay.action.status, 'confirmed'); assert.equal(h.sends.length, before + 1);
  }
  assert.equal(h.store.budget().spentWei, parseUnits('4.64', 18).toString());
  assert.equal(h.store.getInventory(TOKEN, CIRCLE).availableRaw, '550');
});

test('trade planning preserves a swap-only call and handles one approval or a reset plus both approvals', async t => {
  for (const approvals of [0, 1, 3]) await t.test(`${approvals} approvals`, async t => {
    const h = await fixture(t, { tradeApprovals: approvals }); await launch(h);
    const prepared = await h.agent.dispatch('argus_prepare_trade', { idempotencyKey: `approval-count-${approvals}`, token: TOKEN, side: 'buy', amountIn: '0.01' });
    assert.equal(prepared.error, undefined, JSON.stringify(prepared)); assert.equal(prepared.action.steps.length, 1);
    assert.equal(prepared.action.steps[0].batchCalls?.length, approvals === 0 ? undefined : approvals + 1);
    assert.equal((await execute(h, prepared.action)).action.status, 'confirmed');
    assert.equal(h.sends.length, 3);
  });
});

test('a failed batch settles its single fee without spending principal or crediting output', async t => {
  const h = await fixture(t, { verify: (result, action) => ({ ...result, state: action.kind === 'trade' ? 'reverted' : result.state }) });
  await launch(h);
  const { action } = await h.agent.dispatch('argus_prepare_trade', { idempotencyKey: 'reverted-atomic-buy', token: TOKEN, side: 'buy', amountIn: '0.1' });
  const result = await execute(h, action);
  assert.equal(result.action.status, 'reverted'); assert.equal(h.sends.length, 3);
  assert.equal(h.store.budget().spentWei, parseUnits('4.53', 18).toString());
  assert.equal(h.store.budget().reservedWei, '0');
  assert.equal(h.store.getInventory(TOKEN, CIRCLE).availableRaw, '500');
  assert.ok((await execute(h, action)).error); assert.equal(h.sends.length, 3);
});

test('a lost batch response survives restart and recovers the whole trade without fallback or resubmission', async t => {
  const h = await fixture(t, { mode: 'mainnet-mvp' }); await launch(h);
  const originalExecute = h.executor.execute; let submitted;
  h.executor.execute = async tx => { submitted = await originalExecute(tx); return { status: 'unknown' }; };
  const args = { idempotencyKey: 'lost-batch-response', token: TOKEN, side: 'buy', amountIn: '0.1' };
  const { action } = await h.agent.dispatch('argus_prepare_trade', args);
  assert.equal((await execute(h, action)).error.code, 'ARGUS_OUTCOME_UNKNOWN');
  assert.equal(h.sends.length, 3); assert.equal(h.store.getInventory(TOKEN, CIRCLE).availableRaw, '500');
  const restarted = await h.connect();
  assert.equal((await restarted.dispatch('argus_execute_action', { actionId: action.id })).error.code, 'ARGUS_OUTCOME_UNKNOWN');
  assert.equal((await restarted.dispatch('argus_prepare_trade', args)).action.id, action.id);
  const readonly = await h.connect({ executionEnabled: false, executor: undefined }, { executor: undefined });
  const result = await readonly.dispatch('argus_reconcile_transaction', { actionId: action.id, stepIndex: 0, transactionHash: submitted.hash });
  assert.equal(result.error, undefined, JSON.stringify(result)); assert.equal(result.action.status, 'confirmed');
  assert.equal(result.action.steps.length, 1); assert.equal(h.sends.length, 3);
  assert.equal(result.budget.spentWei, parseUnits('4.63', 18).toString());
  assert.equal(result.budget.reservedWei, '0'); assert.equal(h.store.getInventory(TOKEN, CIRCLE).availableRaw, '600');
  assert.equal((await restarted.dispatch('argus_execute_action', { actionId: action.id })).action.status, 'confirmed');
  assert.equal(h.sends.length, 3);
});

test('previously prepared sequential trades keep their old digest and ordered steps after restart', async t => {
  const h = await fixture(t); await launch(h);
  const args = validateOperation('argus_prepare_trade', { idempotencyKey: 'legacy-sequential-buy', token: TOKEN, side: 'buy', amountIn: '0.1' });
  const plan = await h.contracts.prepareTrade({ ...args, actor: CIRCLE });
  const terms = { operation: 'argus_prepare_trade', args, roles: h.config.actors, chainId: 5042, mode: h.config.mode, identity: h.config.identity };
  const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
  const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
  const steps = plan.steps.map((step, index) => ({ ...step, from: CIRCLE,
    gasReserveWei: parseUnits(index === plan.steps.length - 1 ? '0.08' : '0.05', 18).toString(), exactFeeCeiling: false }));
  // Preserve the exact pre-batch digest shape, including undefined EOA fields.
  const oldPlanDigest = digest({ expected: plan.expected, summary: plan.summary,
    steps: steps.map(({ to, data, value, from, gas, maxFeePerGas, abi, gasReserveWei }) => ({ to, data, value, from, gas, maxFeePerGas, abi, gasReserveWei })) });
  const legacy = h.store.prepare({ idempotencyKey: args.idempotencyKey, kind: 'trade', terms, termsHash: digest(terms), steps,
    expected: plan.expected, summary: plan.summary, principalRaw: '100000', metadata: { planDigest: oldPlanDigest,
      preparedAtBlock: '100', expiresAt: new Date(Date.now() + 60_000).toISOString(), executionMode: 'circle-hosted' } });
  const restarted = await h.connect();
  const resumed = await restarted.dispatch('argus_prepare_trade', args);
  assert.equal(resumed.action.id, legacy.id); assert.equal(resumed.action.steps.length, 3);
  assert.ok(resumed.action.steps.every(step => step.batchCalls === undefined));
  const result = await restarted.dispatch('argus_execute_action', { actionId: legacy.id });
  assert.equal(result.error, undefined, JSON.stringify(result)); assert.equal(result.action.status, 'confirmed');
  assert.equal(h.sends.length, 5); assert.equal(result.budget.spentWei, parseUnits('4.65', 18).toString());
});

async function v1Fixture(t, options = {}) {
  const generation = options.generation ?? 6;
  const creator = options.creator ?? HUMAN;
  const recipientOnly = generation === 3 || generation === 4;
  const portal = PORTALS.find(item => item.generation === generation);
  const poolId = poolIdFor(poolKeyFor(TOKEN, addresses.defaultQuoteAsset, HOOK));
  const h = await fixture(t, { mode: 'mainnet-mvp', ...options,
    client: { readContract: async ({ functionName }) => {
      if (functionName === 'launches') return [creator, 0, true, CURRENT_TIME_LOCK, HOOK, ESCROW, 300, 300, 1n,
        ...(generation >= 4 ? [100] : []), ...(generation >= 6 ? [addresses.defaultQuoteAsset] : [])];
      if (functionName === 'poolId') return poolId;
      if (functionName === 'creator') return creator;
      if (functionName === 'token') return TOKEN;
      if (functionName === 'quoteAsset') return addresses.defaultQuoteAsset;
      if (functionName === 'decimals') return 6;
      throw new Error(`Unexpected receipt read ${functionName}`);
    } },
    changeReceipt: (receipt, expected) => {
      if (expected?.operation === 'claim_fees') receipt.logs = [
        event(ESCROW, legacySplitterAbi, 'Claimed', { to: creator, currency: addresses.defaultQuoteAsset, amount: 101n }),
        transfer(generation <= 5 ? '0xfffffffffffffffffffffffffffffffffffffffe' : addresses.defaultQuoteAsset,
          ESCROW, creator, generation <= 5 ? 101n * 10n ** 12n : 101n),
      ];
      options.changeReceipt?.(receipt, expected);
    },
  });
  const current = { version: 'v1', portal: portal.address, portalGeneration: generation, line: 'hooked', feeModel: 'v4_splitter',
    controller: creator, proposed: null, split: [], splitter: ESCROW, capabilities: { management: ['claim_fees'] },
    fees: { executionSupported: true, claimPermission: recipientOnly ? 'recipient_only' : 'permissionless' },
    feeAssets: [{ asset: addresses.defaultQuoteAsset, amountRaw: '101', decimals: 6, delivery: 'erc20' }] };
  h.store.saveImportedProject({ ...current, verified: true, source: 'canonical-launch-receipt', chainId: 5042,
    token: TOKEN, operator: creator, historicalCreator: creator, creatorRegistry: null, escrow: null, hook: HOOK,
    launchTxHash: hash(1), launchBlock: '1', launchBlockHash: hash(1), observedBlockNumber: '100' });
  h.contracts.readProject = async () => current;
  h.contracts.prepareManagement = async input => {
    const result = h.plan({ version: 'v1', portal: portal.address, portalGeneration: generation, feeModel: 'v4_splitter',
      token: TOKEN, actor: input.actor, operation: 'claim_fees', controllerBefore: creator, feeContract: ESCROW,
      quoteAsset: addresses.defaultQuoteAsset, recipients: [{ recipient: creator, bps: 10000 }] }, '0', false,
    encodeFunctionData({ abi: recipientOnly ? legacySelfClaimAbi : legacySplitterAbi, functionName: 'claim', args: recipientOnly ? [] : [creator] }));
    result.steps[0].to = ESCROW;
    return result;
  };
  const originalTrade = h.contracts.prepareTrade;
  h.contracts.prepareTrade = async input => {
    const plan = await originalTrade(input);
    Object.assign(plan.expected, { version: 'v1', portal: portal.address, portalGeneration: generation });
    return plan;
  };
  return { ...h, current };
}

test('V1 management refuses immutable operations instead of offering a human signing route', async t => {
  const h = await v1Fixture(t);
  for (const operation of ['set_split', 'propose_owner', 'accept_owner']) {
    const result = await h.agent.dispatch('argus_prepare_management', { idempotencyKey: `v1-${operation}`, token: TOKEN, operation, newController: CIRCLE });
    assert.equal(result.error.code, 'UNSUPPORTED');
    assert.equal(result.management, undefined);
  }
  assert.equal(h.sends.length, 0);
  assert.equal(h.store.listActions().length, 0);
});

test('an imported V1 token uses atomic trades and retains inventory and budget across clients', async t => {
  const h = await v1Fixture(t);
  const result = await h.agent.dispatch('argus_prepare_trade', { idempotencyKey: 'v1-atomic-buy', token: TOKEN, side: 'buy', amountIn: '0.1' });
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(result.action.expected.version, 'v1');
  assert.equal(result.action.steps.length, 1);
  assert.equal(result.action.steps[0].batchCalls.length, 3);
  const confirmed = await execute(h, result.action);
  assert.equal(confirmed.action.status, 'confirmed');
  assert.equal(h.store.getInventory(TOKEN, CIRCLE).availableRaw, '100');
  assert.equal(h.store.budget().spentWei, parseUnits('0.11', 18).toString());
  const reopened = await h.connect();
  assert.equal((await reopened.dispatch('argus_list_projects')).projects[0].version, 'v1');
  assert.equal((await reopened.dispatch('argus_execute_action', { actionId: result.action.id })).action.status, 'confirmed');
  assert.equal(h.sends.length, 1);
});

test('V1 creator claims verify their own splitter and actual payout without V2 registry reads', async t => {
  const h = await v1Fixture(t);
  const prepared = await h.agent.dispatch('argus_prepare_management', { idempotencyKey: 'v1-claim', token: TOKEN, operation: 'claim_fees' });
  assert.equal(prepared.error, undefined, JSON.stringify(prepared));
  const confirmed = await execute(h, prepared.action);
  assert.equal(confirmed.error, undefined, JSON.stringify(confirmed));
  assert.equal(confirmed.action.status, 'confirmed');
  assert.equal(confirmed.action.steps[0].receipt.actualCreatorFeesUsdcRaw, '101');
  assert.equal(confirmed.action.steps[0].receipt.payouts[0].recipient.toLowerCase(), HUMAN);
  assert.equal(h.store.budget().spentWei, parseUnits('0.01', 18).toString());
  assert.equal(h.store.getInventory(TOKEN, CIRCLE).availableRaw, '0');
});

test('a recipient-only V1 claim requires the recorded recipient rather than substituting Circle', async t => {
  const h = await v1Fixture(t, { generation: 3 });
  const result = await h.agent.dispatch('argus_prepare_management', { idempotencyKey: 'v1-recipient-only', token: TOKEN, operation: 'claim_fees' });
  assert.equal(result.error.code, 'ARGUS_MANUAL_SIGNER_UNAVAILABLE');
  assert.match(result.error.message, /recorded recipient/);
  assert.equal(h.sends.length, 0);
  assert.equal(h.store.listActions().length, 0);
});

test('Portal 3 and 4 claims execute only when Circle is already the recorded fee recipient', async t => {
  for (const generation of [3, 4]) {
    const h = await v1Fixture(t, { generation, creator: CIRCLE });
    const prepared = await h.agent.dispatch('argus_prepare_management', { idempotencyKey: 'v1-self-claim', token: TOKEN, operation: 'claim_fees' });
    assert.equal(prepared.error, undefined, JSON.stringify(prepared));
    assert.equal(prepared.action.steps[0].data, '0x4e71d92d');
    assert.equal(prepared.action.steps[0].from, CIRCLE);
    const confirmed = await execute(h, prepared.action);
    assert.equal(confirmed.error, undefined, JSON.stringify(confirmed));
    assert.equal(confirmed.action.status, 'confirmed');
    assert.equal(confirmed.action.steps[0].receipt.payouts[0].recipient.toLowerCase(), CIRCLE);
    assert.equal(confirmed.action.steps[0].receipt.payouts[0].amountRaw, '101000000000000');
    assert.equal(h.store.budget().spentWei, parseUnits('0.01', 18).toString());
    assert.equal(h.sends.length, 1);
  }
});

test('V1 claims depleted after preparation do not reserve budget or submit a transaction', async t => {
  const h = await v1Fixture(t);
  const prepared = await h.agent.dispatch('argus_prepare_management', { idempotencyKey: 'v1-depleted-claim', token: TOKEN, operation: 'claim_fees' });
  assert.equal(prepared.error, undefined, JSON.stringify(prepared));
  const budget = h.store.budget();
  h.current.feeAssets = [];
  const result = await execute(h, prepared.action);
  assert.equal(result.error.code, 'NOTHING_TO_CLAIM');
  assert.equal(h.sends.length, 0);
  assert.equal(h.estimates.length, 0);
  assert.deepEqual(h.store.budget(), budget);
});

test('V1 claim deployment changes are caught before sending and bad delivered amounts remain unresolved', async t => {
  const h = await v1Fixture(t);
  const prepared = await h.agent.dispatch('argus_prepare_management', { idempotencyKey: 'v1-claim-drift', token: TOKEN, operation: 'claim_fees' });
  h.current.splitter = HOOK;
  assert.equal((await execute(h, prepared.action)).error.code, 'ARGUS_TERMS_CHANGED');
  assert.equal(h.sends.length, 0);
  const bad = await v1Fixture(t, { changeReceipt: (receipt, expected) => {
    if (expected?.operation === 'claim_fees') receipt.logs.pop();
  } });
  const request = await bad.agent.dispatch('argus_prepare_management', { idempotencyKey: 'v1-bad-claim', token: TOKEN, operation: 'claim_fees' });
  assert.equal((await execute(bad, request.action)).error.code, 'ARGUS_RECEIPT_MISMATCH');
  assert.equal(bad.store.getAction(request.action.id).steps[0].status, 'unknown');
  assert.equal((await execute(bad, request.action)).error.code, 'ARGUS_RECEIPT_MISMATCH');
  assert.equal(bad.sends.length, 1);
});
