import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, parseAbi, parseUnits } from 'viem';
import { createArgusAgent, createArgusAgentFromConfig } from '../scripts/argus-agent/sdk.mjs';
import { createStore } from '../scripts/argus-agent/store.mjs';

const bundle = JSON.parse(readFileSync(new URL('../scripts/argus-agent/vendor/argus-v4.json', import.meta.url), 'utf8'));
const addresses = bundle.portal8.addresses;
const portalAbi = bundle.portal8.contracts.ArgusV5Portal.abi;
const escrowAbi = bundle.portal8.contracts.ArgusV5PayoutEscrow.abi;
const erc20Abi = parseAbi(['function approve(address,uint256) returns(bool)', 'event Transfer(address indexed from,address indexed to,uint256 value)']);
const OPERATOR = `0x${'11'.repeat(20)}`;
const CONTROLLER = `0x${'22'.repeat(20)}`;
const TREASURY = `0x${'33'.repeat(20)}`;
const TOKEN = `0x${'44'.repeat(20)}`;
const HOOK = `0x${'55'.repeat(20)}`;
const ESCROW = `0x${'66'.repeat(20)}`;
const LOCKER = `0x${'77'.repeat(20)}`;
const OTHER = `0x${'88'.repeat(20)}`;
const ZERO = `0x${'00'.repeat(20)}`;
const ZERO32 = `0x${'00'.repeat(32)}`;
const BASE = 24_109_098n;
const BASE_HASH = '0xedec9ae822db30bd63100fdd62cbe7691a25a834569321b1b7b6d09b52937292';
const hash = number => `0x${BigInt(number).toString(16).padStart(64, '0')}`;
const blockHash = number => number === BASE ? BASE_HASH : hash(number + 1_000_000n);
const SECRET = 'private-provider-credential-never-public';
const request = (extra = {}) => ({ idempotencyKey: 'sdk-proof-project', brand: { name: 'Cedar', symbol: 'CEDAR', description: 'A local fixture', imageURI: 'ipfs://cedar-fixture' }, ...extra });

function eventLog(address, abi, eventName, args) {
  const event = abi.find(item => item.type === 'event' && item.name === eventName);
  return { address, topics: encodeEventTopics({ abi, eventName, args }),
    data: encodeAbiParameters(event.inputs.filter(item => !item.indexed), event.inputs.filter(item => !item.indexed).map(item => args[item.name])) };
}

function launchPlan(input) {
  const seed = parseUnits(input.seedUsdc, 6);
  const params = { name: input.brand.name, symbol: input.brand.symbol, totalSupply: 10n ** 27n,
    buyTaxBps: input.buyTaxBps, sellTaxBps: input.sellTaxBps, alloc: [10_000, 0, 0, 0, 0],
    quoteAsset: addresses.defaultQuoteAsset, payoutAsset: addresses.defaultQuoteAsset, kothBps: 0,
    payoutAddress: input.controller, identityProvider: ZERO32, identitySubject: 0n,
    bundle: [{ to: input.treasury, amountQuote: seed }], snipeExempt: [], meta: input.brand };
  return {
    steps: [
      { to: addresses.defaultQuoteAsset, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [addresses.portal, seed] }), value: '0', abi: erc20Abi },
      { to: addresses.portal, data: encodeFunctionData({ abi: portalAbi, functionName: 'launch', args: [params, ZERO32] }), value: '0', abi: portalAbi },
    ],
    expected: { chainId: 5042, operator: input.operator, controller: input.controller, treasury: input.treasury, hook: HOOK, escrow: ESCROW,
      seedUsdcRaw: seed.toString(), brand: input.brand },
    summary: { spendUsdcRaw: seed.toString() },
  };
}

