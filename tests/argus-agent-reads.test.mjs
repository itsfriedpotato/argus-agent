import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { getAddress, zeroAddress } from 'viem';
import { createReadOperations } from '../scripts/argus-agent/reads.mjs';
import { createStore } from '../scripts/argus-agent/store.mjs';
import { CURRENT_TIME_LOCK } from '../scripts/argus-agent/locks.mjs';
import { catalog } from '../scripts/argus-agent/catalog.mjs';

const bundle = JSON.parse(readFileSync(new URL('../scripts/argus-agent/vendor/argus-v4.json', import.meta.url), 'utf8'));
const A = getAddress(`0x${'11'.repeat(20)}`), B = getAddress(`0x${'22'.repeat(20)}`);
const TOKEN = getAddress(`0x${'55'.repeat(20)}`), HOOK = getAddress(`0x${'66'.repeat(20)}`), ESCROW = getAddress(`0x${'77'.repeat(20)}`);
const HASH = `0x${'ab'.repeat(32)}`;
const lock = (extra = {}) => ({ token: TOKEN, owner: A, amount: 1_000_000_000_000_000_001n,
  lockedAt: 100, unlockAt: 900, withdrawn: false, ...extra });

function fixture({ overrides = {}, projects = [], store, chainId = 5042, reorg = false } = {}) {
  const calls = []; let blockCalls = 0;
  const client = {
    getChainId: async () => chainId,
    getBlock: async request => {
      calls.push({ method: 'getBlock', ...request }); blockCalls++;
      return { number: request.blockNumber ?? 900n, timestamp: 1000n, hash: reorg && blockCalls > 1 ? `0x${'cd'.repeat(32)}` : HASH };
    },
    getCode: async request => { calls.push({ method: 'getCode', ...request }); return overrides.code ?? '0x1234'; },
    getLogs: async request => {
      calls.push({ method: 'getLogs', ...request });
      return [{ args: { token: TOKEN, description: 'A fixture token', imageURI: 'ipfs://fixture-image' } }];
    },
    readContract: async request => {
      calls.push({ method: 'readContract', ...request });
      if (Object.hasOwn(overrides, request.functionName)) {
        const value = overrides[request.functionName];
        if (value instanceof Error) throw value;
        return typeof value === 'function' ? value(request) : value;
      }
      switch (request.functionName) {
        case 'creatorRegistry': return bundle.portal8.addresses.creatorRegistry;
        case 'launches': return [HOOK, ESCROW, A, 1n, 0, 200, false];
        case 'payoutOf': return B;
        case 'proposedPayout': return zeroAddress;
        case 'escrowOf': return ESCROW;
        case 'payoutSplit': return [[], []];
        case 'name': return 'Read Fixture';
        case 'symbol': return request.address.toLowerCase() === bundle.portal8.addresses.defaultQuoteAsset.toLowerCase() ? 'USDC' : 'READ';
        case 'logo': return 'ipfs://fixture-image';
        case 'owedCreator': return 25_001n;
        case 'quoteAsset':
        case 'payoutAsset': return bundle.portal8.addresses.defaultQuoteAsset;
        case 'balanceOf': return request.address.toLowerCase() === bundle.portal8.addresses.defaultQuoteAsset.toLowerCase() ? 10_000_001n : 1_000_000_000_000_000_001n;
        case 'decimals': return request.address.toLowerCase() === bundle.portal8.addresses.defaultQuoteAsset.toLowerCase() ? 6 : 18;
        case 'getLock': return lock();
        case 'locksOf': return [[1n, 2n], [lock(), lock({ withdrawn: true })], 3n];
        default: throw new Error(`Unexpected read: ${request.functionName}`);
      }
    },
  };
  const local = store ?? new Proxy({ listProjects: () => structuredClone(projects) }, { get(target, key) {
    if (key !== 'listProjects') throw new Error(`Read attempted journal mutation/access: ${String(key)}`);
    return target[key];
  } });
  return { calls, client, reads: createReadOperations({ client, store: local, roles: { operator: A, controller: B, treasury: B } }) };
}

