// Generated from the Argus app source src/lib/contracts/v5-market.ts. Do not edit by hand.
import { getAddress } from "viem";
import { poolIdFor, priceImpactBps, quoteExactInput } from "./pool.mjs";
export const V5_POOL_FEE = 0x800000;
export const V5_TICK_SPACING = 200;
export const V5_BASE_FEE_BPS = 100;
export const V5_SNIPE_WINDOW_SECONDS = 3;
const SNIPE_START_BPS = 9_900;
const SNIPE_SHIFTS = 14;
const MAX_RATE_BPS = 9_900;
const PIPS = 1000000n;
export function v5PoolKey(token, quote, hook) {
    const tokenIsToken0 = BigInt(token) < BigInt(quote);
    return {
        currency0: getAddress(tokenIsToken0 ? token : quote),
        currency1: getAddress(tokenIsToken0 ? quote : token),
        fee: V5_POOL_FEE,
        tickSpacing: V5_TICK_SPACING,
        hooks: getAddress(hook),
    };
}
export function v5PoolId(token, quote, hook) {
    return poolIdFor(v5PoolKey(token, quote, hook));
}
export function isV5PoolKey(key) {
    return key?.fee === V5_POOL_FEE;
}
export function v5SnipeBps(elapsedSeconds) {
    if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0)
        return SNIPE_START_BPS;
    const elapsed = Math.floor(elapsedSeconds);
    if (elapsed >= V5_SNIPE_WINDOW_SECONDS)
        return 0;
    return SNIPE_START_BPS >> Math.floor((elapsed * SNIPE_SHIFTS) / V5_SNIPE_WINDOW_SECONDS);
}
export function v5CappedSnipeBps(snipeBps, legTaxBps) {
    if (snipeBps <= 0)
        return 0;
    const composite = legTaxBps + V5_BASE_FEE_BPS;
    return composite + snipeBps > MAX_RATE_BPS ? Math.max(0, MAX_RATE_BPS - composite) : snipeBps;
}
export function v5CompositePips(legTaxBps) {
    return BigInt((legTaxBps + V5_BASE_FEE_BPS) * 100);
}
export function v5FeeOnGross(gross, pips) {
    if (gross <= 0n)
        return 0n;
    const product = gross * pips;
    return product / PIPS + (product % PIPS === 0n ? 0n : 1n);
}
export function quoteV5ExactIn(input) {
    const legTax = input.isBuy ? input.buyTaxBps : input.sellTaxBps;
    const pips = v5CompositePips(legTax);
    const snipe = v5CappedSnipeBps(input.snipeBps, legTax);
    const zeroForOne = input.isBuy ? !input.tokenIsToken0 : input.tokenIsToken0;
    const empty = { amountOut: 0n, fee: 0n, surcharge: 0n, coreQuote: 0n, impactBps: 0, taxBps: legTax + snipe };
    if (input.amountIn <= 0n)
        return empty;
    if (input.isBuy) {
        const fee = v5FeeOnGross(input.amountIn, pips);
        const surcharge = (input.amountIn * BigInt(snipe)) / 10000n;
        const core = input.amountIn - fee - surcharge;
        if (core <= 0n)
            return empty;
        const { amountOut } = quoteExactInput(core, zeroForOne, input.sqrtPriceX96, input.liquidity, 0);
        return {
            amountOut,
            fee,
            surcharge,
            coreQuote: core,
            impactBps: priceImpactBps(core, amountOut, input.sqrtPriceX96, zeroForOne, 0),
            taxBps: legTax + snipe,
        };
    }
    const { amountOut: gross } = quoteExactInput(input.amountIn, zeroForOne, input.sqrtPriceX96, input.liquidity, 0);
    const fee = v5FeeOnGross(gross, pips);
    const surcharge = (gross * BigInt(snipe)) / 10000n;
    const net = gross - fee - surcharge;
    if (gross <= 0n || net <= 0n)
        return { ...empty, coreQuote: gross };
    return {
        amountOut: net,
        fee,
        surcharge,
        coreQuote: gross,
        impactBps: priceImpactBps(input.amountIn, gross, input.sqrtPriceX96, zeroForOne, 0),
        taxBps: legTax + snipe,
    };
}
export function v5BondProgress(tick, tickStart, tickBond) {
    const span = tickBond - tickStart;
    if (span === 0)
        return 0;
    const progress = (tick - tickStart) / span;
    return Math.min(1, Math.max(0, progress));
}
