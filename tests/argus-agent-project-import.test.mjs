import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { encodeAbiParameters, encodeEventTopics, zeroAddress } from 'viem';
import { verifyProjectImport, exportProjectManifest } from '../scripts/argus-agent/project-import.mjs';
import { createStore } from '../scripts/argus-agent/store.mjs';
import { createArgusAgent } from '../scripts/argus-agent/sdk.mjs';

const p8 = JSON.parse(readFileSync(new URL('../scripts/argus-agent/vendor/argus-v4.json', import.meta.url), 'utf8')).portal8;
const address = n => `0x${n.toString(16).padStart(40, '0')}`;
const hash = n => `0x${n.toString(16).padStart(64, '0')}`;
const TOKEN = address(1), CREATOR = address(2), HUMAN = address(3), CIRCLE = address(4), HOOK = address(5), ESCROW = address(6), LOCKER = address(7);
function event(name, args) {
  const abi = p8.contracts.ArgusV5Portal.abi;
  const entry = abi.find(item => item.type === 'event' && item.name === name);
  const fields = entry.inputs.filter(item => !item.indexed);
  return { address: p8.addresses.portal, topics: encodeEventTopics({ abi, eventName: name, args }), data: encodeAbiParameters(fields, fields.map(item => args[item.name])) };
}
function fixture() {
  const launchEvent = event('Launched', { token: TOKEN, creator: CREATOR, hook: HOOK, escrow: ESCROW, locker: LOCKER, positionId: 1n, tickStart: -1, tickBond: 1 });
  const metadataEvent = event('LaunchMetadata', { token: TOKEN, imageURI: 'ipfs://image', website: '', twitter: '', telegram: '', description: 'Public fixture' });
  const receipt = { status: 'success', transactionHash: hash(1), blockNumber: 10n, blockHash: hash(10), logs: [launchEvent, metadataEvent] };
  let reads = 0;
  const client = {
    getChainId: async () => 5042,
    getTransactionReceipt: async () => receipt,
    getBlock: async ({ blockNumber = 20n } = {}) => ({ number: blockNumber, hash: hash(Number(blockNumber)) }),
    readContract: async ({ functionName, blockNumber }) => {
      reads++; assert.equal(blockNumber, 20n);
      return ({ creatorRegistry: p8.addresses.creatorRegistry, launches: [HOOK, ESCROW, LOCKER, 1n, -1, 1, true], payoutOf: HUMAN,
        proposedPayout: zeroAddress, escrowOf: ESCROW, payoutSplit: [[HUMAN], [10000]], name: 'Recovered', symbol: 'RCV' })[functionName];
    },
  };
  return { client, receipt, launchEvent, metadataEvent, readCount: () => reads };
}
function workspace(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'argus-mvp-import-'));
  const config = { mode: 'mainnet-mvp', executionEnabled: false, chainId: 5042, rpcUrl: 'https://rpc.mainnet.arc.io', stateDir: directory,
    identity: { experimentId: `workspace-${directory.split('/').at(-1)}`, chainId: 5042, circleWallet: CIRCLE, fundingWallet: HUMAN },
    actors: { operator: CIRCLE, controller: HUMAN }, ...options };
  const store = createStore(directory, { mode: config.mode, initialization: 'create', identity: config.identity, budgetUsdcRaw: config.budgetUsdcRaw });
  const agents = [];
  t.after(() => {
    for (const agent of agents) agent.close();
    store.close();
    rmSync(directory, { force: true, recursive: true });
  });
  async function createAgent(dependencies) {
    const agent = await createArgusAgent(config, dependencies);
    agents.push(agent);
    return agent;
  }
  return { config, store, createAgent };
}

test('verified import distinguishes historical launch creator from current controller and working wallet', async () => {
  const { client } = fixture();
  const project = await verifyProjectImport(client, { launchTxHash: hash(1), token: TOKEN });
  assert.equal(project.token, TOKEN); assert.equal(project.operator, CREATOR); assert.equal(project.historicalCreator, CREATOR);
  assert.equal(project.controller, HUMAN); assert.equal(project.treasury, null);
  assert.equal(project.launchBlock, '10'); assert.equal(project.launchBlockHash, hash(10));
  assert.equal(project.observedBlockNumber, '20'); assert.equal(project.brand.name, 'Recovered');
  assert.equal(project.launchActionId, undefined);
});