async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'argus-sdk-adversarial-'));
  const stores = new Set();
  t.after(() => { for (const store of stores) store.close(); rmSync(dir, { recursive: true, force: true }); });
  const config = { mode: 'local-fork', rpcUrl: 'http://127.0.0.1:8545', stateDir: dir, budgetUsdcRaw: '10000000',
    actors: { operator: OPERATOR, controller: CONTROLLER, treasury: TREASURY }, executor: { kind: 'anvil' }, ...options.config };
  const transactions = new Map();
  const receipts = new Map();
  const plans = new Map();
  const sends = [];
  const reads = [];
  const preparedInputs = [];
  let head = BASE;
  let nonce = 0;
  let currentController = CONTROLLER;
  let currentRecipients = options.claimRecipients ?? [];
  let runtimeSafe = true;
  const client = {
    getChainId: async () => runtimeSafe ? 5042 : 1,
    request: async ({ method }) => method === 'web3_clientVersion' ? 'anvil/v1-fixture' : { forkedNetwork: { forkBlockNumber: Number(BASE) } },
    getBlock: async ({ blockNumber = head, includeTransactions } = {}) => ({ number: blockNumber, hash: blockHash(blockNumber), baseFeePerGas: 1n,
      ...(includeTransactions ? { transactions: [...transactions.values()].filter(tx => tx.blockNumber === blockNumber) } : {}) }),
    getBlockNumber: async () => head,
    getGasPrice: async () => 1n,
    getTransactionCount: async () => nonce,
    call: async () => ({ data: '0x' }),
    getTransactionReceipt: async ({ hash: id }) => {
      if (!receipts.has(id)) throw Object.assign(new Error('Pending fixture'), { name: 'TransactionReceiptNotFoundError' });
      return receipts.get(id);
    },
    getTransaction: async ({ hash: id }) => transactions.get(id),
    waitForTransactionReceipt: async ({ hash: id }) => client.getTransactionReceipt({ hash: id }),
    readContract: async ({ functionName }) => {
      reads.push(functionName);
      if (functionName === 'escrowOf') return ESCROW;
      if (functionName === 'quoteAsset' || functionName === 'payoutAsset') return addresses.defaultQuoteAsset;
      if (functionName === 'payoutSplit') return [currentRecipients.map(part => part.recipient), currentRecipients.map(part => part.bps)];
      return currentController;
    },
    ...options.client,
  };
  const contracts = {
    prepareProject: async input => {
      preparedInputs.push(input);
      const plan = launchPlan(input);
      plans.set(plan.steps.at(-1).data, plan);
      return plan;
    },
    readProject: async () => ({ controller: currentController, proposed: null, split: currentRecipients }),
    prepareManagement: async input => {
      assert.equal(input.operation, 'claim_fees');
      const plan = { steps: [{ to: ESCROW, data: encodeFunctionData({ abi: escrowAbi, functionName: 'claimCreator' }), value: '0', abi: escrowAbi }],
        expected: { token: TOKEN, actor: input.actor, operation: 'claim_fees', controllerBefore: currentController,
          owedCreatorRaw: '101', recipients: currentRecipients.length ? currentRecipients : [{ recipient: currentController, bps: 10_000 }] },
        summary: { spendUsdcRaw: '0' } };
      plans.set(plan.steps[0].data, plan);
      return plan;
    },
    ...options.contracts,
  };
  function mine(tx) {
    const id = hash(transactions.size + 1);
    head++;
    const transaction = { hash: id, blockNumber: head, from: tx.account, to: tx.to, input: tx.data, value: BigInt(tx.value),
      chainId: 5042, nonce: Number(tx.nonce), gas: BigInt(tx.gas), maxFeePerGas: BigInt(tx.maxFeePerGas) };
    const plan = plans.get(tx.data);
    const logs = plan?.expected.operation === 'claim_fees' ? plan.expected.recipients.flatMap((part, index, parts) => {
      const amount = index === parts.length - 1 ? 101n - parts.slice(0, -1).reduce((sum, entry) => sum + 101n * BigInt(entry.bps) / 10_000n, 0n) : 101n * BigInt(part.bps) / 10_000n;
      return [eventLog(ESCROW, escrowAbi, 'CreatorClaimed', { to: part.recipient, owedQuote: amount, paidPayout: 0n, paidInQuoteFallback: false }),
        eventLog(addresses.defaultQuoteAsset, erc20Abi, 'Transfer', { from: ESCROW, to: part.recipient, value: amount })];
    }) : plan ? [
      eventLog(addresses.portal, portalAbi, 'Launched', { token: TOKEN, creator: plan.expected.operator, hook: HOOK, escrow: ESCROW, locker: LOCKER, positionId: 1n, tickStart: -100, tickBond: 100 }),
      eventLog(addresses.portal, portalAbi, 'LaunchMetadata', { token: TOKEN, ...plan.expected.brand }),
      eventLog(addresses.portal, portalAbi, 'BundleBought', { token: TOKEN, wallets: 1n, quoteIn: BigInt(plan.expected.seedUsdcRaw), tokensOut: 500n }),
      eventLog(TOKEN, erc20Abi, 'Transfer', { from: addresses.portal, to: plan.expected.treasury, value: 500n }),
    ] : [];
    const receipt = { transactionHash: id, status: 'success', blockNumber: head, blockHash: blockHash(head), gasUsed: 21_000n, effectiveGasPrice: 1n, logs };
    options.changeReceipt?.(receipt, transaction, plan);
    transactions.set(id, transaction);
    receipts.set(id, receipt);
    nonce++;
    return { status: 'submitted', hash: id };
  }
  const executor = { execute: async tx => {
    sends.push(tx);
    return options.execute ? options.execute(tx, mine) : mine(tx);
  }, ...options.executor };
  const connect = async (override = {}) => {
    const store = createStore(dir, { budgetUsdcRaw: config.budgetUsdcRaw });
    stores.add(store);
    const agent = await createArgusAgent({ ...config, ...override }, { client, contracts, executor, store });
    return { agent, store };
  };
  const first = await connect();
  return { ...first, config, client, contracts, executor, sends, reads, receipts, transactions, preparedInputs, connect,
    runtimeUnsafe: () => { runtimeSafe = false; }, setHead: value => { head = value; }, setController: value => { currentController = value; },
    setRecipients: value => { currentRecipients = value; }, dir };
}

