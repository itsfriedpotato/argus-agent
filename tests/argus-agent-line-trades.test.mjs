import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeAbiParameters, decodeFunctionData, getAddress } from 'viem';
import { createContractAdapter } from '../scripts/argus-agent/contracts.mjs';
import { circleArguments } from '../scripts/argus-agent/circle-executor.mjs';
import { ARC_ADDRESSES } from '../scripts/argus-agent/generated/addresses.mjs';
import { afterTaxBps, quoteExactInput, v3PoolAddress } from '../scripts/argus-agent/generated/pool.mjs';
import { BUY_GAS_HEADROOM_USDC_RAW } from '../scripts/argus-agent/lines.mjs';
import { L, lineChain } from './fixtures/argus-lines-chain.mjs';

const Q96 = 1n << 96n;
const LIQUIDITY = 10n ** 24n;
const CANONICAL = v3PoolAddress(L.TOKEN, L.USDC, 10_000);
const STATE_VIEW = getAddress(ARC_ADDRESSES.stateView);
const PERMIT2 = getAddress(ARC_ADDRESSES.permit2);
const ROUTER = getAddress(ARC_ADDRESSES.universalRouter);
const SWAP_ROUTER02 = getAddress(ARC_ADDRESSES.swapRouter02);

function tradeChain({ generation = 7, values = {}, quote, pool = CANONICAL, liquidity = LIQUIDITY, boundary = 0n } = {}) {
  return lineChain({ generation, quote, pool, values: {
    [STATE_VIEW]: { getSlot0: [Q96, 0, 0, 0], getLiquidity: liquidity, getTickLiquidity: [boundary, -boundary] },
    [pool]: { slot0: [Q96, 0, 0, 0, 0, 0, true], liquidity },
    [PERMIT2]: { allowance: [0n, 0, 0] },
    ...values,
  } });
}
const trade = (chain, side = 'buy', amountIn = side === 'buy' ? '1' : '1000', extra = {}) =>
  createContractAdapter(chain.client).prepareTrade({ token: L.TOKEN, actor: L.CIRCLE, side, amountIn, slippageBps: 100, ...extra });
const names = plan => plan.steps.map(step => decodeFunctionData({ abi: step.abi, data: step.data }).functionName);
/** The pool's own exact-in arithmetic, taxed and floored the way the minimum must be. */
function expectedHooked(amountIn, isBuy, taxBps, liquidity = LIQUIDITY) {
  const zeroForOne = isBuy ? !(BigInt(L.TOKEN) < BigInt(L.USDC)) : BigInt(L.TOKEN) < BigInt(L.USDC);
  const net = afterTaxBps(quoteExactInput(amountIn, zeroForOne, Q96, liquidity, 10_000).amountOut, taxBps);
  return net * 9_900n / 10_000n;
}

test('hooked Portals 3-7 buy through the Universal Router in their own v4 pool with the hook tax in the minimum', async () => {
  for (const generation of [3, 4, 5, 6, 7]) {
    const plan = await trade(tradeChain({ generation, values: { [L.HOOK]: { currentSnipeTaxBps: 50n } } }));
    assert.deepEqual(names(plan), ['approve', 'approve', 'execute']);
    assert.equal(plan.steps[0].to, L.USDC); assert.equal(plan.steps[1].to, PERMIT2); assert.equal(plan.steps[2].to, ROUTER);
    assert.deepEqual(decodeFunctionData({ abi: plan.steps[0].abi, data: plan.steps[0].data }).args, [PERMIT2, 1_000_000n], 'exact approval, never unlimited');
    assert.equal(plan.expected.route, 'v4-universal-router'); assert.equal(plan.expected.generation, generation);
    assert.equal(plan.summary.taxBps, 150, 'buy tax plus the live snipe tax');
    assert.equal(plan.expected.minimumAmountOutRaw, expectedHooked(1_000_000n, true, 150).toString());
    assert.equal(plan.expected.routerMinimumAmountOutRaw, plan.expected.minimumAmountOutRaw, 'the hook taxes inside the swap, so the router sees the net output');
    assert.equal(plan.summary.spendUsdcRaw, '1000000');
    // The swap's own encoded minimum is the planned one.
    const [, inputs] = decodeFunctionData({ abi: plan.steps[2].abi, data: plan.steps[2].data }).args;
    const [, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], inputs[0]);
    const swap = decodeAbiParameters([{ type: 'tuple', components: [{ type: 'tuple', components: [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }] },
      { type: 'bool' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'uint160' }, { type: 'bytes' }] }], params[0])[0];
    assert.equal(swap[0][4], L.HOOK, 'the pool key names the launch hook'); assert.equal(swap[0][2], 10_000); assert.equal(swap[0][3], 200);
    assert.equal(swap[3].toString(), plan.expected.minimumAmountOutRaw);
  }
});

test('hooked sells take the sell tax, and an untraded launch on its range boundary still quotes', async () => {
  const sell = await trade(tradeChain({ generation: 4 }), 'sell', '1000');
  assert.equal(sell.expected.currencyIn, L.TOKEN); assert.equal(sell.expected.currencyOut, L.USDC);
  assert.equal(sell.summary.taxBps, 300); assert.equal(sell.summary.spendUsdcRaw, '0');
  assert.equal(sell.expected.inventoryDebitRaw, undefined, 'a hooked sell debits exactly what it sells');
  assert.equal(sell.expected.minimumAmountOutRaw, expectedHooked(10n ** 21n, false, 300).toString());
  const boundary = await trade(tradeChain({ generation: 6, liquidity: 0n, boundary: LIQUIDITY }));
  assert.equal(boundary.expected.minimumAmountOutRaw, expectedHooked(1_000_000n, true, 100).toString());
  await assert.rejects(trade(tradeChain({ generation: 6, liquidity: 0n, boundary: 0n })), { code: 'NO_LIQUIDITY' });
});