test('token-only import requests launch receipt without scanning logs', async () => {
  let calls = 0;
  await assert.rejects(verifyProjectImport(new Proxy({}, { get: () => () => { calls++; } }), { token: TOKEN }), { code: 'ARGUS_LAUNCH_RECEIPT_REQUIRED' });
  assert.equal(calls, 0);
});

test('wrong chain, failed receipt, canonical mismatch, forged portal and mismatched token are rejected', async () => {
  const cases = [
    h => { h.client.getChainId = async () => 1; },
    h => { h.receipt.status = 'reverted'; },
    h => { h.receipt.transactionHash = hash(99); },
    h => { h.receipt.blockHash = hash(99); },
    h => { h.launchEvent.address = address(99); },
    h => { h.receipt.logs = [h.launchEvent]; },
    h => { h.receipt.logs.push(h.metadataEvent); },
    h => { h.receipt.logs.push(h.launchEvent); },
  ];
  for (const change of cases) {
    const h = fixture(); change(h);
    await assert.rejects(verifyProjectImport(h.client, { launchTxHash: hash(1) }), { code: 'ARGUS_PROJECT_UNVERIFIED' });
  }
  await assert.rejects(verifyProjectImport(fixture().client, { launchTxHash: hash(1), token: address(99) }), { code: 'ARGUS_PROJECT_UNVERIFIED' });
});

test('registry changes, inconsistent launch state and reorg during import are rejected', async () => {
  for (const field of ['creatorRegistry', 'launches', 'escrowOf', 'payoutOf']) {
    const h = fixture(); const read = h.client.readContract;
    h.client.readContract = async input => input.functionName !== field ? read(input) : field === 'launches' ? [address(99)] : field === 'payoutOf' ? zeroAddress : address(99);
    await assert.rejects(verifyProjectImport(h.client, { launchTxHash: hash(1) }), { code: 'ARGUS_PROJECT_UNVERIFIED' });
  }
  const h = fixture(); let calls = 0; const get = h.client.getBlock;
  h.client.getBlock = async input => { const block = await get(input); return ++calls > 2 ? { ...block, hash: hash(99) } : block; };
  await assert.rejects(verifyProjectImport(h.client, { launchTxHash: hash(1) }), { code: 'ARGUS_PROJECT_UNVERIFIED' });
});

test('fresh read-only workspace imports and exports without Circle executor, original journal, inventory or budget changes', async t => {
  const { config, store, createAgent } = workspace(t);
  const { client } = fixture();
  const agent = await createAgent({ client, readIntervalMs: 0, contracts: { readProject: async () => ({ token: TOKEN, controller: HUMAN, name: 'Recovered' }) } });
  const before = store.budget();
  const imported = await agent.dispatch('argus_import_project', { launchTxHash: hash(1) });
  assert.equal(imported.error, undefined, JSON.stringify(imported));
  assert.equal(imported.project.controller, HUMAN);
  assert.equal((await agent.dispatch('argus_list_projects')).projects.length, 1);
  const current = await agent.dispatch('argus_get_project', { token: TOKEN });
  assert.equal(current.management.url, `https://argus.world/token/${TOKEN}`);
  assert.equal(current.management.requiredSigner, HUMAN);
  assert.equal(store.getInventory(TOKEN, CIRCLE).availableRaw, '0'); assert.deepEqual(store.listActions(), []); assert.deepEqual(store.budget(), before);
  const result = await agent.dispatch('argus_export_projects');
  assert.deepEqual(result.manifest.projects, [{ token: TOKEN, launchTxHash: hash(1), launchBlock: '10' }]);
  assert.equal(JSON.stringify(result.manifest).includes(config.identity.experimentId), false);
  assert.equal(JSON.stringify(result.manifest).includes(CIRCLE), false);
  const disabled = await agent.dispatch('argus_execute_action', { actionId: '00000000-0000-4000-8000-000000000000' });
  assert.equal(disabled.error.code, 'ARGUS_EXECUTION_DISABLED');
  assert.equal((await agent.dispatch('argus_prepare_project', { idempotencyKey: 'readonly-launch', brand: { name: 'No', symbol: 'NO', description: '', imageURI: 'ipfs://image' } })).error.code, 'ARGUS_EXECUTION_DISABLED');
});