test('direct token details need no import and keep role balances on one canonical block', async () => {
  const f = fixture();
  const result = await f.reads.execute('argus_get_token_details', { token: TOKEN });
  assert.equal(result.project.name, 'Read Fixture');
  assert.equal(result.project.metadataStatus, 'launch_block_required');
  assert.equal(result.project.balances.length, 3);
  assert.equal(result.units.tokenDecimals, 18);
  assert.equal(result.units.usdcDecimals, 6);
  assert.equal(result.units.roleBalanceUsdcAsset, getAddress(bundle.portal8.addresses.defaultQuoteAsset));
  assert.equal(result.units.creatorFees.quoteAsset, result.units.roleBalanceUsdcAsset);
  assert.equal(result.units.creatorFees.decimals, 6);
  assert.equal(result.observedBlockNumber, '900');
  assert.equal(result.observedBlockHash, HASH);
  assert.equal(result.source, 'arc-rpc');
  assert.equal(result.coverage.indexedDiscovery, false);
  assert.ok(f.calls.filter(call => call.method === 'readContract').every(call => call.blockNumber === 900n));
  assert.equal(f.calls.filter(call => call.method === 'getLogs').length, 0);
});

test('token metadata reads only an explicitly supplied or saved exact launch block', async () => {
  for (const [projects, input] of [[[], { token: TOKEN, launchBlock: '400' }], [[{ token: TOKEN, launchBlock: '400' }], { token: TOKEN }]]) {
    const f = fixture({ projects });
    const result = await f.reads.execute('argus_get_token_details', input);
    assert.equal(result.project.metadataStatus, 'confirmed_event');
    const logs = f.calls.filter(call => call.method === 'getLogs');
    assert.equal(logs.length, 1);
    assert.equal(logs[0].fromBlock, 400n);
    assert.equal(logs[0].toBlock, 400n);
  }
  const future = fixture();
  await assert.rejects(future.reads.execute('argus_get_token_details', { token: TOKEN, launchBlock: '901' }), /known launch range/);
  assert.equal(future.calls.filter(call => call.method === 'getLogs').length, 0);
});

test('claim details express exact USDC, recipient split and zero eligibility without preparing anything', async () => {
  const f = fixture({ overrides: { payoutSplit: [[A, B], [6000, 4000]] } });
  const result = await f.reads.execute('argus_get_claim_details', { token: TOKEN });
  assert.deepEqual(result.claim.claimable, { raw: '25001', decimals: 6, formatted: '0.025001' });
  assert.deepEqual(result.claim.recipients, [{ recipient: A, bps: 6000 }, { recipient: B, bps: 4000 }]);
  assert.equal(result.claim.canClaim, true);
  assert.equal(result.claim.executionSupported, true);
  const zero = await fixture({ overrides: { owedCreator: 0n } }).reads.execute('argus_get_claim_details', { token: TOKEN });
  assert.equal(zero.claim.canClaim, false);
  assert.equal(zero.claim.reason, 'nothing_to_claim');
  assert.equal(zero.claim.claimable.raw, '0');
});

test('non-USDC creator fees use their actual quote units and do not mislabel payout conversion', async () => {
  const f = fixture({ overrides: { quoteAsset: A, payoutAsset: B, owedCreator: 123456789n,
    decimals: request => request.address === A ? 8 : 18,
    symbol: request => request.address === A ? 'QUOTE' : 'READ' } });
  const details = await f.reads.execute('argus_get_token_details', { token: TOKEN });
  assert.equal(details.units.roleBalanceUsdcAsset, getAddress(bundle.portal8.addresses.defaultQuoteAsset));
  assert.equal(details.units.creatorFees.quoteAsset, A);
  assert.equal(details.units.creatorFees.payoutAsset, B);
  assert.equal(details.units.creatorFees.decimals, 8);
  const result = await f.reads.execute('argus_get_claim_details', { token: TOKEN });
  assert.equal(result.claim.currency, 'QUOTE');
  assert.deepEqual(result.claim.claimable, { raw: '123456789', decimals: 8, formatted: '1.23456789' });
  assert.equal(result.claim.executionSupported, false);
  assert.equal(result.claim.amountKind, 'owed-quote-asset-before-any-payout-conversion');
  assert.ok(f.calls.filter(call => call.method === 'readContract').every(call => call.blockNumber === 900n));
});

test('known wallet balances deduplicate supplied tokens and preserve exact large amounts', async () => {
  const result = await fixture().reads.execute('argus_get_wallet_balances', { account: A, tokens: [TOKEN, TOKEN.toLowerCase()] });
  assert.equal(result.portfolio.holdings.length, 1);
  assert.equal(result.portfolio.usdc.formatted, '10.000001');
  assert.deepEqual(result.portfolio.holdings[0].balance, { raw: '1000000000000000001', decimals: 18, formatted: '1.000000000000000001' });
  const f = fixture();
  const usdcOnly = await f.reads.execute('argus_get_wallet_balances', { account: A, tokens: [] });
  assert.deepEqual(usdcOnly.portfolio.holdings, []);
  assert.equal(f.calls.filter(call => call.functionName === 'launches').length, 0);
});

