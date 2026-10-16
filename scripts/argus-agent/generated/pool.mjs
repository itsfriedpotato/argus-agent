// Generated from the Argus app source src/lib/contracts/pool.ts. Do not edit by hand.
import { encodeAbiParameters, getAddress, getContractAddress, keccak256 } from "viem";
import { ARGUS_CONSTANTS } from "./addresses.mjs";
export const Q96 = 1n << 96n;
const Q192 = Q96 * Q96;
const PRICE_SCALE = 10n ** 18n;
export function poolKeyFor(token, quote, hook) {
    const tokenIsToken0 = BigInt(token) < BigInt(quote);
    return {
        currency0: getAddress(tokenIsToken0 ? token : quote),
        currency1: getAddress(tokenIsToken0 ? quote : token),
        fee: ARGUS_CONSTANTS.poolFee,
        tickSpacing: ARGUS_CONSTANTS.tickSpacing,
        hooks: getAddress(hook),
    };
}
export function poolIdFor(key) {
    return keccak256(encodeAbiParameters([
        {
            type: "tuple",
            components: [
                { name: "currency0", type: "address" },
                { name: "currency1", type: "address" },
                { name: "fee", type: "uint24" },
                { name: "tickSpacing", type: "int24" },
                { name: "hooks", type: "address" },
            ],
        },
    ], [key]));
}
const V3_FACTORY = "0xf0db7b58379503491d857db50ac9ece64c653918";
const V3_POOL_INIT_CODE_HASH = "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54";
export function v3PoolAddress(tokenA, tokenB, fee) {
    const [token0, token1] = BigInt(tokenA) < BigInt(tokenB) ? [tokenA, tokenB] : [tokenB, tokenA];
    const salt = keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }], [token0, token1, fee]));
    return getContractAddress({ opcode: "CREATE2", from: V3_FACTORY, salt, bytecodeHash: V3_POOL_INIT_CODE_HASH });
}
const TICK_RATIOS = [
    [0x2n, 0xfff97272373d413259a46990580e213an],
    [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
    [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
    [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
    [0x20n, 0xff973b41fa98c081472e6896dfb254c0n],
    [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
    [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n],
    [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
    [0x200n, 0xf987a7253ac413176f2b074cf7815e54n],
    [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
    [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n],
    [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
    [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n],
    [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
    [0x8000n, 0x31be135f97d08fd981231505542fcfa6n],
    [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
    [0x20000n, 0x5d6af8dedb81196699c329225ee604n],
    [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
    [0x80000n, 0x48a170391f7dc42444e8fa2n],
];
const MAX_UINT256 = 2n ** 256n - 1n;
export function sqrtRatioAtTick(tick) {
    const absTick = BigInt(tick < 0 ? -tick : tick);
    let ratio = (absTick & 0x1n) !== 0n
        ? 0xfffcb933bd6fad37aa2d162d1a594001n
        : 0x100000000000000000000000000000000n;
    for (const [bit, multiplier] of TICK_RATIOS) {
        if ((absTick & bit) !== 0n)
            ratio = (ratio * multiplier) >> 128n;
    }
    if (tick > 0)
        ratio = MAX_UINT256 / ratio;
    return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}
export function priceFromSqrtPriceX96({ sqrtPriceX96, tokenIsToken0, tokenDecimals = ARGUS_CONSTANTS.tokenDecimals, quoteDecimals = ARGUS_CONSTANTS.quoteDecimals, }) {
    if (sqrtPriceX96 === 0n)
        return 0;
    const decimalGap = 10n ** BigInt(tokenDecimals - quoteDecimals);
    const priceE18 = tokenIsToken0
        ? (sqrtPriceX96 * sqrtPriceX96 * decimalGap * PRICE_SCALE) / Q192
        : (Q192 * decimalGap * PRICE_SCALE) / (sqrtPriceX96 * sqrtPriceX96);
    return Number(priceE18) / 1e18;
}
function isqrt(value) {
    if (value < 2n)
        return value;
    let x = value;
    let y = (x + 1n) / 2n;
    while (y < x) {
        x = y;
        y = (x + value / x) / 2n;
    }
    return x;
}
export function sqrtPriceX96AtPrice({ price, tokenIsToken0, tokenDecimals = ARGUS_CONSTANTS.tokenDecimals, quoteDecimals = ARGUS_CONSTANTS.quoteDecimals, }) {
    if (!Number.isFinite(price) || price <= 0)
        return 0n;
    const priceE18 = BigInt(Math.round(price * 1e18));
    if (priceE18 <= 0n)
        return 0n;
    const decimalGap = 10n ** BigInt(tokenDecimals - quoteDecimals);
    const squared = tokenIsToken0
        ? (priceE18 * Q192) / (decimalGap * PRICE_SCALE)
        : (Q192 * decimalGap * PRICE_SCALE) / priceE18;
    return isqrt(squared);
}
export function priceFromTick(tick, tokenIsToken0, quoteDecimals = ARGUS_CONSTANTS.quoteDecimals) {
    const raw = Math.pow(1.0001, tokenIsToken0 ? tick : -tick);
    return raw * Math.pow(10, ARGUS_CONSTANTS.tokenDecimals - quoteDecimals);
}
export function tickAtPrice({ price, tokenIsToken0, quoteDecimals = ARGUS_CONSTANTS.quoteDecimals, rounding = "floor", }) {
    if (!Number.isFinite(price) || price <= 0)
        return null;
    const raw = price / Math.pow(10, ARGUS_CONSTANTS.tokenDecimals - quoteDecimals);
    const exponent = Math.log(raw) / Math.log(1.0001);
    if (!Number.isFinite(exponent))
        return null;
    const tick = tokenIsToken0 ? exponent : -exponent;
    return rounding === "floor" ? Math.floor(tick) : Math.ceil(tick);
}
export function quoteExactInput(amountIn, zeroForOne, sqrtPriceX96, liquidity, feePips = ARGUS_CONSTANTS.poolFee) {
    if (amountIn <= 0n || liquidity <= 0n || sqrtPriceX96 <= 0n) {
        return { amountOut: 0n, sqrtPriceAfterX96: sqrtPriceX96 };
    }
    const netIn = (amountIn * BigInt(1_000_000 - feePips)) / 1000000n;
    if (zeroForOne) {
        const next = (liquidity * sqrtPriceX96 * Q96) / (liquidity * Q96 + netIn * sqrtPriceX96);
        return { amountOut: (liquidity * (sqrtPriceX96 - next)) / Q96, sqrtPriceAfterX96: next };
    }
    const next = sqrtPriceX96 + (netIn * Q96) / liquidity;
    return {
        amountOut: (liquidity * Q96 * (next - sqrtPriceX96)) / (next * sqrtPriceX96),
        sqrtPriceAfterX96: next,
    };
}
export function priceImpactBps(amountIn, amountOut, sqrtPriceX96, zeroForOne, feePips = ARGUS_CONSTANTS.poolFee) {
    if (amountIn <= 0n || amountOut <= 0n)
        return 0;
    const netIn = (amountIn * BigInt(1_000_000 - feePips)) / 1000000n;
    const spotOut = zeroForOne
        ? (netIn * sqrtPriceX96 * sqrtPriceX96) / Q192
        : (netIn * Q192) / (sqrtPriceX96 * sqrtPriceX96);
    if (spotOut <= 0n)
        return 0;
    return Math.max(0, 10_000 - Number((10000n * amountOut) / spotOut));
}
export function afterTaxBps(amount, bps) {
    if (bps <= 0)
        return amount;
    if (bps >= 10_000)
        return 0n;
    return (amount * BigInt(10_000 - bps)) / 10000n;
}