test('human management and default human treasury return browser signing directions without wallet executor', async t => {
  const { store, createAgent } = workspace(t); const { client } = fixture();
  const project = await verifyProjectImport(client, { launchTxHash: hash(1) }); store.saveImportedProject(project);
  const agent = await createAgent({ client, readIntervalMs: 0, contracts: { readProject: async () => ({ controller: HUMAN, proposed: address(9) }) } });
  for (const [name, args, signer] of [
    ['argus_prepare_management', { operation: 'set_split', parts: [] }, HUMAN],
    ['argus_prepare_management', { operation: 'accept_owner' }, address(9)],
    ['argus_prepare_trade', { side: 'buy', amountIn: '0.01' }, HUMAN],
    ['argus_prepare_lock', { operation: 'permanent', amountRaw: '1' }, HUMAN],
  ]) {
    const result = await agent.dispatch(name, { token: TOKEN, idempotencyKey: 'human-directed-action', ...args });
    assert.equal(result.status, 'needs_human_signature', JSON.stringify(result));
    assert.equal(result.management.requiredSigner, signer);
  }
  assert.equal(store.listActions().length, 0);
});

test('reimport is idempotent, refreshes current controller and never changes launch provenance', async t => {
  const { store } = workspace(t); const { client } = fixture();
  const project = await verifyProjectImport(client, { launchTxHash: hash(1) });
  store.saveImportedProject(project); store.saveImportedProject(project);
  const updated = store.saveImportedProject({ ...project, controller: address(8), observedBlockNumber: '21' });
  assert.equal(updated.controller, address(8)); assert.equal(store.listProjects().length, 1);
  assert.throws(() => store.saveImportedProject({ ...project, launchTxHash: hash(2) }), { code: 'PROJECT_CONFLICT' });
  assert.throws(() => store.saveImportedProject({ ...project, verified: false }), { code: 'PROJECT_UNVERIFIED' });
  assert.throws(() => store.saveImportedProject({ ...project, launchActionId: 'injected' }), { code: 'PROJECT_UNVERIFIED' });
  assert.equal(store.getInventory(TOKEN, CIRCLE).availableRaw, '0');
});

test('MVP workspace identity and budget cannot overwrite the closed pilot or change on open', t => {
  const { config, store } = workspace(t, { budgetUsdcRaw: '5000000' });
  assert.equal(store.budget().limitWei, '5000000000000000000');
  for (const options of [{ mode: 'mainnet' }, { identity: { ...config.identity, experimentId: 'changed' } }, { budgetUsdcRaw: '10000000' }]) {
    assert.throws(() => createStore(config.stateDir, { mode: 'mainnet-mvp', initialization: 'open', identity: config.identity, budgetUsdcRaw: '5000000', ...options }));
  }
  assert.throws(() => createStore(config.stateDir, { mode: 'mainnet-mvp', initialization: 'auto', identity: config.identity }), { code: 'MAINNET_STATE_POLICY' });
  assert.deepEqual(exportProjectManifest([]).projects, []);
});

const position = (extra = {}) => ({ verified: true, source: 'canonical-position-snapshot', chainId: 5042, token: TOKEN, actor: CIRCLE,
  balanceRaw: '1000', observedBlockNumber: '20', observedBlockHash: hash(20), ...extra });
const workingAction = (extra = {}) => ({ idempotencyKey: `working-action-${Math.random()}`, termsHash: 'fixture', terms: { chainId: 5042 }, kind: 'trade',
  expected: { token: TOKEN, actor: CIRCLE, side: 'sell', currencyIn: TOKEN, amountInRaw: '100' }, principalRaw: '0', summary: {},
  steps: [{ from: CIRCLE, gasReserveWei: '1000000000000000' }], ...extra });
