import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, getAddress, parseAbi, zeroAddress } from 'viem';
import { ARC_ADDRESSES, ARGUS_CONSTANTS } from '../scripts/argus-agent/generated/addresses.mjs';
import { poolIdFor, poolKeyFor, v3PoolAddress } from '../scripts/argus-agent/generated/pool.mjs';
import { LEGACY_PORTALS } from '../scripts/argus-agent/legacy-contracts.mjs';
import { verifyLegacyClaimReceipt } from '../scripts/argus-agent/legacy-receipts.mjs';

const token = getAddress('0x1111111111111111111111111111111111111111');
const creator = getAddress('0x2222222222222222222222222222222222222222');
const feeContract = getAddress('0x3333333333333333333333333333333333333333');
const hook = getAddress('0x4444444444444444444444444444444444444444');
const locker = getAddress('0x5555555555555555555555555555555555555555');
const other = getAddress('0x6666666666666666666666666666666666666666');
const usdc = getAddress(ARC_ADDRESSES.usdc);
const nativeEmitter = '0xfffffffffffffffffffffffffffffffffffffffe';
const abi = parseAbi([
  'event Transfer(address indexed from,address indexed to,uint256 value)',
  'event Claimed(address indexed to,address indexed currency,uint256 amount)',
  'event ParkedClaimed(address indexed to,uint256 amountNative18)',
]);
const claimAbi = parseAbi(['function claim(address account)', 'function claim()']);
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

function log(address, name, args, raw) {
  return { address, topics: encodeEventTopics({ abi, eventName: name, args }),
    data: encodeAbiParameters([{ type: 'uint256' }], [raw]), removed: false };
}
const claim = (currency, amount, to = creator) => log(feeContract, 'Claimed', { to, currency }, amount);
const transfer = (currency, amount, to = creator, from = feeContract) => log(currency, 'Transfer', { from, to }, amount);
const parked = (amount, to = creator) => log(feeContract, 'ParkedClaimed', { to }, amount);

function fixture(generation, quoteAsset = usdc) {
  const portal = LEGACY_PORTALS.find(item => item.generation === generation);
  assert.ok(portal);
  const legacy = generation <= 2;
  const tokenIsToken0 = BigInt(token) < BigInt(quoteAsset);
  const record = legacy
    ? [creator, 0, 200, tokenIsToken0, true, v3PoolAddress(token, quoteAsset, ARGUS_CONSTANTS.poolFee), feeContract, zeroAddress, locker, 1n]
    : [creator, 0, tokenIsToken0, locker, hook, feeContract, 300, 300, 1n,
      ...(generation >= 4 ? [200] : []), ...(generation >= 6 ? [quoteAsset] : [])];
  const expected = { version: 'v1', operation: 'claim_fees', actor: creator, token, portal: portal.address, portalGeneration: generation,
    feeContract, feeModel: legacy ? 'legacy_processor' : 'v4_splitter', controllerBefore: creator,
    quoteAsset, recipients: [{ recipient: creator, bps: 10000 }] };
  const receipt = { logs: [] };
  const step = { to: feeContract, from: creator,
    data: encodeFunctionData({ abi: claimAbi, functionName: 'claim', args: generation === 3 || generation === 4 ? [] : [creator] }) };
  const assetDecimals = new Map([[token.toLowerCase(), 18], [usdc.toLowerCase(), 6], [quoteAsset.toLowerCase(), same(quoteAsset, usdc) ? 6 : 18]]);
  const read = async (address, _abi, name) => {
    if (name === 'launches') return record;
    if (name === 'config') return [300n, 300n, 10000n, 0n, 0n, creator, 0n, 0n];
    if (name === 'currentTaxes') return [300, 300];
    if (name === 'taxProcessor') return feeContract;
    if (name === 'creatorWallet' || name === 'creator') return creator;
    if (name === 'token') return token;
    if (name === 'quoteAsset') return quoteAsset;
    if (name === 'poolId') return poolIdFor(poolKeyFor(token, quoteAsset, hook));
    if (name === 'decimals') return assetDecimals.get(address.toLowerCase());
    throw new Error(`Unexpected read ${name}`);
  };
  return { expected, receipt, step, read, record, assetDecimals,
    run: () => verifyLegacyClaimReceipt({ receipt, expected, step, read }) };
}