const prepare = async (h, args = request()) => {
  const result = await h.agent.dispatch('argus_prepare_project', args);
  assert.equal(result.error, undefined, JSON.stringify(result));
  return result.action;
};
const execute = (h, action) => h.agent.dispatch('argus_execute_action', { actionId: action.id });
const actionState = (h, action) => h.agent.dispatch('argus_get_action', { actionId: action.id });

test('schemas prevent callers from replacing configured roles, calldata or execution settings', async t => {
  const h = await fixture(t);
  for (const extra of [{ controller: OTHER }, { operator: OTHER }, { treasury: OTHER }, { data: '0x12345678' }, { rpcUrl: 'https://rpc.invalid' }]) {
    const result = await h.agent.dispatch('argus_prepare_project', request(extra));
    assert.equal(result.error.code, 'ARGUS_INVALID_ARGUMENTS');
  }
  assert.equal(h.preparedInputs.length, 0);
  assert.equal(h.sends.length, 0);
  const action = await prepare(h);
  assert.equal(h.preparedInputs[0].operator, OPERATOR);
  assert.equal(h.preparedInputs[0].controller, CONTROLLER);
  assert.equal(h.preparedInputs[0].treasury, TREASURY);
  const result = await h.agent.dispatch('argus_execute_action', { actionId: action.id, to: OTHER });
  assert.equal(result.error.code, 'ARGUS_INVALID_ARGUMENTS');
  assert.equal(h.sends.length, 0);
});

test('identical preparation survives a new engine; changed terms or signing roles cannot execute it', async t => {
  const h = await fixture(t);
  const action = await prepare(h);
  const next = await h.connect();
  const repeated = await next.agent.dispatch('argus_prepare_project', request());
  assert.equal(repeated.action.id, action.id);
  assert.equal(h.preparedInputs.length, 1);
  const conflict = await h.agent.dispatch('argus_prepare_project', request({ seedUsdc: '4.6' }));
  assert.equal(conflict.error.code, 'IDEMPOTENCY_CONFLICT');
  const changedRoles = await h.connect({ actors: { operator: OPERATOR, controller: OTHER, treasury: TREASURY } });
  assert.equal((await execute(changedRoles, action)).error.code, 'ARGUS_TERMS_CHANGED');
  assert.equal(h.sends.length, 0);
});

