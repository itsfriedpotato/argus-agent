import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { encodeAbiParameters, encodeEventTopics, getAddress, zeroAddress } from 'viem';
import { findLaunch, lineState, PORTAL8, tokenCreatedEvent } from '../scripts/argus-agent/lines.mjs';
import { createContractAdapter } from '../scripts/argus-agent/contracts.mjs';
import { createLockAdapter, CURRENT_TIME_LOCK } from '../scripts/argus-agent/locks.mjs';
import { verifyPositionRecovery, verifyProjectImport } from '../scripts/argus-agent/project-import.mjs';
import { createStore } from '../scripts/argus-agent/store.mjs';
import { MAX_LOCK_SECONDS } from '../scripts/argus-agent/generated/time-lock.mjs';
import { L, lineChain, portalOf } from './fixtures/argus-lines-chain.mjs';

const bundle = JSON.parse(readFileSync(new URL('../scripts/argus-agent/vendor/argus-v4.json', import.meta.url), 'utf8'));
const pinned = client => (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args, blockNumber: 900n });
const hash = n => `0x${n.toString(16).padStart(64, '0')}`;

test('lookup asks Portal 8 first, then every older Portal newest first, and names line and generation', async () => {
  for (const generation of [7, 6, 5, 4, 3, 2, 1]) {
    const { client, calls } = lineChain({ generation });
    const launch = await findLaunch(pinned(client), L.TOKEN);
    assert.equal(launch.line, generation <= 2 ? 'legacy' : 'hooked');
    assert.equal(launch.generation, generation);
    assert.equal(launch.portal, getAddress(portalOf(generation).address));
    const asked = calls.filter(call => call.functionName === 'launches').map(call => getAddress(call.address));
    assert.equal(asked[0], PORTAL8);
    assert.equal(asked.at(-1), launch.portal, 'the walk stops at the Portal that knows the token');
    assert.ok(calls.every(call => call.blockNumber === 900n));
  }
});

test('a token no Portal launched is null, and a Portal that cannot answer throws rather than reading as "not ours"', async () => {
  const { client } = lineChain({ generation: 7 });
  assert.equal(await findLaunch(pinned(client), L.OTHER), null);
  const failing = { ...client, readContract: async request => {
    if (request.functionName === 'launches' && getAddress(request.address) === getAddress(portalOf(4).address)) throw new Error('RPC unavailable');
    return client.readContract(request);
  } };
  await assert.rejects(findLaunch(pinned(failing), L.OTHER), /RPC unavailable/);
});

test('line state reads taxes, payee and credit from the launch contracts and refuses a hook that disagrees with its record', async () => {
  const hooked = await lineState(pinned(lineChain({ generation: 6 }).client), await findLaunch(pinned(lineChain({ generation: 6 }).client), L.TOKEN));
  assert.equal(hooked.payee, L.CREATOR); assert.equal(hooked.buyTaxBps, 100); assert.equal(hooked.sellTaxBps, 300);
  assert.equal(hooked.creatorPayout, 'credited-then-claimed'); assert.equal(hooked.quoteAsset, L.USDC);
  const pushes = await lineState(pinned(lineChain({ generation: 4 }).client), await findLaunch(pinned(lineChain({ generation: 4 }).client), L.TOKEN));
  assert.equal(pushes.creatorPayout, 'pushed-by-distribute');
  const legacy = lineChain({ generation: 1, values: { [L.TOKEN]: { currentTaxes: [200, 100] } } });
  const state = await lineState(pinned(legacy.client), await findLaunch(pinned(legacy.client), L.TOKEN));
  assert.equal(state.buyTaxBps, 200, 'the larger of config() and currentTaxes() bounds a minimum output');
  assert.equal(state.routerSellTaxBps, 0); assert.equal(state.owedCreatorUnit, 'native-usdc-18dp'); assert.equal(state.pool, L.POOL);
  for (const values of [{ [L.HOOK]: { token: L.OTHER } }, { [L.HOOK]: { quoteAsset: L.OTHER } }]) {
    const { client } = lineChain({ generation: 7, values });
    await assert.rejects(lineState(pinned(client), await findLaunch(pinned(client), L.TOKEN)), { code: 'CONTRACT_MISMATCH' });
  }
  const forged = lineChain({ generation: 2, values: { [L.TOKEN]: { mainPool: L.OTHER } } });
  await assert.rejects(lineState(pinned(forged.client), await findLaunch(pinned(forged.client), L.TOKEN)), { code: 'CONTRACT_MISMATCH' });
});