for (const generation of [1, 2]) {
  test(`Portal ${generation} parked creator fees retain native precision`, async () => {
    const f = fixture(generation);
    const amount = 1234567890123456789n;
    f.receipt.logs = [transfer(nativeEmitter, amount), parked(amount)];
    const result = await f.run();
    assert.equal(result.actualCreatorFeesUsdcWei, amount.toString());
    assert.equal(result.actualCreatorFeesUsdcRaw, undefined);
    assert.deepEqual(result.payouts, [{ recipient: creator, asset: zeroAddress, delivery: 'native', amountRaw: amount.toString(), decimals: 18 }]);
  });
}

for (const generation of [3, 4, 5]) {
  test(`Portal ${generation} six-decimal claim events reconcile native delivery without counting an ERC20 mirror`, async () => {
    const f = fixture(generation);
    const amount = 1912709n;
    f.receipt.logs = [transfer(nativeEmitter, amount * 10n ** 12n), transfer(usdc, amount), claim(usdc, amount)];
    const result = await f.run();
    assert.equal(result.actualCreatorFeesUsdcRaw, amount.toString());
    assert.equal(result.actualCreatorFeesUsdcWei, (amount * 10n ** 12n).toString());
    assert.equal(result.payouts.length, 1);
    assert.equal(result.payouts[0].delivery, 'native');
    assert.equal(result.payouts[0].asset, zeroAddress);
  });
}

test('Portal 6 verifies quote and token amounts separately, with no invented USD value for another quote', async () => {
  const f = fixture(6, other);
  f.receipt.logs = [transfer(other, 123n), claim(other, 123n), transfer(token, 456n), claim(token, 456n)];
  const result = await f.run();
  assert.equal(result.actualCreatorFeesUsdcWei, '0');
  assert.equal(result.actualCreatorFeesUsdcRaw, '0');
  assert.deepEqual(result.payouts.map(row => [row.asset, row.amountRaw, row.decimals]), [[other, '123', 18], [token, '456', 18]]);
});

test('Portal 3 and 4 caller-only claims require the immutable recipient as the saved actor and signer', async () => {
  for (const generation of [3, 4]) {
    for (const change of [f => { f.expected.actor = other; }, f => { f.step.from = other; }]) {
      const f = fixture(generation);
      f.receipt.logs = [claim(usdc, 1n), transfer(nativeEmitter, 10n ** 12n)];
      change(f);
      await assert.rejects(f.run, { code: 'ARGUS_RECEIPT_MISMATCH' });
    }
  }
});

test('V1 receipt evidence cannot validate the wrong claim selector or a redirected claim argument', async () => {
  for (const generation of [1, 2, 3, 4, 5, 6, 7]) {
    const f = fixture(generation);
    f.receipt.logs = generation <= 2 ? [parked(1n), transfer(nativeEmitter, 1n)]
      : [claim(usdc, 1n), transfer(generation <= 5 ? nativeEmitter : usdc, generation <= 5 ? 10n ** 12n : 1n)];
    f.step.data = encodeFunctionData({ abi: claimAbi, functionName: 'claim', args: generation === 3 || generation === 4 ? [creator] : [] });
    await assert.rejects(f.run, { code: 'ARGUS_RECEIPT_MISMATCH' });
    f.step.data = encodeFunctionData({ abi: claimAbi, functionName: 'claim', args: [other] });
    await assert.rejects(f.run, { code: 'ARGUS_RECEIPT_MISMATCH' });
  }
});

test('Portal 6 USDC payout uses the ERC20 transfer even if its native mirror is present', async () => {
  const f = fixture(6);
  f.receipt.logs = [transfer(usdc, 1n), transfer(nativeEmitter, 10n ** 12n), claim(usdc, 1n)];
  const result = await f.run();
  assert.equal(result.actualCreatorFeesUsdcRaw, '1');
  assert.equal(result.payouts.length, 1);
  assert.equal(result.payouts[0].delivery, 'erc20');
});

test('Portal 7 verifies all three distinct quote, token and converted USDC legs', async () => {
  const f = fixture(7, other);
  f.receipt.logs = [transfer(other, 11n), claim(other, 11n), transfer(token, 22n), claim(token, 22n), transfer(usdc, 33n), claim(usdc, 33n)];
  const result = await f.run();
  assert.equal(result.actualCreatorFeesUsdcRaw, '33');
  assert.equal(result.payouts.length, 3);
  assert.deepEqual(result.payouts.map(row => row.amountRaw), ['11', '22', '33']);
});