test('unsupported tokens and RPC errors fail explicitly rather than returning zero balances or claims', async () => {
  await assert.rejects(fixture({ overrides: { launches: [zeroAddress] } }).reads.execute('argus_get_token_details', { token: TOKEN }), { code: 'UNSUPPORTED' });
  await assert.rejects(fixture({ overrides: { balanceOf: new Error('RPC unavailable') } }).reads.execute('argus_get_wallet_balances', { account: A, tokens: [TOKEN] }), /RPC unavailable/);
  await assert.rejects(fixture({ overrides: { owedCreator: new Error('RPC unavailable') } }).reads.execute('argus_get_claim_details', { token: TOKEN }), /RPC unavailable/);
});

test('lock reads distinguish unlocked, still locked and withdrawn while retaining exact deployment identity', async () => {
  for (const [value, eligible, reason] of [[lock(), true, 'unlocked'], [lock({ unlockAt: 1001 }), false, 'still_locked'], [lock({ withdrawn: true }), false, 'already_withdrawn']]) {
    const result = await fixture({ overrides: { getLock: value } }).reads.execute('argus_get_lock', { lockId: '31' });
    assert.equal(result.lock.chainId, 5042);
    assert.equal(result.lock.deployment, CURRENT_TIME_LOCK);
    assert.equal(result.lock.lockId, '31');
    assert.equal(result.lock.amountRaw, '1000000000000000001');
    assert.equal(result.lock.withdrawable, eligible);
    assert.equal(result.lock.withdrawalReason, reason);
  }
  await assert.rejects(fixture({ overrides: { getLock: lock({ owner: zeroAddress, token: zeroAddress, amount: 0n }) } }).reads.execute('argus_get_lock', { lockId: '0' }), { code: 'ARGUS_LOCK_NOT_FOUND' });
  await assert.rejects(fixture({ overrides: { code: '0x' } }).reads.execute('argus_get_lock', { lockId: '31' }), { code: 'ARGUS_LOCK_DEPLOYMENT_MISSING' });
});

test('lock pagination is bounded, block-pinned and exposes an exact continuation offset', async () => {
  const f = fixture();
  const first = await f.reads.execute('argus_list_locks', { owner: A, limit: 2 });
  assert.equal(first.nextOffset, '2');
  assert.equal(first.total, '3');
  assert.equal(first.locks[1].withdrawn, true);
  const call = f.calls.find(item => item.functionName === 'locksOf');
  assert.deepEqual(call.args, [A, 0n, 2n]);
  assert.equal(call.blockNumber, 900n);
  const next = fixture({ overrides: { locksOf: [[3n], [lock()], 3n] } });
  const last = await next.reads.execute('argus_list_locks', { owner: A, offset: first.nextOffset, limit: 2, blockNumber: first.observedBlockNumber });
  assert.equal(last.nextOffset, null);
  assert.equal(last.observedBlockNumber, '900');
  assert.equal(next.calls[0].blockNumber, 900n);
  const beyond = await fixture({ overrides: { locksOf: [[], [], 3n] } }).reads.execute('argus_list_locks', { owner: A, offset: '10' });
  assert.deepEqual(beyond.locks, []);
  assert.equal(beyond.nextOffset, null);
});

test('invalid or cross-owner lock pages are rejected', async () => {
  for (const value of [[[1n], [], 1n], [[1n, 1n], [lock(), lock()], 2n], [[1n], [lock({ owner: B })], 1n], [[1n, 2n], [lock(), lock()], 1n]]) {
    await assert.rejects(fixture({ overrides: { locksOf: value } }).reads.execute('argus_list_locks', { owner: A, limit: 2 }), { code: 'ARGUS_LOCK_PAGE_INVALID' });
  }
  await assert.rejects(fixture().reads.execute('argus_list_locks', { owner: A, limit: 1 }), { code: 'ARGUS_LOCK_PAGE_INVALID' });
});

test('empty and short lock pages cannot falsely terminate pagination before the pinned total', async () => {
  for (const [page, offset] of [
    [[[], [], 3n], '0'],
    [[[1n], [lock()], 3n], '0'],
    [[[], [], 3n], '2'],
  ]) {
    await assert.rejects(fixture({ overrides: { locksOf: page } }).reads.execute('argus_list_locks', {
      owner: A, offset, limit: 2, blockNumber: '900',
    }), { code: 'ARGUS_LOCK_PAGE_INVALID' });
  }
});