function settle(store, action, extra = {}) {
  const running = store.reserveExecution(action.id);
  const txHash = hash(Number.parseInt(action.id.slice(0, 8), 16));
  store.beforeSubmit(action.id, 0, { from: CIRCLE, attemptId: action.id, leaseId: running.leaseId, blockNumber: '21' });
  store.submitted(action.id, 0, { hash: txHash });
  store.confirmStep(action.id, 0, { state: 'confirmed', verified: true, hash: txHash, networkFeeWei: '1000', blockNumber: '21', ...extra });
}
async function importedWorkspace(t) {
  const h = workspace(t); h.store.saveImportedProject(await verifyProjectImport(fixture().client, { launchTxHash: hash(1) })); return h;
}

test('position checkpoints recover inventory, reserve later sells, and retain USDC spend when refreshed', async t => {
  const { store } = await importedWorkspace(t);
  const initial = store.budget(); store.saveRecoveredPosition(position());
  assert.equal(store.getInventory(TOKEN, CIRCLE).availableRaw, '1000'); assert.deepEqual(store.budget(), initial);
  const action = store.prepare(workingAction());
  assert.equal(store.getInventory(TOKEN, CIRCLE).availableRaw, '900');
  assert.throws(() => store.saveRecoveredPosition(position()), { code: 'POSITION_ACTIONS_UNRESOLVED' });
  settle(store, action);
  assert.equal(store.getInventory(TOKEN, CIRCLE).availableRaw, '900');
  const spent = store.budget().spentWei;
  assert.throws(() => store.saveRecoveredPosition(position()), { code: 'POSITION_STALE' });
  store.saveRecoveredPosition(position({ balanceRaw: '900', observedBlockNumber: '22', observedBlockHash: hash(22) }));
  assert.equal(store.getInventory(TOKEN, CIRCLE).availableRaw, '900', 'completed earlier sell is not subtracted twice');
  assert.equal(store.budget().spentWei, spent, 'position recovery cannot reset the spending budget');
  const next = store.prepare(workingAction()); settle(store, next);
  assert.equal(store.getInventory(TOKEN, CIRCLE).availableRaw, '800');
});

test('recovered Circle lock permits one verified withdrawal without its original action journal', async t => {
  const { store } = await importedWorkspace(t);
  const deployment = '0xFEe1d11d4501D66D8eA1024dc198ee5663c2bf6B';
  store.saveRecoveredPosition(position({ balanceRaw: '0', lock: { deployment, lockId: '99', token: TOKEN, owner: CIRCLE, amountRaw: '90', unlockAt: '1000', withdrawn: false } }));
  const input = () => workingAction({ kind: 'lock', expected: { token: TOKEN, actor: CIRCLE, operation: 'withdraw', deployment, lockId: '99', amountRaw: '90' } });
  const action = store.prepare(input());
  assert.match(action.inventorySourceActionId, /^recovered-lock:/);
  assert.throws(() => store.prepare(input()), { code: 'LOCK_ALREADY_RESERVED' });
  assert.equal(store.getInventory(TOKEN, CIRCLE).availableRaw, '0');
  settle(store, action, { tokenAddress: TOKEN, deployment, lockId: '99', walletReceivedAmountRaw: '81' });
  assert.equal(store.getInventory(TOKEN, CIRCLE).availableRaw, '81');
  assert.throws(() => store.prepare(input()), { code: 'LOCK_ALREADY_RESERVED' });
});

test('unimported project, wrong actor, forged deployment and human-owned lock cannot grant Circle authority', async t => {
  const { store } = workspace(t);
  assert.throws(() => store.saveRecoveredPosition(position()), { code: 'PROJECT_UNVERIFIED' });
  store.saveImportedProject(await verifyProjectImport(fixture().client, { launchTxHash: hash(1) }));
  assert.throws(() => store.saveRecoveredPosition(position({ actor: HUMAN })), { code: 'POSITION_UNVERIFIED' });
  assert.throws(() => store.saveRecoveredPosition(position({ verified: false })), { code: 'POSITION_UNVERIFIED' });
  const lock = { deployment: '0xFEe1d11d4501D66D8eA1024dc198ee5663c2bf6B', lockId: '99', token: TOKEN, owner: HUMAN, amountRaw: '90', unlockAt: '1000', withdrawn: false };
  assert.throws(() => store.saveRecoveredPosition(position({ lock: { ...lock, deployment: address(99) } })), { code: 'POSITION_UNVERIFIED' });
  store.saveRecoveredPosition(position({ lock }));
  assert.throws(() => store.prepare(workingAction({ kind: 'lock', expected: { token: TOKEN, actor: CIRCLE, operation: 'withdraw', deployment: lock.deployment, lockId: '99', amountRaw: '90' } })), { code: 'LOCK_NOT_IN_JOURNAL' });
});