test('project reads cover every older line with an immutable payee and no split, rotation or registry', async () => {
  for (const generation of [7, 5, 3, 1]) {
    const { client } = lineChain({ generation });
    const project = await createContractAdapter(client).readProject(L.TOKEN, { roles: { treasury: L.HUMAN } });
    assert.equal(project.generation, generation);
    assert.equal(project.controller, L.CREATOR); assert.deepEqual(project.split, []); assert.equal(project.proposed, null);
    assert.equal(project.escrow, null); assert.deepEqual(project.management, ['claim_fees']);
    assert.equal(project.balances[0].role, 'treasury');
  }
});

test('older-token metadata is the Portal\'s own TokenCreated event at a known launch block', async () => {
  const { client } = lineChain({ generation: 7 });
  const requests = [];
  const adapter = createContractAdapter({ ...client, getLogs: async request => { requests.push(request); return [{ args: { token: L.TOKEN, imageURI: 'ipfs://older' } }]; } });
  const project = await adapter.readProject(L.TOKEN, { fromBlock: 800n });
  assert.equal(project.metadataStatus, 'confirmed_event');
  assert.equal(requests[0].address, getAddress(portalOf(7).address));
  assert.equal(requests[0].event, tokenCreatedEvent('hooked'));
  assert.equal((await createContractAdapter(lineChain({ generation: 2 }).client).readProject(L.TOKEN)).metadataStatus, 'launch_block_required');
});

test('wallet balances accept any Argus launch and refuse a token no Portal launched', async () => {
  const { client } = lineChain({ generation: 5 });
  const portfolio = await createContractAdapter(client).readPortfolio({ account: L.HUMAN, tokens: [L.TOKEN] });
  assert.equal(portfolio.holdings[0].generation, 5);
  await assert.rejects(createContractAdapter(client).readPortfolio({ account: L.HUMAN, tokens: [L.OTHER] }), { code: 'UNSUPPORTED' });
});

test('older tokens refuse split and controller changes, which their contracts do not have', async () => {
  const adapter = createContractAdapter(lineChain({ generation: 6 }).client);
  for (const operation of ['set_split', 'propose_owner', 'accept_owner'])
    await assert.rejects(adapter.prepareManagement({ token: L.TOKEN, actor: L.CREATOR, operation, parts: [], newController: L.HUMAN }), { code: 'UNSUPPORTED' });
});

test('both lock kinds accept every older line and refuse a token no Portal launched', async () => {
  for (const generation of [7, 4, 1]) {
    const { client } = lineChain({ generation, values: { [L.OTHER]: { balanceOf: 10n ** 21n, allowance: 0n } } });
    const chain = { ...client, readContract: async request => request.functionName === 'MAX_LOCK_DURATION' ? BigInt(MAX_LOCK_SECONDS)
      : request.functionName === 'lockVault' ? getAddress(bundle.portal8.addresses.lockVault)
        : request.functionName === 'locked' ? 0n : client.readContract(request) };
    const locks = createLockAdapter(chain, { timeLock: CURRENT_TIME_LOCK, lockVault: bundle.portal8.addresses.lockVault });
    const input = { token: L.TOKEN, actor: L.CIRCLE, beneficiary: L.HUMAN, amountRaw: '100', inventoryRaw: '100', unlockAt: '5000' };
    assert.equal((await locks.prepareTimeLock(input)).steps.length, 2);
    assert.equal((await locks.preparePermanentLock(input)).steps.length, 2);
    await assert.rejects(locks.prepareTimeLock({ ...input, token: L.OTHER }), { code: 'UNSUPPORTED' });
  }
});