test('confirmed launch is saved once and repeated execution does not resend or charge twice', async t => {
  const h = await fixture(t);
  const action = await prepare(h);
  const result = await execute(h, action);
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(result.action.status, 'confirmed');
  assert.equal(h.sends.length, 2);
  const budget = h.store.budget();
  assert.equal((await execute(h, action)).action.status, 'confirmed');
  assert.equal(h.sends.length, 2);
  assert.deepEqual(h.store.budget(), budget);
  const projects = await h.agent.dispatch('argus_list_projects', {});
  assert.equal(projects.projects.length, 1);
  assert.equal(projects.projects[0].controller, CONTROLLER);
  assert.equal(projects.projects[0].treasury, TREASURY);
  assert.equal(result.coverage.authenticatedCircleAgentWallet, false);
  assert.equal(result.coverage.mainnetTransactions, false);
});

test('lost submission hash recovers by the original sender and nonce without repeating approval', async t => {
  let dropped = false;
  const h = await fixture(t, { execute: (tx, mine) => {
    const result = mine(tx);
    if (!dropped) { dropped = true; throw new Error(`RPC response lost: ${SECRET}`); }
    return result;
  } });
  const action = await prepare(h);
  const uncertain = await execute(h, action);
  assert.ok(uncertain.error);
  assert.ok(!JSON.stringify(uncertain).includes(SECRET));
  assert.equal(h.sends.length, 1);
  assert.equal(h.store.getAction(action.id).steps[0].status, 'unknown');
  const restarted = await h.connect();
  const recovered = await actionState(restarted, action);
  assert.equal(recovered.action.steps[0].status, 'confirmed');
  assert.equal(h.sends.length, 1);
  assert.equal((await execute(restarted, action)).action.status, 'confirmed');
  assert.equal(h.sends.length, 2);
});

test('unknown outcome retains reservation and never resubmits, including beyond the bounded lookup range', async t => {
  const h = await fixture(t, { execute: () => { throw new Error('No reliable response.'); } });
  const action = await prepare(h);
  const reserved = h.store.budget().reservedWei;
  await execute(h, action);
  for (const head of [BASE, BASE + 101n]) {
    h.setHead(head);
    assert.equal((await execute(h, action)).error.code, 'ARGUS_OUTCOME_UNKNOWN');
    assert.equal((await actionState(h, action)).action.status, 'unknown');
  }
  assert.equal(h.sends.length, 1);
  assert.equal(h.store.budget().reservedWei, reserved);
});

test('provider-ID recovery verifies the original transaction before continuing', async t => {
  let providerHash;
  let providerPending = true;
  const h = await fixture(t, { execute: (tx, mine) => {
    const result = mine(tx);
    if (!providerHash) { providerHash = result.hash; return { status: 'submitted', providerId: 'fixture-provider-1' }; }
    return result;
  }, executor: { lookup: async () => providerPending ? {} : { hash: providerHash } } });
  const action = await prepare(h);
  // Disable block lookup until the provider supplies its original hash.
  const originalGetBlock = h.client.getBlock;
  h.client.getBlock = async args => ({ ...await originalGetBlock(args), ...(args?.includeTransactions && providerPending ? { transactions: [] } : {}) });
  const pending = await execute(h, action);
  assert.equal(pending.action.status, 'submitted');
  assert.equal(h.sends.length, 1);
  providerPending = false;
  assert.equal((await actionState(h, action)).action.steps[0].status, 'confirmed');
  assert.equal((await execute(h, action)).action.status, 'confirmed');
  assert.equal(h.sends.length, 2);
});

test('competing actions cannot send the same operator nonce while an earlier attempt is unresolved', async t => {
  const h = await fixture(t, { execute: () => ({ status: 'submitted', providerId: 'unresolved-provider' }) });
  const first = await prepare(h);
  const second = await prepare(h, request({ idempotencyKey: 'second-project' }));
  const results = await Promise.all([execute(h, first), execute(h, second)]);
  assert.equal(h.sends.length, 1);
  assert.ok(results.some(result => result.error?.code === 'NONCE_CONFLICT'));
  assert.ok(h.store.budget().reservedWei !== '0');
});

