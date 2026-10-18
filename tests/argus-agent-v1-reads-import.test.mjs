import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { encodeAbiParameters, encodeEventTopics, getAddress, zeroAddress } from 'viem';
import { LEGACY_PORTALS, legacyPortalAbi } from '../scripts/argus-agent/legacy-contracts.mjs';
import { poolIdFor, poolKeyFor, v3PoolAddress } from '../scripts/argus-agent/generated/pool.mjs';
import { verifyProjectImport, verifyPositionRecovery } from '../scripts/argus-agent/project-import.mjs';
import { createReadOperations } from '../scripts/argus-agent/reads.mjs';
import { CURRENT_TIME_LOCK } from '../scripts/argus-agent/locks.mjs';
import { createStore } from '../scripts/argus-agent/store.mjs';
import { createArgusAgent } from '../scripts/argus-agent/sdk.mjs';

const p8 = JSON.parse(readFileSync(new URL('../scripts/argus-agent/vendor/argus-v4.json', import.meta.url), 'utf8')).portal8;
const address = n => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const hash = n => `0x${n.toString(16).padStart(64, '0')}`;
const TOKEN = address(1), CREATOR = address(2), ACTOR = address(3), HOOK = address(4), SPLITTER = address(5), LOCKER = address(6), TRACKER = address(7);
const USDC = getAddress(p8.addresses.defaultQuoteAsset);

function fixture(generation = 7, overrides = {}, quote = USDC) {
  const portal = LEGACY_PORTALS.find(item => item.generation === generation);
  const launchBlock = portal.deployBlock + 10n, observedBlock = 30_000_000n;
  const poolId = poolIdFor(poolKeyFor(TOKEN, quote, HOOK)), pool = v3PoolAddress(TOKEN, quote, 10_000);
  const abi = legacyPortalAbi(portal), entry = abi.find(item => item.type === 'event' && item.name === 'TokenCreated');
  const eventArgs = { token: TOKEN, creator: CREATOR, name: 'V1 Fixture', symbol: 'OLD', poolId, pool,
    imageURI: 'ipfs://v1', website: 'https://example.com', twitter: '', telegram: '' };
  const fields = entry.inputs.filter(item => !item.indexed);
  const event = { address: portal.address, topics: encodeEventTopics({ abi, eventName: 'TokenCreated', args: eventArgs }),
    data: encodeAbiParameters(fields, fields.map(item => eventArgs[item.name])) };
  const receipt = { status: 'success', transactionHash: hash(1), blockHash: hash(launchBlock), blockNumber: launchBlock, logs: [event] };
  const calls = [];
  const client = {
    getChainId: async () => 5042,
    getTransactionReceipt: async () => receipt,
    getBlock: async ({ blockNumber = observedBlock } = {}) => ({ number: blockNumber, hash: hash(blockNumber), timestamp: 2_000_000_000n }),
    getLogs: async request => { calls.push({ method: 'getLogs', ...request }); return [{ args: eventArgs }]; },
    getCode: async () => '0x1234',
    readContract: async request => {
      calls.push({ method: 'readContract', ...request });
      assert.equal(request.blockNumber, observedBlock);
      if (Object.hasOwn(overrides, request.functionName)) return typeof overrides[request.functionName] === 'function' ? overrides[request.functionName](request) : overrides[request.functionName];
      const target = request.address.toLowerCase();
      switch (request.functionName) {
        case 'creatorRegistry': return p8.addresses.creatorRegistry;
        case 'launches':
          if (target !== portal.address.toLowerCase()) return [zeroAddress];
          return generation <= 2 ? [CREATOR, -1, 1, true, false, pool, SPLITTER, TRACKER, LOCKER, 1n]
            : [CREATOR, -1, BigInt(TOKEN) < BigInt(quote), LOCKER, HOOK, SPLITTER, 300, 400, 1n, ...(generation >= 4 ? [1] : []), ...(generation >= 6 ? [quote] : [])];
        case 'creator': return CREATOR;
        case 'creatorWallet': return CREATOR;
        case 'taxProcessor': return SPLITTER;
        case 'token': return TOKEN;
        case 'splitter': return SPLITTER;
        case 'quoteAsset': return quote;
        case 'defaultQuoteAsset': return USDC;
        case 'poolId': return poolId;
        case 'token0': return TOKEN;
        case 'token1': return USDC;
        case 'fee': return 10_000;
        case 'name': return 'V1 Fixture';
        case 'symbol': return target === USDC.toLowerCase() ? 'USDC' : target === quote.toLowerCase() ? 'QUOTE' : 'OLD';
        case 'logo': return 'ipfs://v1';
        case 'config': return [300n, 400n, 10_000n, 0n, 0n, CREATOR, 0n, 0n];
        case 'currentTaxes': return [300n, 400n];
        case 'decimals': return target === USDC.toLowerCase() ? 6 : target === quote.toLowerCase() ? 8 : 18;
        case 'balanceOf': return target === USDC.toLowerCase() ? 10_000_001n : 1_000_000_000_000_000_001n;
        case 'claimableQuote6': return 25_001n;
        case 'claimableToken18': return 1_000_000_000_000_000_001n;
        case 'claimableUsdc6': return 3_001n;
        case 'claimable': return 7_001_000_000_000_000n;
        case 'converts': return false;
        case 'getLock': return { token: TOKEN, owner: ACTOR, amount: 90n, unlockAt: 1000n, withdrawn: false };
        default: throw new Error(`Unexpected V1 read: ${request.functionName} on ${request.address}`);
      }
    },
  };
  const store = { listProjects: () => [] };
  return { portal, poolId, pool, event, eventArgs, receipt, calls, client,
    reads: createReadOperations({ client, store, roles: { operator: ACTOR } }) };
}

