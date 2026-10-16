import assert from 'node:assert/strict';
import test from 'node:test';
import { pacedReads } from '../scripts/argus-agent/rpc-reads.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('one shared queue serializes mixed project/planner/receipt reads and keeps exact arguments and results', async () => {
  let active = 0; let peak = 0;
  const starts = []; const seen = [];
  const raw = Object.fromEntries(['readContract', 'getTransactionReceipt', 'getBlockNumber', 'call', 'getLogs'].map(method => [method, async (...args) => {
    starts.push(Date.now()); seen.push({ method, args }); active++; peak = Math.max(peak, active);
    try { await delay(2); return { method, args }; } finally { active--; }
  }]));
  const project = pacedReads(raw, 20);
  const receipt = pacedReads(raw, 20);
  assert.equal(project, receipt);
  assert.equal(pacedReads(project, 250), project);
  assert.equal(pacedReads(project, 0), project, 'a wrapped production queue cannot be disabled by a downstream caller');
  const args = [{ blockNumber: 123n }, { hash: `0x${'11'.repeat(32)}` }, undefined, { data: '0x1234' }, { fromBlock: 123n, toBlock: 123n }];
  const names = ['readContract', 'getTransactionReceipt', 'getBlockNumber', 'call', 'getLogs'];
  const results = await Promise.all(names.map((name, index) => (index % 2 ? receipt : project)[name](args[index])));
  assert.equal(peak, 1);
  assert.deepEqual(results, seen);
  assert.deepEqual(seen, names.map((method, index) => ({ method, args: [args[index]] })));
  for (let index = 1; index < starts.length; index++) assert.ok(starts[index] - starts[index - 1] >= 15, 'reads retain their configured start spacing');
});

test('failed reads reject once with the original error and leave later work usable without retry', async () => {
  const failure = new Error('Fixture failure'); let reads = 0;
  const raw = { readContract: async () => { reads++; if (reads === 1) throw failure; return 42n; } };
  const client = pacedReads(raw, 1);
  const outcomes = await Promise.allSettled([client.readContract({}), client.readContract({})]);
  assert.equal(outcomes[0].reason, failure); assert.equal(outcomes[1].value, 42n); assert.equal(reads, 2);
});

test('pacing preserves client properties, polling and unrelated methods, and supports explicit zero-delay fixtures', async () => {
  const polling = async request => request;
  const raw = { chain: { id: 5042 }, waitForTransactionReceipt: polling, readContract: async () => 1n, custom: 'retained' };
  assert.equal(pacedReads(raw, 0), raw);
  const client = pacedReads(raw, 1);
  assert.equal(client.chain, raw.chain); assert.equal(client.custom, 'retained');
  assert.equal(client.waitForTransactionReceipt, polling);
  assert.equal(client.getLogs, undefined);
  assert.deepEqual(Object.keys(client), Object.keys(raw));
  for (const interval of [-1, 1001, 0.1, null, NaN]) assert.throws(() => pacedReads(raw, interval), { code: 'ARGUS_RPC_PACING_INVALID' });
});