test('an approval interrupted before launch resumes only the remaining step', async t => {
  const h = await fixture(t, { config: { faults: { stopAfterApprovalOnce: true } } });
  const action = await prepare(h);
  const interrupted = await execute(h, action);
  assert.equal(interrupted.interruptedAfterApproval, true);
  assert.equal(interrupted.action.steps[0].status, 'confirmed');
  assert.equal(interrupted.action.steps[1].status, 'ready');
  const restarted = await h.connect();
  assert.equal((await execute(restarted, action)).action.status, 'confirmed');
  assert.equal(h.sends.length, 2);
});

test('runtime identity is checked again immediately before writes', async t => {
  const h = await fixture(t);
  const action = await prepare(h);
  h.runtimeUnsafe();
  assert.equal((await execute(h, action)).error.code, 'ARGUS_RPC_UNSAFE');
  assert.equal(h.sends.length, 0);
});

test('receipt verification rejects changed transaction and canonical-block identity', async t => {
  for (const [field, value] of [['from', OTHER], ['to', OTHER], ['input', '0x12345678'], ['value', 1n], ['chainId', 1], ['nonce', 9]]) {
    await t.test(field, async t => {
      const h = await fixture(t, { changeReceipt: (_receipt, tx) => { tx[field] = value; } });
      const result = await execute(h, await prepare(h));
      assert.equal(result.error.code, 'ARGUS_RECEIPT_MISMATCH');
      assert.equal(h.sends.length, 1);
      assert.equal(h.store.listProjects().length, 0);
    });
  }
  await t.test('block hash', async t => {
    const h = await fixture(t, { changeReceipt: receipt => { receipt.blockHash = ZERO32; } });
    assert.equal((await execute(h, await prepare(h))).error.code, 'ARGUS_RECEIPT_MISMATCH');
    assert.equal(h.sends.length, 1);
  });
});

test('launch receipt cannot publish changed metadata, payout authority or opening-buy recipient', async t => {
  for (const change of ['metadata', 'controller', 'recipient']) await t.test(change, async t => {
    const h = await fixture(t, { changeReceipt: (receipt, _tx, plan) => {
      if (!plan) return;
      if (change === 'metadata') receipt.logs[1] = eventLog(addresses.portal, portalAbi, 'LaunchMetadata', { token: TOKEN, ...plan.expected.brand, description: 'Changed after approval' });
      if (change === 'recipient') receipt.logs[3] = eventLog(TOKEN, erc20Abi, 'Transfer', { from: addresses.portal, to: OTHER, value: 500n });
    } });
    if (change === 'controller') h.setController(OTHER);
    const result = await execute(h, await prepare(h));
    assert.ok(result.error);
    assert.equal(h.store.listProjects().length, 0);
    assert.equal(h.sends.length, 2);
  });
});

test('launch evidence must bind metadata and opening-buy events to the launched token and exact seed', async t => {
  for (const change of ['metadata token', 'bundle token', 'bundle seed', 'bundle count', 'duplicate metadata', 'duplicate bundle']) await t.test(change, async t => {
    const h = await fixture(t, { changeReceipt: (receipt, _tx, plan) => {
      if (!plan) return;
      if (change === 'metadata token') receipt.logs[1] = eventLog(addresses.portal, portalAbi, 'LaunchMetadata', { token: OTHER, ...plan.expected.brand });
      if (change.startsWith('bundle ')) receipt.logs[2] = eventLog(addresses.portal, portalAbi, 'BundleBought', {
        token: change === 'bundle token' ? OTHER : TOKEN, wallets: change === 'bundle count' ? 2n : 1n,
        quoteIn: BigInt(plan.expected.seedUsdcRaw) + (change === 'bundle seed' ? 1n : 0n), tokensOut: 500n });
      if (change === 'duplicate metadata') receipt.logs.push(receipt.logs[1]);
      if (change === 'duplicate bundle') receipt.logs.push(receipt.logs[2]);
    } });
    const result = await execute(h, await prepare(h));
    assert.ok(result.error, 'inconsistent launch evidence must fail closed');
    assert.equal(h.store.listProjects().length, 0);
  });
});