test('position RPC recovery is read-only, canonical, and returns human lock handoff', async t => {
  const { store, createAgent } = await importedWorkspace(t); const { client } = fixture();
  const read = client.readContract;
  client.readContract = async input => input.functionName === 'balanceOf' ? 123n : input.functionName === 'getLock'
    ? { token: TOKEN, owner: HUMAN, amount: 90n, unlockAt: 1000n, withdrawn: false } : read(input);
  const agent = await createAgent({ client, readIntervalMs: 0 });
  const before = store.budget();
  const result = await agent.dispatch('argus_recover_position', { token: TOKEN, lockId: '99' });
  assert.equal(result.error, undefined, JSON.stringify(result)); assert.equal(result.inventory.availableRaw, '123');
  assert.equal(result.status, 'needs_human_signature'); assert.equal(result.management.requiredSigner, HUMAN);
  assert.deepEqual(store.budget(), before); assert.equal(store.listActions().length, 0);
});

test('cancel releases unsent reservations and unblocks position recovery without removing history or allowing replay', async t => {
  const { store } = await importedWorkspace(t); store.saveRecoveredPosition(position());
  const action = store.prepare(workingAction());
  assert.equal(store.getInventory(TOKEN, CIRCLE).availableRaw, '900');
  const cancelled = store.cancelAction(action.id);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.steps[0].status, 'not-executed');
  assert.equal(store.getInventory(TOKEN, CIRCLE).availableRaw, '1000'); assert.equal(store.budget().reservedWei, '0');
  assert.deepEqual(store.cancelAction(action.id), cancelled);
  assert.equal(store.prepare({ ...workingAction(), idempotencyKey: action.idempotencyKey }).id, action.id);
  assert.throws(() => store.reserveExecution(action.id), { code: 'ACTION_LOCKED' });
  assert.doesNotThrow(() => store.saveRecoveredPosition(position())); assert.equal(store.listActions().length, 1);
});

test('cancel refuses unknown submissions and preserves confirmed approval fees when cancelling only the tail', async t => {
  const { store } = await importedWorkspace(t); store.saveRecoveredPosition(position());
  const prepared = store.prepare(workingAction({ steps: [{ from: CIRCLE, gasReserveWei: '1000000000000000' }, { from: CIRCLE, gasReserveWei: '1000000000000000' }] }));
  const running = store.reserveExecution(prepared.id);
  store.beforeSubmit(prepared.id, 0, { from: CIRCLE, attemptId: prepared.id, leaseId: running.leaseId, blockNumber: '21' });
  store.markUnknown(prepared.id, 0);
  assert.throws(() => store.cancelAction(prepared.id), { code: 'CANCELLATION_UNSAFE' });
  store.submitted(prepared.id, 0, { hash: hash(987) });
  store.confirmStep(prepared.id, 0, { state: 'confirmed', verified: true, hash: hash(987), networkFeeWei: '1000', blockNumber: '21' });
  const cancelled = store.cancelAction(prepared.id);
  assert.equal(cancelled.steps[0].status, 'confirmed'); assert.equal(cancelled.steps[0].hash, hash(987));
  assert.equal(cancelled.steps[1].status, 'not-executed'); assert.equal(store.budget().spentWei, '1000');
  assert.equal(store.budget().reservedWei, '0'); assert.equal(store.getInventory(TOKEN, CIRCLE).availableRaw, '1000');
});

