// Generated from the Argus app source src/lib/contracts/v5-lock.ts. Do not edit by hand.
import { formatUnits, parseAbi, parseUnits } from "viem";
const Q96 = 1n << 96n;
export const lockVaultAbi = parseAbi([
    "function lock(address token, uint256 amount) returns (uint256 totalLocked)",
    "function locked(address token) view returns (uint256)",
    "function sweepable(address token) view returns (uint256)",
    "event Locked(address indexed token, address indexed from, uint256 delta, uint256 totalLocked)",
    "error NothingToLock()",
    "error ZeroAddress()",
    "error ReentrancyGuardReentrantCall()",
    "error SafeERC20FailedOperation(address token)",
]);
export function parseLockAmount(input, decimals) {
    const value = input.trim().replace(/,/g, "");
    if (!value)
        return { raw: null, error: "Enter an amount" };
    if (!/^\d*\.?\d*$/.test(value) || value === ".")
        return { raw: null, error: "Enter a number" };
    const fraction = value.split(".")[1] ?? "";
    if (fraction.length > decimals)
        return { raw: null, error: `At most ${decimals} decimals` };
    const raw = parseUnits(value, decimals);
    if (raw <= 0n)
        return { raw: null, error: "Enter more than 0" };
    return { raw, error: null };
}
export function formatLockAmount(raw, decimals) {
    const [whole, fraction] = formatUnits(raw, decimals).split(".");
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return fraction ? `${grouped}.${fraction}` : grouped;
}
export function approvalFor(allowance, amount) {
    return allowance === amount ? null : amount;
}
export function isV5LaunchRecord(record) {
    return Boolean(record && /^0x[0-9a-fA-F]{40}$/.test(record.hook) && !/^0x0{40}$/i.test(record.hook));
}
export const V5_SEED_MIN_TICK = -887_200;
export const V5_SEED_MAX_TICK = 887_200;
const MAX_TICK = 887_272;
const MAX_UINT256 = (1n << 256n) - 1n;
const RATIO_STEPS = [
    [0x2, 0xfff97272373d413259a46990580e213an],
    [0x4, 0xfff2e50f5f656932ef12357cf3c7fdccn],
    [0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
    [0x10, 0xffcb9843d60f6159c9db58835c926644n],
    [0x20, 0xff973b41fa98c081472e6896dfb254c0n],
    [0x40, 0xff2ea16466c96a3843ec78b326b52861n],
    [0x80, 0xfe5dee046a99a2a811c461f1969c3053n],
    [0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
    [0x200, 0xf987a7253ac413176f2b074cf7815e54n],
    [0x400, 0xf3392b0822b70005940c7a398e4b70f3n],
    [0x800, 0xe7159475a2c29b7443b29c7fa6e889d9n],
    [0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825n],
    [0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5n],
    [0x4000, 0x70d869a156d2a1b890bb3df62baf32f7n],
    [0x8000, 0x31be135f97d08fd981231505542fcfa6n],
    [0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
    [0x20000, 0x5d6af8dedb81196699c329225ee604n],
    [0x40000, 0x2216e584f5fa1ea926041bedfe98n],
    [0x80000, 0x48a170391f7dc42444e8fa2n],
];
export function sqrtRatioAtTick(tick) {
    const abs = Math.abs(tick);
    if (!Number.isInteger(tick) || abs > MAX_TICK)
        throw new RangeError(`tick ${tick} out of range`);
    let ratio = abs & 0x1 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
    for (const [bit, factor] of RATIO_STEPS)
        if (abs & bit)
            ratio = (ratio * factor) >> 128n;
    if (tick > 0)
        ratio = MAX_UINT256 / ratio;
    return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}
export function v5SeedRange(tokenIsToken0, tickStart) {
    return tokenIsToken0 ? { lower: tickStart, upper: V5_SEED_MAX_TICK } : { lower: V5_SEED_MIN_TICK, upper: tickStart };
}
export function v5SeedLiquidity(tokenIsToken0, tickStart, supply) {
    const { lower, upper } = v5SeedRange(tokenIsToken0, tickStart);
    const sqrtLower = sqrtRatioAtTick(lower);
    const sqrtUpper = sqrtRatioAtTick(upper);
    return tokenIsToken0
        ? (supply * ((sqrtLower * sqrtUpper) / Q96)) / (sqrtUpper - sqrtLower)
        : (supply * Q96) / (sqrtUpper - sqrtLower);
}
export function v5LockFloor(input) {
    const { tokenIsToken0, tickStart, supply, locked, tokenDecimals, quoteDecimals } = input;
    if (supply <= 0n || locked < 0n || locked >= supply || tokenDecimals < quoteDecimals)
        return null;
    const liquidity = input.liquidity ?? v5SeedLiquidity(tokenIsToken0, tickStart, supply);
    if (liquidity <= 0n)
        return null;
    const { lower, upper } = v5SeedRange(tokenIsToken0, tickStart);
    const free = supply - locked;
    let sqrtFloor;
    if (tokenIsToken0) {
        const sqrtUpper = sqrtRatioAtTick(upper);
        sqrtFloor = (liquidity * Q96 * sqrtUpper) / (free * sqrtUpper + liquidity * Q96);
    }
    else {
        const scaled = free * Q96;
        sqrtFloor = sqrtRatioAtTick(lower) + scaled / liquidity + (scaled % liquidity === 0n ? 0n : 1n);
    }
    const sqrtStart = sqrtRatioAtTick(tickStart);
    const scale = 10 ** (tokenDecimals - quoteDecimals);
    const at = (sqrtPriceX96) => {
        const root = Number(sqrtPriceX96) / 2 ** 96;
        return (tokenIsToken0 ? root * root : 1 / (root * root)) * scale;
    };
    const RATIO = 10n ** 18n;
    const ratio = Number(tokenIsToken0 ? (sqrtFloor * RATIO) / sqrtStart : (sqrtStart * RATIO) / sqrtFloor) / 1e18;
    const multiple = ratio * ratio;
    const startPrice = at(sqrtStart);
    const floorPrice = startPrice * multiple;
    const wholeSupply = Number(formatUnits(supply, tokenDecimals));
    return {
        startPrice,
        floorPrice,
        startFdv: startPrice * wholeSupply,
        floorFdv: floorPrice * wholeSupply,
        multiple,
        lockedShare: Number((locked * 1000000000n) / supply) / 1e9,
    };
}