test('a reverted launch stops execution, preserves confirmed approval evidence and releases unspent principal', async t => {
  const h = await fixture(t, { changeReceipt: (receipt, _tx, plan) => { if (plan) receipt.status = 'reverted'; } });
  const action = await prepare(h);
  const result = await execute(h, action);
  assert.equal(result.action.status, 'reverted');
  assert.equal(result.action.steps[0].status, 'confirmed');
  assert.equal(result.action.steps[1].status, 'reverted');
  assert.equal(h.store.budget().spentWei, '42000');
  assert.equal(h.store.budget().reservedWei, '0');
  assert.equal(h.store.listProjects().length, 0);
  assert.ok((await execute(h, action)).error);
  assert.equal(h.sends.length, 2);
});

test('expired prepared action cannot submit and does not erase an already confirmed approval', async t => {
  const h = await fixture(t, { config: { faults: { stopAfterApprovalOnce: true } } });
  const action = await prepare(h);
  assert.equal((await execute(h, action)).interruptedAfterApproval, true);
  const db = new DatabaseSync(h.store.filename);
  try {
    const changed = h.store.getAction(action.id);
    changed.metadata.expiresAt = new Date(0).toISOString();
    db.prepare('UPDATE actions SET json = ? WHERE id = ?').run(JSON.stringify(changed), action.id);
  } finally { db.close(); }
  assert.equal((await execute(h, action)).error.code, 'ARGUS_ACTION_EXPIRED');
  assert.equal(h.sends.length, 1);
  assert.equal(h.store.getAction(action.id).steps[0].status, 'confirmed');
});

test('untrusted provider error codes and messages cannot expose credentials', async t => {
  const h = await fixture(t, { contracts: { prepareProject: async () => { throw Object.assign(new Error(SECRET), { code: `ARGUS_${SECRET}` }); } } });
  const result = await h.agent.dispatch('argus_prepare_project', request());
  assert.ok(result.error);
  assert.ok(!JSON.stringify(result).includes(SECRET));
  assert.equal(h.sends.length, 0);
});

test('creator-fee claims verify actual USDC recipients and split rounding independently of the caller', async t => {
  const h = await fixture(t, { claimRecipients: [{ recipient: TREASURY, bps: 7000 }, { recipient: CONTROLLER, bps: 3000 }] });
  assert.equal((await execute(h, await prepare(h))).action.status, 'confirmed');
  const claim = await h.agent.dispatch('argus_prepare_management', { idempotencyKey: 'claim-fixture', token: TOKEN, operation: 'claim_fees' });
  assert.equal(claim.error, undefined, JSON.stringify(claim));
  const result = await execute(h, claim.action);
  assert.equal(result.error, undefined, JSON.stringify(result));
  const evidence = result.action.steps[0].receipt;
  assert.equal(evidence.actualCreatorFeesUsdcRaw, '101');
  assert.deepEqual(evidence.payouts.map(part => [part.recipient.toLowerCase(), part.amountRaw]), [[TREASURY, '70'], [CONTROLLER, '31']]);
  assert.ok(evidence.payouts.every(part => part.recipient.toLowerCase() !== OPERATOR));
});

test('creator claim events alone cannot confirm missing, redirected or short actual payments', async t => {
  for (const change of ['no transfers', 'wrong recipient', 'underpayment', 'wrong asset', 'no claim event']) await t.test(change, async t => {
    const h = await fixture(t, { changeReceipt: (receipt, _tx, plan) => {
      if (plan?.expected.operation !== 'claim_fees') return;
      if (change === 'no transfers') receipt.logs = receipt.logs.slice(0, 1);
      if (change === 'no claim event') receipt.logs = receipt.logs.slice(1);
      if (['wrong recipient', 'underpayment', 'wrong asset'].includes(change)) receipt.logs[1] = eventLog(
        change === 'wrong asset' ? TOKEN : addresses.defaultQuoteAsset, erc20Abi, 'Transfer', {
          from: ESCROW, to: change === 'wrong recipient' ? OTHER : CONTROLLER, value: change === 'underpayment' ? 100n : 101n });
    } });
    assert.equal((await execute(h, await prepare(h))).action.status, 'confirmed');
    const claim = await h.agent.dispatch('argus_prepare_management', { idempotencyKey: 'claim-bad-fixture', token: TOKEN, operation: 'claim_fees' });
    const result = await execute(h, claim.action);
    assert.ok(result.error, 'claim must verify actual fee delivery');
    assert.notEqual(h.store.getAction(claim.action.id).status, 'confirmed');
  });
});

