import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, getAddress, parseAbi } from 'viem';
import { createContractAdapter } from '../scripts/argus-agent/contracts.mjs';
import { legacyAbis, NATIVE_USDC_EMITTER, splitterAbis, splitterImplementations, verifyLineClaim } from '../scripts/argus-agent/lines.mjs';
import { L, lineChain } from './fixtures/argus-lines-chain.mjs';

const multicall = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
  'function getEthBalance(address addr) view returns (uint256 balance)',
]);
const SCALE = 10n ** 12n;
const clone = target => `0x363d3d373d3d3d363d73${target.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;

/**
 * Line state plus an aggregate3 that executes the permissionless creator-fee calls against
 * an in-memory ledger: `pending` is unsplit fees, `credited` the splitter credit, `parked` and
 * `bucket` the legacy processor's, and `balance` the creator's native USDC (18dp).
 */
function claimChain({ generation = 6, credited = 0n, pending = 0n, parked = 0n, bucket = 0n, lockerParked = 0n, fails = [], quote, converts = false, implementation } = {}) {
  const values = { [L.SPLITTER]: { claimableQuote6: credited, converts }, [L.PROCESSOR]: { claimable: parked, creatorBucket: bucket }, [L.LOCKER]: { claimableNative18: lockerParked } };
  const chain = lineChain({ generation, quote, values });
  const ledger = { credited, pending, parked, bucket, balance: 10n ** 18n };
  const calls = [];
  const splitterAbi = splitterAbis[generation] ?? splitterAbis[5];
  const run = ({ target, callData }) => {
    const to = getAddress(target);
    const abi = to === getAddress(L.PROCESSOR) ? legacyAbis.processor : to === getAddress(L.SPLITTER) ? splitterAbi : multicall;
    const { functionName } = decodeFunctionData({ abi, data: callData });
    calls.push(functionName);
    if (fails.includes(functionName)) return { success: false, returnData: '0x' };
    const ok = (result) => ({ success: true, returnData: encodeFunctionResult({ abi, functionName, result }) });
    if (functionName === 'getEthBalance') return ok(ledger.balance);
    if (functionName === 'claimableQuote6') return ok(ledger.credited);
    if (functionName === 'claimableUsdc6') return ok(0n);
    if (functionName === 'distribute') {
      if (converts) ledger.pending = 0n;
      else if (generation >= 5) { ledger.credited += ledger.pending; ledger.pending = 0n; } else { ledger.balance += ledger.pending * SCALE; ledger.pending = 0n; }
      return ok([0n, 0n]);
    }
    if (functionName === 'claim' && abi === splitterAbi) {
      if (ledger.credited === 0n) return { success: false, returnData: '0x' };
      ledger.balance += ledger.credited * SCALE; const paid = ledger.credited; ledger.credited = 0n;
      return ok(generation === 7 ? [paid, 0n, 0n] : [paid, 0n]);
    }
    if (functionName === 'dispatch') { ledger.balance += ledger.bucket; ledger.bucket = 0n; return { success: true, returnData: '0x' }; }
    if (functionName === 'claim') {
      if (ledger.parked === 0n) return { success: false, returnData: '0x' };
      ledger.balance += ledger.parked; const paid = ledger.parked; ledger.parked = 0n; return ok(paid);
    }
    throw new Error(`Unexpected simulated call ${functionName}`);
  };
  const client = { ...chain.client,
    getCode: async () => clone(implementation ?? splitterImplementations[generation] ?? L.OTHER),
    call: async ({ data, blockNumber }) => {
      assert.equal(blockNumber, 900n, 'simulations are pinned to the observed block');
      const snapshot = { ...ledger };
      const { args: [batch] } = decodeFunctionData({ abi: multicall, data });
      const results = batch.map(run);
      Object.assign(ledger, snapshot); // eth_call never persists
      return { data: encodeFunctionResult({ abi: multicall, functionName: 'aggregate3', result: results }) };
    } };
  return { client, calls, adapter: createContractAdapter(client) };
}
const claim = (adapter, extra = {}) => adapter.prepareManagement({ token: L.TOKEN, actor: L.CIRCLE, operation: 'claim_fees', ...extra });
const decoded = step => decodeFunctionData({ abi: step.abi, data: step.data });

test('Portals 5-7 split then claim for the creator when a split adds credit, as the site does', async () => {
  for (const generation of [5, 6, 7]) {
    const { adapter } = claimChain({ generation, credited: 2n, pending: 3_000_000n });
    const plan = await claim(adapter);
    assert.deepEqual(plan.steps.map(step => decoded(step).functionName), ['distribute', 'claim']);
    assert.deepEqual(decoded(plan.steps[1]).args, [L.CREATOR], 'claim(account) names the creator, never the sender');
    assert.ok(plan.steps.every(step => step.to === L.SPLITTER));
    assert.equal(plan.expected.flow, 'distribute-and-claim');
    assert.equal(plan.expected.simulatedDeliveryWei, ((3_000_000n + 2n) * SCALE).toString());
    assert.equal(plan.expected.controllerBefore, L.CREATOR);
    assert.equal(plan.summary.spendUsdcRaw, '0');
  }
});

test('Portals 5-7 claim alone when nothing new splits, and refuse when nothing is credited', async () => {
  const credited = await claim(claimChain({ generation: 6, credited: 5_000n }).adapter);
  assert.deepEqual(credited.steps.map(step => decoded(step).functionName), ['claim']);
  assert.equal(credited.expected.flow, 'claim');
  await assert.rejects(claim(claimChain({ generation: 6 }).adapter), { code: 'NOTHING_TO_CLAIM' });
  await assert.rejects(claim(claimChain({ generation: 5, pending: 9n, fails: ['distribute'] }).adapter), { code: 'NOTHING_TO_CLAIM' });
});

test('a Portal 7 converting splitter, a non-USDC pair and an unpublished splitter build are refused', async () => {
  await assert.rejects(claim(claimChain({ generation: 7, pending: 9n, converts: true }).adapter), { code: 'CONVERSION_QUEUED' });
  await assert.rejects(claim(claimChain({ generation: 7, quote: L.OTHER, converts: true }).adapter), { code: 'CONVERSION_QUEUED' });
  await assert.rejects(claim(claimChain({ generation: 6, quote: L.OTHER, credited: 9n }).adapter), { code: 'UNSUPPORTED' });
  await assert.rejects(claim(claimChain({ generation: 6, credited: 9n, implementation: L.OTHER }).adapter), { code: 'CONTRACT_MISMATCH' });
  await assert.rejects(claim(claimChain({ generation: 7, credited: 9n, implementation: splitterImplementations[6] }).adapter), { code: 'CONTRACT_MISMATCH' });
});

test('Portals 3-4 push the creator share on distribute; a parked share is creator-only and never prepared', async () => {
  for (const generation of [3, 4]) {
    const push = await claim(claimChain({ generation, pending: 4_249_002n }).adapter);
    assert.deepEqual(push.steps.map(step => decoded(step).functionName), ['distribute']);
    assert.equal(push.expected.flow, 'distribute-push');
    assert.equal(push.expected.simulatedDeliveryWei, (4_249_002n * SCALE).toString());
    await assert.rejects(claim(claimChain({ generation, credited: 7n }).adapter), { code: 'CREATOR_SIGNATURE_REQUIRED' });
    await assert.rejects(claim(claimChain({ generation }).adapter), { code: 'NOTHING_TO_CLAIM' });
  }
});

test('Portals 1-2 deliver a parked payout and an undispatched bucket; the fee locker share is creator-only', async () => {
  const parked = await claim(claimChain({ generation: 1, parked: 5n * 10n ** 15n }).adapter);
  assert.deepEqual(parked.steps.map(step => [decoded(step).functionName, ...decoded(step).args ?? []]), [['claim', L.CREATOR]]);
  assert.equal(parked.expected.payer, L.PROCESSOR);
  const both = await claim(claimChain({ generation: 2, parked: 1n, bucket: 2n }).adapter);
  assert.deepEqual(both.steps.map(step => decoded(step).functionName), ['dispatch', 'claim']);
  assert.equal(both.expected.simulatedDeliveryWei, '3');
  await assert.rejects(claim(claimChain({ generation: 2, lockerParked: 10n ** 18n }).adapter), { code: 'CREATOR_SIGNATURE_REQUIRED' });
  await assert.rejects(claim(claimChain({ generation: 1 }).adapter), { code: 'NOTHING_TO_CLAIM' });
  await assert.rejects(claim(claimChain({ generation: 1, parked: 1n, fails: ['claim'] }).adapter), { code: 'CLAIM_SIMULATION_FAILED' });
});

test('claim details report what one prepared claim would deliver now, or the exact refusal', async () => {
  const { createReadOperations } = await import('../scripts/argus-agent/reads.mjs');
  const read = async options => {
    const { client } = claimChain(options);
    const reads = createReadOperations({ client: { ...client, getBlock: async () => ({ number: 900n, timestamp: 1_000n, hash: `0x${'9'.repeat(64)}` }) }, store: { listProjects: () => [] } });
    return (await reads.execute('argus_get_claim_details', { token: L.TOKEN })).claim;
  };
  const ready = await read({ generation: 4, pending: 1_500_000n });
  assert.equal(ready.executionSupported, true); assert.equal(ready.deliverableNow.formatted, '1.5'); assert.equal(ready.deliverableNow.flow, 'distribute-push');
  assert.equal(ready.canClaim, false, 'a push lane has nothing credited; the delivery is the push');
  const refused = await read({ generation: 3, credited: 1_000_000n });
  assert.equal(refused.executionSupported, false); assert.equal(refused.refusal.code, 'CREATOR_SIGNATURE_REQUIRED');
  assert.equal(refused.creatorOnly.call, 'claim()'); assert.equal(refused.creatorOnly.contract, L.SPLITTER); assert.equal(refused.creatorOnly.amount.formatted, '1');
  // Each line in its own units: the splitter credits 6dp USDC, the legacy processor parks native 18dp USDC.
  const credited = await read({ generation: 6, credited: 2_500_000n });
  assert.equal(credited.claimable.decimals, 6); assert.equal(credited.claimable.formatted, '2.5'); assert.equal(credited.deliverableNow.formatted, '2.5');
  assert.deepEqual(credited.recipients, [{ recipient: L.CREATOR, bps: 10000 }]);
  const legacy = await read({ generation: 1, parked: 5n * 10n ** 15n });
  assert.equal(legacy.line, 'legacy'); assert.equal(legacy.claimable.decimals, 18); assert.equal(legacy.claimable.formatted, '0.005'); assert.equal(legacy.payer, L.PROCESSOR);
  const locker = await read({ generation: 2, lockerParked: 10n ** 18n });
  assert.equal(locker.canClaim, false); assert.equal(locker.creatorOnly.contract, L.LOCKER); assert.equal(locker.creatorOnly.amount.formatted, '1');
  assert.equal(locker.refusal.code, 'CREATOR_SIGNATURE_REQUIRED');
});

test('both Circle executors reproduce every claim call from the ABI the step carries, and nothing else', async () => {
  const { circleArguments } = await import('../scripts/argus-agent/circle-executor.mjs');
  const { createCircleHostedExecutor } = await import('../scripts/argus-agent/circle-hosted-executor.mjs');
  const hosted = createCircleHostedExecutor({ cliPath: resolve('/absent/cli.js'), cliHome: resolve('/absent/home'), accounts: [L.CIRCLE], authorize: async () => false,
    run: async () => { throw new Error('No Circle process may start in this test'); } });
  const plans = [await claim(claimChain({ generation: 6, pending: 5n }).adapter), await claim(claimChain({ generation: 7, credited: 5n }).adapter),
    await claim(claimChain({ generation: 4, pending: 5n }).adapter), await claim(claimChain({ generation: 2, parked: 1n, bucket: 1n }).adapter)];
  for (const step of plans.flatMap(plan => plan.steps)) {
    assert.ok(circleArguments(step.data, [step.abi]).signature);
    const estimate = await hosted.estimate({ account: L.CIRCLE, to: step.to, data: step.data, value: '0', abi: step.abi, chainId: 5042, operationId: '12345678-1234-4234-9234-123456789abc' });
    assert.notEqual(estimate.code, 'CIRCLE_UNSUPPORTED_ABI', step.label);
    const bare = await hosted.estimate({ account: L.CIRCLE, to: step.to, data: step.data, value: '0', abi: [], chainId: 5042, operationId: '12345678-1234-4234-9234-123456789abc' });
    assert.equal(bare.code, 'CIRCLE_UNSUPPORTED_ABI');
  }
});

function payoutLog(abi, eventName, args, address = L.SPLITTER) {
  const event = abi.find(item => item.type === 'event' && item.name === eventName);
  const fields = event.inputs.filter(item => !item.indexed);
  return { address, topics: encodeEventTopics({ abi: [event], eventName, args }), data: encodeAbiParameters(fields, fields.map(item => args[item.name])) };
}
const transfer = (emitter, from, to, value) => payoutLog(parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']), 'Transfer', { from, to, value }, emitter);
const expected = (extra = {}) => ({ line: 'hooked', generation: 6, payer: L.SPLITTER, flow: 'distribute-and-claim', controllerBefore: L.CREATOR, ...extra });

test('a claim receipt is the payer\'s own event to the creator, matched against one USDC emitter only', () => {
  const claimed = payoutLog(splitterAbis[6], 'Claimed', { to: L.CREATOR, currency: L.USDC, amount: 2_224_593n });
  // An ERC-20 USDC payout logs on both emitters; only the 18dp superset is read.
  const logs = [claimed, transfer(NATIVE_USDC_EMITTER, L.SPLITTER, L.CREATOR, 2_224_593n * SCALE), transfer(L.USDC, L.SPLITTER, L.CREATOR, 2_224_593n)];
  const evidence = verifyLineClaim({ logs }, expected());
  assert.equal(evidence.actualCreatorFeesUsdcRaw, '2224593');
  assert.equal(evidence.actualCreatorFeesWei, (2_224_593n * SCALE).toString());
  const pushed = payoutLog(splitterAbis[4], 'Paid', { to: L.CREATOR, currency: L.USDC, amount: 7_724n });
  assert.equal(verifyLineClaim({ logs: [pushed, transfer(NATIVE_USDC_EMITTER, L.SPLITTER, L.CREATOR, 7_724n * SCALE)] },
    expected({ generation: 4, flow: 'distribute-push' })).actualCreatorFeesUsdcRaw, '7724');
  const legacy = payoutLog(legacyAbis.processor, 'PayoutSent', { to: L.CREATOR, amountNative18: 10_398_126_726_900_000_000n }, L.PROCESSOR);
  assert.equal(verifyLineClaim({ logs: [legacy, transfer(NATIVE_USDC_EMITTER, L.PROCESSOR, L.CREATOR, 10_398_126_726_900_000_000n)] },
    expected({ line: 'legacy', generation: 1, payer: L.PROCESSOR, flow: 'processor' })).actualCreatorFeesWei, '10398126726900000000');
});

test('a claim receipt with a different amount, another claim recipient or another asset is refused', () => {
  const claimed = payoutLog(splitterAbis[6], 'Claimed', { to: L.CREATOR, currency: L.USDC, amount: 10n });
  assert.throws(() => verifyLineClaim({ logs: [transfer(NATIVE_USDC_EMITTER, L.SPLITTER, L.CREATOR, 10n * SCALE)] }, expected()), /without its payout event/);
  assert.throws(() => verifyLineClaim({ logs: [claimed, transfer(NATIVE_USDC_EMITTER, L.SPLITTER, L.CREATOR, 9n * SCALE)] }, expected()), { code: 'ARGUS_RECEIPT_MISMATCH' });
  assert.throws(() => verifyLineClaim({ logs: [claimed, transfer(L.USDC, L.SPLITTER, L.CREATOR, 10n)] }, expected()), { code: 'ARGUS_RECEIPT_MISMATCH' });
  const elsewhere = payoutLog(splitterAbis[6], 'Claimed', { to: L.OTHER, currency: L.USDC, amount: 10n });
  assert.throws(() => verifyLineClaim({ logs: [elsewhere, transfer(NATIVE_USDC_EMITTER, L.SPLITTER, L.OTHER, 10n * SCALE)] }, expected()), /someone other than the creator/);
  const otherAsset = payoutLog(splitterAbis[6], 'Claimed', { to: L.CREATOR, currency: L.OTHER, amount: 10n });
  assert.throws(() => verifyLineClaim({ logs: [otherAsset, transfer(NATIVE_USDC_EMITTER, L.SPLITTER, L.CREATOR, 10n * SCALE)] }, expected()), /other than USDC/);
});

test('a confirmed split that paid the creator nothing settles at zero instead of leaving the action unresolved', () => {
  // distribute() succeeds on nothing: another caller delivered first. The treasury push alone is not a creator payout.
  const treasury = payoutLog(splitterAbis[4], 'Paid', { to: L.OTHER, currency: L.USDC, amount: 5n });
  for (const logs of [[], [treasury, transfer(NATIVE_USDC_EMITTER, L.SPLITTER, L.OTHER, 5n * SCALE)]]) {
    const evidence = verifyLineClaim({ logs }, expected({ generation: 4, flow: 'distribute-push' }));
    assert.equal(evidence.delivered, false); assert.equal(evidence.actualCreatorFeesWei, '0'); assert.deepEqual(evidence.payouts, []);
    assert.match(evidence.reason, /another caller/i);
  }
  // A payout event from any other contract is not this launch's payout.
  const forged = payoutLog(splitterAbis[6], 'Claimed', { to: L.CREATOR, currency: L.USDC, amount: 10n }, L.OTHER);
  assert.equal(verifyLineClaim({ logs: [forged, transfer(NATIVE_USDC_EMITTER, L.OTHER, L.CREATOR, 10n * SCALE)] }, expected()).delivered, false);
  const legacy = expected({ line: 'legacy', generation: 2, payer: L.PROCESSOR, flow: 'processor' });
  assert.equal(verifyLineClaim({ logs: [] }, legacy).delivered, false);
});