test('canonical V1 receipt import supports every portal shape and preserves immutable fee authority', async () => {
  for (let generation = 1; generation <= 7; generation++) {
    const f = fixture(generation);
    const project = await verifyProjectImport(f.client, { launchTxHash: hash(1), token: TOKEN });
    assert.equal(project.version, 'v1');
    assert.equal(project.portalGeneration, generation);
    assert.equal(project.portal.toLowerCase(), f.portal.address.toLowerCase());
    assert.equal(project.historicalCreator, CREATOR);
    assert.equal(project.controller, CREATOR);
    assert.equal(project.creatorRegistry, null);
    assert.equal(project.proposedController, null);
    assert.equal(project.escrow, null);
    assert.equal(project.brand.description, null);
    assert.equal(project.brand.imageURI, 'ipfs://v1');
    assert.match(project.authorityNote, /immutable/);
    assert.equal(f.calls.filter(call => call.method === 'getLogs').length, 0);
  }
});

test('V1 import rejects forged portals, removed or duplicate events, mismatched identity and fee authority', async () => {
  for (const change of [
    f => { f.event.address = address(99); },
    f => { f.event.removed = true; },
    f => { f.receipt.logs.push(f.event); },
    f => { f.receipt.blockNumber = f.portal.deployBlock - 1n; f.receipt.blockHash = hash(f.receipt.blockNumber); },
  ]) {
    const f = fixture(); change(f);
    await assert.rejects(verifyProjectImport(f.client, { launchTxHash: hash(1) }), { code: 'ARGUS_PROJECT_UNVERIFIED' });
  }
  await assert.rejects(verifyProjectImport(fixture(7, { name: 'Forged' }).client, { launchTxHash: hash(1) }), { code: 'ARGUS_PROJECT_UNVERIFIED' });
  await assert.rejects(verifyProjectImport(fixture(7, { creator: address(99) }).client, { launchTxHash: hash(1) }));
  await assert.rejects(verifyProjectImport(fixture(7, { poolId: hash(99) }).client, { launchTxHash: hash(1) }));
});

test('V1 imports reject launch and current snapshot reorgs', async () => {
  for (const snapshot of ['launch', 'observed']) {
    const f = fixture(); const original = f.client.getBlock; let calls = 0;
    f.client.getBlock = async request => {
      const block = await original(request); calls++;
      return calls > 2 && ((snapshot === 'launch') === (block.number === f.receipt.blockNumber)) ? { ...block, hash: hash(99) } : block;
    };
    await assert.rejects(verifyProjectImport(f.client, { launchTxHash: hash(1) }), { code: 'ARGUS_PROJECT_UNVERIFIED' });
  }
});