test('production modes, remote RPC, relative configuration paths and zero signing roles are refused', async t => {
  const h = await fixture(t);
  await assert.rejects(createArgusAgent({ ...h.config, mode: 'mainnet' }, { client: h.client }), { code: 'ARGUS_EXECUTION_DISABLED' });
  for (const mode of ['circle-live', 'production', undefined]) {
    await assert.rejects(createArgusAgent({ ...h.config, mode }, { client: h.client }), { code: 'ARGUS_MODE_UNSUPPORTED' });
  }
  await assert.rejects(createArgusAgent({ ...h.config, rpcUrl: 'https://rpc.arc.network' }, { client: h.client }));
  await assert.rejects(createArgusAgentFromConfig('relative.json'), { code: 'ARGUS_CONFIG_REQUIRED' });
  for (const role of ['operator', 'controller', 'treasury']) {
    await assert.rejects(createArgusAgent({ ...h.config, actors: { ...h.config.actors, [role]: ZERO } },
      { client: h.client, store: h.store, contracts: h.contracts, executor: h.executor }), { code: 'ARGUS_ROLES_INVALID' });
  }
});

test('SDK rejects POSIX-readable configuration files before reading their contents', {
  skip: process.platform === 'win32' ? 'Windows uses ACLs rather than POSIX permission bits.' : false,
}, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'argus-sdk-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'unsafe-config.json');
  writeFileSync(file, 'not valid JSON', { mode: 0o644 });
  await assert.rejects(createArgusAgentFromConfig(file), { code: 'ARGUS_CONFIG_UNSAFE' });
});

test('mutating stored request terms cannot turn a saved action into a new authorized request', async t => {
  const h = await fixture(t);
  const action = await prepare(h);
  const db = new DatabaseSync(h.store.filename);
  try {
    const changed = h.store.getAction(action.id);
    changed.terms.roles.controller = OTHER;
    db.prepare('UPDATE actions SET json = ? WHERE id = ?').run(JSON.stringify(changed), action.id);
  } finally { db.close(); }
  assert.equal((await execute(h, action)).error.code, 'ARGUS_TERMS_CHANGED');
  assert.equal(h.sends.length, 0);
});

test('corrupted prepared transaction fields or expected outcomes cannot execute under unchanged request terms', async t => {
  const changes = {
    'target': action => { action.steps[0].to = OTHER; },
    'calldata': action => { action.steps[0].data = '0x12345678'; },
    'signer': action => { action.steps[0].from = OTHER; },
    'gas envelope': action => { action.steps[0].maxFeePerGas = '100000'; },
    'ABI': action => { action.steps[0].abi = []; },
    'expected recipient': action => { action.expected.treasury = OTHER; },
    'summary': action => { action.summary.spendUsdcRaw = '0'; },
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, async t => {
    const h = await fixture(t);
    const action = await prepare(h);
    const db = new DatabaseSync(h.store.filename);
    try {
      const changed = h.store.getAction(action.id);
      change(changed);
      db.prepare('UPDATE actions SET json = ? WHERE id = ?').run(JSON.stringify(changed), action.id);
    } finally { db.close(); }
    assert.equal((await execute(h, action)).error.code, 'ARGUS_TERMS_CHANGED');
    assert.equal(h.sends.length, 0);
    assert.equal(h.store.getAction(action.id).leaseId, undefined);
  });
});

test('an unready executor refuses before taking a lease or recording an uncertain submission', async t => {
  let ready = false;
  const h = await fixture(t, { executor: { preflight: async () => ({ ready }) } });
  const action = await prepare(h);
  assert.equal((await execute(h, action)).error.code, 'ARGUS_EXECUTOR_UNAVAILABLE');
  const blocked = h.store.getAction(action.id);
  assert.equal(blocked.status, 'prepared');
  assert.equal(blocked.leaseId, undefined);
  assert.ok(blocked.steps.every(step => step.status === 'ready' && step.attempt === undefined));
  assert.equal(h.sends.length, 0);
  ready = true;
  assert.equal((await execute(h, action)).action.status, 'confirmed');
  assert.equal(h.sends.length, 2);
});