test('legacy Portals 1-2 swap through SwapRouter02 in their own v3 pool; buys guard the gross and the receipt the net', async () => {
  for (const generation of [1, 2]) {
    const buy = await trade(tradeChain({ generation, values: { [L.TOKEN]: { currentTaxes: [300, 300], config: [100n, 100n, 10_000n, 0n, 0n, L.CREATOR, 0n, 0n] } } }));
    assert.deepEqual(names(buy), ['approve', 'exactInputSingle']);
    assert.deepEqual(decodeFunctionData({ abi: buy.steps[0].abi, data: buy.steps[0].data }).args, [SWAP_ROUTER02, 1_000_000n]);
    const [params] = decodeFunctionData({ abi: buy.steps[1].abi, data: buy.steps[1].data }).args;
    assert.equal(params.tokenIn, L.USDC); assert.equal(params.tokenOut, L.TOKEN); assert.equal(params.fee, 10_000); assert.equal(params.recipient, L.CIRCLE);
    const gross = quoteExactInput(1_000_000n, !(BigInt(L.TOKEN) < BigInt(L.USDC)), Q96, LIQUIDITY, 10_000).amountOut;
    assert.equal(params.amountOutMinimum, gross * 9_900n / 10_000n, 'the router checks the pool output before the token tax');
    assert.equal(buy.summary.taxBps, 300, 'the larger tax reading bounds the received minimum');
    assert.equal(buy.expected.minimumAmountOutRaw, afterTaxBps(params.amountOutMinimum, 300).toString());
    assert.ok(BigInt(buy.expected.minimumAmountOutRaw) < params.amountOutMinimum);
    assert.equal(buy.expected.route, 'v3-swaprouter02'); assert.equal(buy.expected.deadline, null);
    const sell = await trade(tradeChain({ generation, values: { [L.TOKEN]: { currentTaxes: [100, 300] } } }), 'sell', '1000');
    assert.equal(sell.summary.taxBps, 0, 'router sells reach the pool untaxed');
    assert.equal(sell.expected.minimumAmountOutRaw, sell.expected.routerMinimumAmountOutRaw);
    // Measured on ARGUS: selling 100 debits 101. The token takes its sell tax from what the seller has left.
    assert.equal(sell.expected.inventoryDebitRaw, (10n ** 21n + 3n * 10n ** 19n).toString());
    assert.equal(sell.summary.sellSurchargeBps, 300);
  }
});

test('legacy trades refuse an ungraduated token and a pool that is not its canonical 1% USDC pool', async () => {
  await assert.rejects(trade(tradeChain({ generation: 1, values: { [L.TOKEN]: { graduated: false } } })), { code: 'UNSUPPORTED' });
  await assert.rejects(trade(tradeChain({ generation: 2, pool: L.POOL })), { code: 'CONTRACT_MISMATCH' });
});

test('only USDC pairs trade, and a buy keeps the site gas headroom in the same USDC balance', async () => {
  const alt = lineChain({ generation: 6, quote: L.OTHER, values: { [L.OTHER]: { decimals: 18 } } });
  await assert.rejects(createContractAdapter(alt.client).prepareTrade({ token: L.TOKEN, actor: L.CIRCLE, side: 'buy', amountIn: '1' }), { code: 'UNSUPPORTED' });
  const exact = 1_000_000n;
  await assert.rejects(trade(tradeChain({ values: { [L.USDC]: { balanceOf: exact + BUY_GAS_HEADROOM_USDC_RAW - 1n } } })), { code: 'INSUFFICIENT_BALANCE' });
  assert.equal((await trade(tradeChain({ values: { [L.USDC]: { balanceOf: exact + BUY_GAS_HEADROOM_USDC_RAW } } }))).steps.length, 3);
  await assert.rejects(trade(tradeChain({ values: { [L.TOKEN]: { balanceOf: 10n ** 21n - 1n } } }), 'sell', '1000'), { code: 'INSUFFICIENT_BALANCE' });
  await assert.rejects(trade(tradeChain({ values: { [L.TOKEN]: { decimals: 9 } } })), { code: 'UNSUPPORTED' });
});

test('existing allowances are reset to exact amounts or reused, never raised to unlimited', async () => {
  const partial = await trade(tradeChain({ generation: 1, values: { [L.USDC]: { allowance: 7n } } }));
  assert.deepEqual(partial.steps.slice(0, 2).map(step => decodeFunctionData({ abi: step.abi, data: step.data }).args[1]), [0n, 1_000_000n]);
  const covered = await trade(tradeChain({ generation: 7, values: { [L.USDC]: { allowance: 1_000_000n }, [PERMIT2]: { allowance: [1_000_000n, 10 ** 9, 0] } } }));
  assert.deepEqual(names(covered), ['execute']);
});

test('both Circle executors reproduce every older-line trade call from the ABI the step carries', async () => {
  const plans = [await trade(tradeChain({ generation: 7 })), await trade(tradeChain({ generation: 3 }), 'sell', '1000'),
    await trade(tradeChain({ generation: 1 })), await trade(tradeChain({ generation: 2, values: { [L.TOKEN]: { allowance: 1n } } }), 'sell', '1000')];
  for (const step of plans.flatMap(plan => plan.steps)) assert.ok(circleArguments(step.data, [step.abi]).signature, step.label);
});