function olderReceipt(generation, { emitter, creator = L.CREATOR, poolId } = {}) {
  const portal = portalOf(generation);
  const event = tokenCreatedEvent(portal.line);
  const args = { token: L.TOKEN, creator, name: 'Older', symbol: 'OLD', imageURI: 'ipfs://older', website: '', twitter: '', telegram: '',
    ...(portal.line === 'legacy' ? { pool: L.POOL } : { poolId }) };
  const fields = event.inputs.filter(item => !item.indexed);
  const log = { address: emitter ?? portal.address, topics: encodeEventTopics({ abi: [event], eventName: 'TokenCreated', args }),
    data: encodeAbiParameters(fields, fields.map(item => args[item.name])) };
  return { status: 'success', transactionHash: hash(1), blockNumber: 10n, blockHash: hash(10), logs: [log] };
}
function importClient(generation, receiptOptions = {}) {
  const chain = lineChain({ generation });
  return { ...chain.client, getTransactionReceipt: async () => olderReceipt(generation, receiptOptions),
    getBlock: async ({ blockNumber = 20n } = {}) => ({ number: blockNumber, hash: hash(Number(blockNumber)) }) };
}

test('older launches import from their canonical TokenCreated and the Portal record, and save as verified references', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'argus-lines-import-'));
  const store = createStore(directory, { mode: 'mainnet-mvp', initialization: 'create', identity: { experimentId: 'lines-import', chainId: 5042, circleWallet: L.CIRCLE, fundingWallet: L.HUMAN } });
  t.after(() => { store.close(); rmSync(directory, { force: true, recursive: true }); });
  for (const generation of [7, 1]) {
    const poolId = generation === 7 ? (await findLaunch(pinned(lineChain({ generation }).client), L.TOKEN)).record.poolId : undefined;
    const project = await verifyProjectImport(importClient(generation, { poolId }), { launchTxHash: hash(1) });
    assert.equal(project.generation, generation); assert.equal(project.controller, L.CREATOR); assert.equal(project.creatorRegistry, null);
    assert.equal(project.brand.imageURI, 'ipfs://older');
    store.saveImportedProject({ ...project, token: generation === 7 ? project.token : L.OTHER });
  }
  assert.equal(store.listProjects().length, 2);
});

test('older imports refuse a forged emitter, a creator the Portal does not record and a pool the record does not name', async () => {
  const poolId = (await findLaunch(pinned(lineChain({ generation: 6 }).client), L.TOKEN)).record.poolId;
  await assert.rejects(verifyProjectImport(importClient(6, { poolId, emitter: L.OTHER }), { launchTxHash: hash(1) }), { code: 'ARGUS_PROJECT_UNVERIFIED' });
  await assert.rejects(verifyProjectImport(importClient(6, { poolId, creator: L.OTHER }), { launchTxHash: hash(1) }), /does not match/);
  await assert.rejects(verifyProjectImport(importClient(6, { poolId: hash(77) }), { launchTxHash: hash(1) }), /does not match/);
});

test('position recovery accepts an older launch and refuses a token no Portal launched', async () => {
  const { client } = lineChain({ generation: 4 });
  const recovery = { ...client, getBlock: async ({ blockNumber = 20n } = {}) => ({ number: blockNumber, hash: hash(Number(blockNumber)) }) };
  const position = await verifyPositionRecovery(recovery, { token: L.TOKEN, actor: L.CIRCLE });
  assert.equal(position.balanceRaw, (10n ** 21n).toString());
  await assert.rejects(verifyPositionRecovery(recovery, { token: L.OTHER, actor: L.CIRCLE }), { code: 'ARGUS_PROJECT_UNVERIFIED' });
});