test('V1 processor fee recipient is verified separately from the historical launch sender', async () => {
  const recipient = address(99);
  const f = fixture(1, { creatorWallet: recipient, config: [300n, 400n, 10_000n, 0n, 0n, recipient, 0n, 0n] });
  const project = await verifyProjectImport(f.client, { launchTxHash: hash(1) });
  assert.equal(project.historicalCreator, CREATOR);
  assert.equal(project.operator, CREATOR);
  assert.equal(project.controller, recipient);
  assert.equal(project.capabilities.ownership, 'immutable_creator');
});

test('V1 token details use the matching TokenCreated ABI and only the exact known launch block', async () => {
  for (const generation of [1, 3, 7]) {
    const f = fixture(generation);
    const result = await f.reads.execute('argus_get_token_details', { token: TOKEN, launchBlock: f.receipt.blockNumber.toString() });
    assert.equal(result.project.version, 'v1');
    assert.equal(result.project.metadataStatus, 'confirmed_event');
    assert.equal(result.project.metadata.imageURI, 'ipfs://v1');
    assert.equal(result.units.tokenDecimals, 18);
    const logs = f.calls.filter(call => call.method === 'getLogs');
    assert.equal(logs.length, 1);
    assert.equal(logs[0].address.toLowerCase(), f.portal.address.toLowerCase());
    assert.equal(logs[0].event.name, 'TokenCreated');
    assert.equal(logs[0].event.inputs.find(field => field.name === (generation === 1 ? 'pool' : 'poolId')).type, generation === 1 ? 'address' : 'bytes32');
    assert.equal(logs[0].fromBlock, f.receipt.blockNumber);
    assert.equal(logs[0].toBlock, f.receipt.blockNumber);
  }
});

test('V1 claim reads report every credited asset in its actual units, including native and converted USDC', async () => {
  for (const generation of [3, 6, 7]) {
    const f = fixture(generation);
    const { claim } = await f.reads.execute('argus_get_claim_details', { token: TOKEN });
    assert.equal(claim.escrow, null);
    assert.equal(claim.controller, CREATOR);
    assert.equal(claim.amountKind, generation <= 4 ? 'parked-creator-fees' : 'credited-fees');
    assert.equal(claim.canClaim, true);
    assert.deepEqual(claim.recipients, [{ recipient: CREATOR, bps: 10_000 }]);
    assert.equal(claim.claimableAssets.length, generation === 7 ? 3 : 2);
    const quote = claim.claimableAssets[0];
    assert.equal(quote.decimals, generation < 6 ? 18 : 6);
    assert.equal(quote.delivery, generation < 6 ? 'native' : 'erc20');
    assert.equal(quote.formatted, '0.025001');
    assert.equal(claim.claimableAssets[1].formatted, '1.000000000000000001');
    if (generation === 7) assert.equal(claim.claimableAssets[2].formatted, '0.003001');
  }
  const zero = fixture(7, { claimableQuote6: 0n, claimableToken18: 0n, claimableUsdc6: 0n });
  const { claim } = await zero.reads.execute('argus_get_claim_details', { token: TOKEN });
  assert.equal(claim.canClaim, false);
  assert.equal(claim.reason, 'nothing_to_claim');
  assert.equal(claim.claimableAssets.length, 3);
});

test('V1 processor reads expose parked native claims rather than undistributed balances', async () => {
  for (const raw of [7_001_000_000_000_000n, 0n]) {
    const f = fixture(1, { claimable: raw });
    const { claim } = await f.reads.execute('argus_get_claim_details', { token: TOKEN });
    assert.equal(claim.feeModel, 'legacy_processor');
    assert.equal(claim.amountKind, 'parked-creator-fees');
    assert.equal(claim.claimableAssets.length, 1);
    assert.equal(claim.claimableAssets[0].decimals, 18);
    assert.equal(claim.claimableAssets[0].raw, raw.toString());
    assert.equal(claim.claimableAssets[0].delivery, 'native');
    assert.equal(claim.canClaim, raw > 0n);
    assert.equal(claim.executionSupported, true);
    assert.ok(f.calls.every(call => call.functionName !== 'creatorBucket'));
  }
});