test('changed payout authority or fee recipients refuse a prepared claim before submitting', async t => {
  for (const change of ['controller', 'recipients']) await t.test(change, async t => {
    const h = await fixture(t);
    assert.equal((await execute(h, await prepare(h))).action.status, 'confirmed');
    const claim = await h.agent.dispatch('argus_prepare_management', { idempotencyKey: 'claim-recheck', token: TOKEN, operation: 'claim_fees' });
    if (change === 'controller') h.setController(OTHER);
    else h.setRecipients([{ recipient: TREASURY, bps: 10_000 }]);
    const before = h.sends.length;
    assert.equal((await execute(h, claim.action)).error.code, 'ARGUS_TERMS_CHANGED');
    assert.equal(h.sends.length, before);
    assert.equal(h.store.getAction(claim.action.id).leaseId, undefined);
  });
});

test('Circle receipt settlement requires exact approved fees and a real signature', async t => {
  for (const field of ['gas', 'maxFeePerGas', 'maxPriorityFeePerGas', 'missing signature']) await t.test(field, async t => {
    const h = await fixture(t, { config: { executor: { kind: 'circle-local' } }, changeReceipt: (_receipt, tx) => {
      tx.maxPriorityFeePerGas = 0n;
      if (field === 'gas') tx.gas -= 1n;
      else if (field === 'maxFeePerGas') tx.maxFeePerGas -= 1n;
      else if (field === 'maxPriorityFeePerGas') tx.maxPriorityFeePerGas = 1n;
    } });
    const action = await prepare(h);
    const result = await execute(h, action);
    assert.equal(result.error.code, field === 'missing signature' ? 'ARGUS_SIGNATURE_MISMATCH' : 'ARGUS_RECEIPT_MISMATCH');
    assert.equal(h.sends.length, 1);
    assert.notEqual(h.store.getAction(action.id).steps[0].status, 'confirmed');
    assert.equal(h.store.listProjects().length, 0);
  });
});

test('fee preparation bounds a restored base fee when the gas-price oracle is stale low', async t => {
  const h = await fixture(t);
  const getBlock = h.client.getBlock;
  h.client.getBlock = async args => ({ ...await getBlock(args), baseFeePerGas: 11_749_663_004n });
  h.client.getGasPrice = async () => 2_720_484_261n;
  const action = await prepare(h);
  assert.ok(action.steps.every(step => step.maxFeePerGas === '23499326009'));
  assert.equal((await execute(h, action)).action.status, 'confirmed');
});

test('a fee rise before submission refuses without creating an uncertain attempt', async t => {
  for (const field of ['baseFeePerGas', 'gasPrice']) await t.test(field, async t => {
    const h = await fixture(t);
    const action = await prepare(h);
    if (field === 'baseFeePerGas') {
      const getBlock = h.client.getBlock;
      h.client.getBlock = async args => ({ ...await getBlock(args), baseFeePerGas: 4n });
    } else h.client.getGasPrice = async () => 4n;
    assert.equal((await execute(h, action)).error.code, 'ARGUS_FEE_CHANGED');
    assert.equal(h.sends.length, 0);
    assert.ok(h.store.getAction(action.id).steps.every(step => step.status === 'ready' && step.attempt === undefined));
  });
});

test('missing EIP-1559 base fee cannot prepare an unbounded transaction', async t => {
  const h = await fixture(t);
  const getBlock = h.client.getBlock;
  h.client.getBlock = async args => ({ ...await getBlock(args), baseFeePerGas: undefined });
  assert.equal((await h.agent.dispatch('argus_prepare_project', request())).error.code, 'ARGUS_FEE_UNAVAILABLE');
  assert.equal(h.sends.length, 0);
});


test('local proof configuration retains its optional independent successor signer', async t => {
  const h = await fixture(t, { config: { actors: { operator: OPERATOR, controller: CONTROLLER, treasury: TREASURY, successor: OTHER } } });
  const action = await prepare(h);
  assert.equal(action.terms.roles.successor, OTHER);
});