test('the store refuses an older reference that is missing one of its line\'s launch parts', t => {
  const directory = mkdtempSync(join(tmpdir(), 'argus-lines-store-'));
  const store = createStore(directory, { mode: 'mainnet-mvp', initialization: 'create', identity: { experimentId: 'lines-store', chainId: 5042, circleWallet: L.CIRCLE, fundingWallet: L.HUMAN } });
  t.after(() => { store.close(); rmSync(directory, { force: true, recursive: true }); });
  const base = { verified: true, source: 'canonical-launch-receipt', chainId: 5042, token: L.TOKEN, launchTxHash: hash(1), launchBlockHash: hash(10),
    launchBlock: '10', observedBlockNumber: '20', operator: L.CREATOR, controller: L.CREATOR, portal: portalOf(2).address, line: 'legacy',
    pool: L.POOL, processor: L.PROCESSOR, locker: L.LOCKER };
  assert.throws(() => store.saveImportedProject({ ...base, processor: zeroAddress }), { code: 'INVALID_INPUT' });
  assert.throws(() => store.saveImportedProject({ ...base, line: 'v4' }), { code: 'PROJECT_UNVERIFIED' });
  assert.equal(store.saveImportedProject(base).line, 'legacy');
});

test('launching stays on Portal 8 even when the site switches that open older Portals are set', async () => {
  const script = `
    const { createContractAdapter } = await import(${JSON.stringify(new URL('../scripts/argus-agent/contracts.mjs', import.meta.url).href)});
    const at = n => '0x' + n.toString(16).padStart(40, '0');
    const client = { getChainId: async () => 5042, getBlock: async () => ({ number: 900n, timestamp: 1000n }), getCode: async () => '0x',
      readContract: async ({ functionName }) => ({ balanceOf: 10n ** 8n, allowance: 10n ** 8n, MAX_IMAGE_URI_BYTES: 512n })[functionName] };
    const prepareLaunch = async (_client, _bundle, settings) => ({ agrees: true, floor: 1n, mined: { hook: at(0xb1), escrow: at(0xb2), hookSalt: '0x' + '1'.padStart(64, '0') },
      params: { name: settings.name, symbol: settings.symbol, totalSupply: settings.totalSupply, buyTaxBps: settings.buyTaxBps, sellTaxBps: settings.sellTaxBps,
        alloc: settings.alloc, quoteAsset: settings.quote, payoutAsset: settings.payoutAsset, kothBps: 0, payoutAddress: settings.payoutAddress,
        identityProvider: '0x' + '00'.repeat(32), identitySubject: 0n, bundle: [{ to: settings.devBuyTo, amountQuote: settings.seed }], snipeExempt: [],
        meta: { imageURI: settings.imageURI, website: '', twitter: '', telegram: '', description: '' } } });
    const plan = await createContractAdapter(client, { prepareLaunch }).prepareProject({ operator: at(0xc1), controller: at(0xc2), treasury: at(0xc3),
      brand: { name: 'P', symbol: 'P', imageURI: 'ipfs://p' }, seedUsdc: '4.5', idempotencyKey: 'launch-target-check' });
    process.stdout.write(plan.steps.at(-1).to);`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, ALLOW_PORTAL7_LAUNCH: '1', ARGUS_LAUNCH_PORTAL: portalOf(7).address }, encoding: 'utf8' });
  assert.equal(getAddress(out), getAddress(bundle.launchPortal));
  // No runtime module consults the site's launch switches.
  const runtime = new URL('../scripts/argus-agent/', import.meta.url);
  for (const name of readdirSync(runtime).filter(file => file.endsWith('.mjs')))
    assert.doesNotMatch(readFileSync(new URL(name, runtime), 'utf8'), /LAUNCH_PORTAL\b|PORTAL7_LAUNCH_ALLOWED|launchPath\(/, name);
});