test('V1 claim reads distinguish recipient-only Portals 3 and 4 from permissionless claims', async () => {
  for (let generation = 1; generation <= 7; generation++) {
    const f = fixture(generation);
    const restricted = generation === 3 || generation === 4;
    const { claim } = await f.reads.execute('argus_get_claim_details', { token: TOKEN });
    assert.equal(claim.canClaim, true, 'Fee availability is separate from operator authorization');
    assert.equal(claim.executionSupported, true);
    assert.equal(claim.claimPermission, restricted ? 'recipient_only' : 'permissionless');
    assert.equal(claim.requiredSigner, restricted ? CREATOR : null);
    assert.equal(claim.agentExecutionSupported, !restricted);
    assert.match(claim.permission, restricted ? /Only the immutable V1 creator-fee recipient can sign/ : /Permissionless/);
    if (restricted) assert.doesNotMatch(claim.permission, /Permissionless/);
    const recipientReads = createReadOperations({ client: f.client, store: { listProjects: () => [] }, roles: { operator: CREATOR } });
    const recipientResult = await recipientReads.execute('argus_get_claim_details', { token: TOKEN });
    assert.equal(recipientResult.claim.agentExecutionSupported, true);
    const noOperator = createReadOperations({ client: f.client, store: { listProjects: () => [] } });
    assert.equal((await noOperator.execute('argus_get_claim_details', { token: TOKEN })).claim.agentExecutionSupported, false);
  }
});

test('V1 non-USDC quote credits retain actual units separately from converted USDC', async () => {
  const quote = address(100);
  const f = fixture(7, { converts: true }, quote);
  const { claim } = await f.reads.execute('argus_get_claim_details', { token: TOKEN });
  assert.deepEqual(claim.claimableAssets[0], { kind: 'quote', asset: quote, delivery: 'erc20', currency: 'QUOTE', raw: '25001', decimals: 8, formatted: '0.00025001' });
  assert.equal(claim.claimableAssets[2].asset, USDC);
  assert.equal(claim.claimableAssets[2].decimals, 6);
  assert.equal(claim.claimableAssets[2].formatted, '0.003001');
  const details = await f.reads.execute('argus_get_token_details', { token: TOKEN });
  assert.equal(details.units.creatorFees.quoteDecimals, 8);
  assert.equal(details.units.creatorFees.payoutAsset, USDC);
  assert.equal(details.units.roleBalanceUsdcAsset, USDC);
  assert.equal(details.units.usdcDecimals, 6);
});

test('recognized native-quote V1 tokens remain readable without pretending unsupported claims are zero', async () => {
  const f = fixture(7, {}, zeroAddress);
  const details = await f.reads.execute('argus_get_token_details', { token: TOKEN });
  assert.equal(details.project.version, 'v1');
  assert.equal(details.project.quoteAsset, zeroAddress);
  assert.equal(details.units.creatorFees.executionSupported, false);
  const { claim } = await f.reads.execute('argus_get_claim_details', { token: TOKEN });
  assert.equal(claim.executionSupported, false);
  assert.equal(claim.claimableAssets, null);
  assert.equal(claim.canClaim, false);
  assert.equal(claim.reason, 'unsupported_native_quote');
  assert.equal(claim.amountKind, 'unavailable');
  assert.ok(f.calls.every(call => call.functionName !== 'claimableQuote6'));
});

test('V1 wallet balances and position recovery verify supported membership without scanning history', async () => {
  for (const generation of [1, 7]) {
    const f = fixture(generation);
    const { portfolio } = await f.reads.execute('argus_get_wallet_balances', { account: ACTOR, tokens: [TOKEN] });
    assert.equal(portfolio.holdings[0].balance.raw, '1000000000000000001');
    const position = await verifyPositionRecovery(f.client, { token: TOKEN, actor: ACTOR, lockId: '9' });
    assert.equal(position.version, 'v1');
    assert.equal(position.balanceRaw, '1000000000000000001');
    assert.equal(position.lock.deployment, CURRENT_TIME_LOCK);
    assert.equal(position.lock.lockId, '9');
    assert.equal(f.calls.filter(call => call.method === 'getLogs').length, 0);
  }
});