test('withdrawal follows the actual Circle lock owner even when the default token treasury is human', async t => {
  const { store, createAgent } = await importedWorkspace(t); const { client } = fixture();
  const deployment = '0xFEe1d11d4501D66D8eA1024dc198ee5663c2bf6B';
  store.saveRecoveredPosition(position({ lock: { deployment, lockId: '99', token: TOKEN, owner: CIRCLE, amountRaw: '90', unlockAt: '1000', withdrawn: false } }));
  const read = client.readContract; client.readContract = async input => input.functionName === 'getLock' ? { token: TOKEN, owner: CIRCLE } : read(input);
  const agent = await createAgent({ client, readIntervalMs: 0 });
  const result = await agent.dispatch('argus_prepare_lock', { idempotencyKey: 'actual-owner-withdraw', token: TOKEN, operation: 'withdraw', amountRaw: '90', lockId: '99' });
  assert.equal(result.error.code, 'ARGUS_EXECUTION_DISABLED', 'Circle owner can use enabled executor rather than being misdirected to default human treasury');
  const humanClient = { ...client, readContract: async input => input.functionName === 'getLock' ? { token: TOKEN, owner: HUMAN } : read(input) };
  const human = await createAgent({ client: humanClient, readIntervalMs: 0 });
  const handoff = await human.dispatch('argus_prepare_lock', { idempotencyKey: 'human-owned-withdraw', token: TOKEN, operation: 'withdraw', amountRaw: '90', lockId: '99' });
  assert.equal(handoff.management.url, 'https://argus.world/lock'); assert.equal(handoff.management.lockId, '99');
});

test('MVP tool discovery, saved project listing and export work offline without checking public RPC', async t => {
  const { store, createAgent } = await importedWorkspace(t);
  let calls = 0;
  const offline = { getChainId: async () => { calls++; throw new Error('Offline fixture must not contact RPC'); } };
  const agent = await createAgent({ client: offline, readIntervalMs: 0 });
  assert.ok(agent.catalog.some(tool => tool.name === 'argus_import_project'));
  assert.equal((await agent.dispatch('argus_list_projects')).projects.length, 1);
  assert.equal((await agent.dispatch('argus_export_projects')).manifest.projects.length, 1);
  assert.equal(calls, 0);
  assert.equal(store.listActions().length, 0);
});

test('MVP defers chain validation until on-chain reads and refuses wrong chain without execution', async t => {
  const { store, createAgent } = await importedWorkspace(t);
  let calls = 0; let reads = 0; let sends = 0;
  const client = { getChainId: async () => { calls++; return 1; } };
  const agent = await createAgent({ client, readIntervalMs: 0,
    contracts: { readProject: async () => { reads++; } }, executor: { execute: async () => { sends++; } } });
  assert.equal(calls, 0);
  for (const [name, args] of [
    ['argus_get_project', { token: TOKEN }],
    ['argus_get_action', { actionId: '00000000-0000-4000-8000-000000000000' }],
    ['argus_import_project', { launchTxHash: hash(1) }],
    ['argus_recover_position', { token: TOKEN }],
  ]) {
    const result = await agent.dispatch(name, args);
    assert.ok(['ARGUS_RPC_UNSAFE', 'ARGUS_PROJECT_UNVERIFIED'].includes(result.error?.code), JSON.stringify(result));
  }
  assert.equal(calls, 4); assert.equal(reads, 0); assert.equal(sends, 0); assert.equal(store.listActions().length, 0);
});

test('SDK returns actionable safe schema and unknown-operation messages without exposing unexpected failures', async t => {
  const { createAgent } = workspace(t);
  let calls = 0;
  const agent = await createAgent({ client: { getChainId: async () => { calls++; throw new Error('private-provider-detail'); } }, readIntervalMs: 0 });
  const invalid = await agent.dispatch('argus_get_project', { token: TOKEN, unexpected: true });
  assert.equal(invalid.error.code, 'ARGUS_INVALID_ARGUMENTS'); assert.match(invalid.error.message, /Read its tool schema/);
  const unknown = await agent.dispatch('argus_does_not_exist');
  assert.equal(unknown.error.code, 'ARGUS_UNKNOWN_OPERATION'); assert.equal(unknown.error.message, 'Unknown Argus operation.');
  assert.equal(calls, 0);
  const provider = await agent.dispatch('argus_get_project', { token: TOKEN });
  assert.equal(provider.error.code, 'ARGUS_OPERATION_FAILED'); assert.equal(JSON.stringify(provider).includes('private-provider-detail'), false);
});