test('invalid bounds are rejected before any RPC reads', async () => {
  for (const [name, input] of [
    ['argus_get_wallet_balances', { account: A, tokens: Array(21).fill(TOKEN) }],
    ['argus_get_lock', { lockId: (2n ** 256n).toString() }],
    ['argus_get_lock', { lockId: '1'.repeat(1000) }],
    ['argus_get_lock', { lockId: 'bad' }],
    ['argus_get_lock', { lockId: '1.5' }],
    ['argus_get_lock', { lockId: '1', blockNumber: 'bad' }],
    ['argus_get_lock', { lockId: '1', blockNumber: '1.5' }],
    ['argus_list_locks', { owner: A, offset: '-1' }],
    ['argus_list_locks', { owner: A, offset: 'bad' }],
    ['argus_list_locks', { owner: A, offset: '1.5' }],
    ['argus_list_locks', { owner: A, offset: '1'.repeat(1000) }],
    ['argus_list_locks', { owner: A, limit: 51 }],
    ['argus_list_locks', { owner: A, blockNumber: '0x123' }],
    ['argus_list_locks', { owner: A, blockNumber: 'bad' }],
    ['argus_list_locks', { owner: A, blockNumber: '1.5' }],
    ['argus_list_locks', { owner: A, blockNumber: '1'.repeat(1000) }],
    ['argus_get_token_details', { token: TOKEN, launchBlock: 'bad' }],
    ['argus_search_projects', { query: '   ' }],
  ]) {
    const f = fixture();
    await assert.rejects(f.reads.execute(name, input), { code: 'ARGUS_INVALID_ARGUMENTS' });
    assert.equal(f.calls.length, 0);
  }
});

test('reorg and wrong-chain observations are refused for reads', async () => {
  await assert.rejects(fixture({ reorg: true }).reads.execute('argus_get_claim_details', { token: TOKEN }), { code: 'ARGUS_READ_SNAPSHOT_CHANGED' });
  await assert.rejects(fixture({ chainId: 1 }).reads.execute('argus_get_lock', { lockId: '1' }), { code: 'ARGUS_READ_CHAIN_MISMATCH' });
});

test('saved search is local, case-insensitive, trimmed and paginated with honest coverage', async () => {
  const projects = [{ token: TOKEN, brand: { name: 'Blue Garden', symbol: 'BLU' } }, { token: A, name: 'Blue Sky', symbol: 'SKY' }, { token: B, brand: { name: 'Other', symbol: 'OTH' } }];
  const f = fixture({ projects });
  const first = await f.reads.execute('argus_search_projects', { query: ' BLUE ', limit: 1 });
  assert.equal(first.projects[0].token, TOKEN);
  assert.equal(first.total, 2);
  assert.equal(first.nextOffset, 1);
  const last = await f.reads.execute('argus_search_projects', { query: 'blue', limit: 1, offset: first.nextOffset });
  assert.equal(last.projects[0].token, A);
  assert.equal(last.nextOffset, null);
  assert.equal(last.coverage.currentOnchainState, false);
  const symbol = await f.reads.execute('argus_search_projects', { query: 'oth' });
  assert.equal(symbol.projects[0].token, B);
  const address = await f.reads.execute('argus_search_projects', { query: TOKEN });
  assert.equal(address.projects.length, 1);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(projects[0], { token: TOKEN, brand: { name: 'Blue Garden', symbol: 'BLU' } });
});

test('all new operations are marked read-only and leave a real local journal unchanged', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'argus-read-journal-'));
  const store = createStore(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const before = { actions: store.listActions(), projects: store.listProjects(), budget: store.budget(), bytes: readFileSync(store.filename) };
  const f = fixture({ store });
  const requests = [
    ['argus_get_token_details', { token: TOKEN }], ['argus_get_claim_details', { token: TOKEN }],
    ['argus_get_wallet_balances', { account: A, tokens: [TOKEN] }], ['argus_get_lock', { lockId: '1' }],
    ['argus_list_locks', { owner: A, limit: 2 }], ['argus_search_projects', { query: 'read' }],
  ];
  for (const [name, args] of requests) {
    assert.equal(f.reads.handles(name), true);
    assert.equal(catalog.find(tool => tool.name === name).annotations.readOnlyHint, true);
    await f.reads.execute(name, args);
  }
  assert.equal(f.reads.handles('argus_execute_action'), false);
  assert.deepEqual(store.listActions(), before.actions);
  assert.deepEqual(store.listProjects(), before.projects);
  assert.deepEqual(store.budget(), before.budget);
  assert.deepEqual(readFileSync(store.filename), before.bytes);
});