test('unsupported tokens and broken legacy RPC reads never grant recovered inventory', async () => {
  const absent = fixture(7, { launches: [zeroAddress] });
  await assert.rejects(verifyPositionRecovery(absent.client, { token: TOKEN, actor: ACTOR }), { code: 'ARGUS_PROJECT_UNVERIFIED' });
  assert.ok(absent.calls.every(call => call.functionName !== 'balanceOf'));
  const broken = fixture(7, { launches: request => {
    if (request.address.toLowerCase() === p8.addresses.portal.toLowerCase()) return [zeroAddress];
    throw new Error('RPC unavailable');
  } });
  await assert.rejects(verifyPositionRecovery(broken.client, { token: TOKEN, actor: ACTOR }), /RPC unavailable/);
  assert.ok(broken.calls.every(call => call.functionName !== 'balanceOf'));
});

test('V1 exact-block metadata refuses an event for another launch identity', async () => {
  for (const change of [{ creator: address(99) }, { poolId: hash(99) }]) {
    const f = fixture();
    f.client.getLogs = async () => [{ args: { ...f.eventArgs, ...change } }];
    await assert.rejects(f.reads.execute('argus_get_token_details', { token: TOKEN, launchBlock: f.receipt.blockNumber.toString() }), { code: 'CONTRACT_MISMATCH' });
  }
});

test('V1 position recovery rejects a changed observed block', async () => {
  const f = fixture(); const original = f.client.getBlock; let calls = 0;
  f.client.getBlock = async request => {
    const block = await original(request);
    return ++calls > 1 ? { ...block, hash: hash(99) } : block;
  };
  await assert.rejects(verifyPositionRecovery(f.client, { token: TOKEN, actor: ACTOR }), { code: 'ARGUS_PROJECT_UNVERIFIED' });
});

test('V1 imports persist through the public SDK and recover only verified inventory without spending', async t => {
  for (const generation of [1, 3, 6, 7]) {
    const directory = mkdtempSync(join(tmpdir(), 'argus-v1-import-'));
    const identity = { experimentId: `v1-${generation}`, chainId: 5042, circleWallet: ACTOR, fundingWallet: CREATOR };
    const store = createStore(directory, { mode: 'mainnet-mvp', initialization: 'create', identity, budgetUsdcRaw: '5000000' });
    const before = store.budget();
    const f = fixture(generation);
    const config = { mode: 'mainnet-mvp', executionEnabled: false, chainId: 5042,
      rpcUrl: 'https://rpc.mainnet.arc.io', stateDir: directory, identity,
      actors: { operator: ACTOR, controller: CREATOR }, budgetUsdcRaw: '5000000' };
    let agent = await createArgusAgent(config, { client: f.client, readIntervalMs: 0 });
    t.after(() => { agent.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
    const imported = await agent.dispatch('argus_import_project', { launchTxHash: hash(1), token: TOKEN });
    assert.equal(imported.error, undefined, JSON.stringify(imported));
    assert.equal(store.listProjects()[0].version, 'v1');
    assert.equal(store.listProjects()[0].portalGeneration, generation);
    assert.equal(store.getInventory(TOKEN, ACTOR).availableRaw, '0');
    const exported = await agent.dispatch('argus_export_projects');
    assert.deepEqual(exported.manifest.projects, [{ token: TOKEN, launchTxHash: hash(1), launchBlock: f.receipt.blockNumber.toString() }]);
    agent.close();
    agent = await createArgusAgent(config, { client: f.client, readIntervalMs: 0 });
    const listed = await agent.dispatch('argus_list_projects');
    assert.equal(listed.projects.length, 1);
    assert.equal(listed.projects[0].creatorRegistry, null);
    assert.equal(listed.projects[0].escrow, null);
    assert.equal(listed.projects[0].portalGeneration, generation);
    const current = await agent.dispatch('argus_get_project', { token: TOKEN });
    assert.equal(current.error, undefined, JSON.stringify(current));
    assert.equal(current.project.version, 'v1');
    assert.equal(current.project.controller, CREATOR);
    assert.deepEqual((await agent.dispatch('argus_export_projects')).manifest, exported.manifest);
    const recovered = await agent.dispatch('argus_recover_position', { token: TOKEN });
    assert.equal(recovered.error, undefined, JSON.stringify(recovered));
    assert.equal(store.getInventory(TOKEN, ACTOR).availableRaw, '1000000000000000001');
    assert.deepEqual(store.listActions(), []);
    assert.deepEqual(store.budget(), before);
  }
});