test('Portal 7 aggregates duplicate quote and converted USDC asset legs before reconciling transfers', async () => {
  const f = fixture(7);
  f.receipt.logs = [transfer(usdc, 11n), claim(usdc, 11n), transfer(token, 22n), claim(token, 22n), transfer(usdc, 33n), claim(usdc, 33n)];
  const result = await f.run();
  assert.equal(result.actualCreatorFeesUsdcRaw, '44');
  assert.equal(result.payouts.length, 2);
  assert.deepEqual(result.payouts.map(row => [row.asset, row.amountRaw]), [[usdc, '44'], [token, '22']]);
});

test('claim events alone, mirrors alone, wrong emitters, wrong recipients and wrong native scaling cannot settle a claim', async () => {
  const invalid = [
    [claim(usdc, 1n)],
    [claim(usdc, 1n), transfer(usdc, 1n)],
    [claim(usdc, 1n), transfer(nativeEmitter, 1n)],
    [claim(usdc, 1n), transfer(nativeEmitter, 10n ** 12n, other)],
    [claim(usdc, 1n), transfer(nativeEmitter, 10n ** 12n, creator, other)],
    [claim(usdc, 1n, other), transfer(nativeEmitter, 10n ** 12n)],
    [{ ...claim(usdc, 1n), address: other }, transfer(nativeEmitter, 10n ** 12n)],
    [claim(usdc, 0n), transfer(nativeEmitter, 0n)],
    [claim(other, 1n), transfer(other, 1n)],
  ];
  for (const logs of invalid) {
    const f = fixture(5); f.receipt.logs = logs;
    await assert.rejects(f.run, { code: 'ARGUS_RECEIPT_MISMATCH' });
  }
});

test('a transfer to an additional recipient, even with a matching creator amount, rejects the claim', async () => {
  const f = fixture(6);
  f.receipt.logs = [claim(usdc, 1n), transfer(usdc, 1n), transfer(usdc, 1n, other)];
  await assert.rejects(f.run, { code: 'ARGUS_RECEIPT_MISMATCH' });
});

test('saved version, generation, target, recipient and quote identity must match the verified V1 claim', async () => {
  for (const change of [
    f => { f.expected.version = 'v2'; },
    f => { f.expected.operation = 'set_split'; },
    f => { f.expected.portalGeneration = 7; },
    f => { f.step.to = other; },
    f => { f.expected.feeContract = other; },
    f => { f.expected.controllerBefore = other; },
    f => { f.expected.feeModel = 'legacy_processor'; },
    f => { f.expected.recipients[0].recipient = other; },
    f => { f.expected.recipients[0].bps = 5000; },
    f => { f.expected.quoteAsset = other; },
  ]) {
    const f = fixture(6); f.receipt.logs = [claim(usdc, 1n), transfer(usdc, 1n)]; change(f);
    await assert.rejects(f.run, { code: 'ARGUS_RECEIPT_MISMATCH' });
  }
});

test('removed claim and transfer logs cannot settle creator fees', async () => {
  for (const index of [0, 1]) {
    const f = fixture(6); f.receipt.logs = [claim(usdc, 1n), transfer(usdc, 1n)];
    f.receipt.logs[index].removed = true;
    await assert.rejects(f.run, { code: 'ARGUS_RECEIPT_MISMATCH' });
  }
});

test('claim amounts must agree with actual delivery for processors and ERC20 splitters', async () => {
  for (const generation of [1, 2, 6, 7]) {
    const f = fixture(generation);
    f.receipt.logs = generation <= 2 ? [parked(123n), transfer(nativeEmitter, 124n)] : [claim(usdc, 123n), transfer(usdc, 124n)];
    await assert.rejects(f.run, { code: 'ARGUS_RECEIPT_MISMATCH' });
  }
});

test('invalid decimals and an inconsistent USDC denomination cannot produce verified fee accounting', async () => {
  for (const value of [undefined, -1, 256, 1.5, 18]) {
    const f = fixture(6); f.receipt.logs = [claim(usdc, 1n), transfer(usdc, 1n)];
    f.assetDecimals.set(usdc.toLowerCase(), value);
    await assert.rejects(f.run, { code: 'ARGUS_RECEIPT_MISMATCH' });
  }
});
