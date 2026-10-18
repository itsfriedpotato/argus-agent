import { encodeFunctionData, getAddress, parseAbi, zeroAddress } from "viem";
import { ARC_ADDRESSES, ARGUS_CONSTANTS, PORTALS } from "./generated/addresses.mjs";
import { erc20Abi, launchesAbi, legacyLaunchesAbi, legacyTokenAbi, permit2Abi, portalCommonAbi, stateViewAbi, swapRouter02Abi, taxHookAbi, universalRouterAbi, v3PoolAbi } from "./generated/abis.mjs";
import { poolIdFor, poolKeyFor, priceImpactBps, sqrtRatioAtTick, v3PoolAddress } from "./generated/pool.mjs";
import { encodeV4ExactInSwap } from "./generated/swap-encoding.mjs";

// These are deployed, immutable historical launch registries, never launch targets.
export const LEGACY_PORTALS = PORTALS;
export const legacySplitterAbi = parseAbi([
  ...["creator", "token", "quoteAsset", "defaultQuoteAsset"].map((name) => `function ${name}() view returns (address)`),
  "function converts() view returns (bool)",
  "function claimableUsdc6(address account) view returns (uint256)",
  "function claimableQuote6(address account) view returns (uint256)",
  "function claimableToken18(address account) view returns (uint256)",
  "function claim(address account)",
  "event Claimed(address indexed to, address indexed currency, uint256 amount)",
]);
export const legacySelfClaimAbi = parseAbi(["function claim()", "event Claimed(address indexed to, address indexed currency, uint256 amount)"]);
const hookedIdentityAbi = parseAbi([
  "function buyTaxBps() view returns (uint16)", "function sellTaxBps() view returns (uint16)",
  "function poolId() view returns (bytes32)", "function currentSnipeTaxBps() view returns (uint256)",
]);
// Legacy ABI subset from the Argus app public/argus-abi.json. claim(account)
// withdraws only that immutable recipient's parked native balance.
export const legacyProcessorAbi = parseAbi([
  "function creatorWallet() view returns (address)", "function token() view returns (address)",
  "function claimable(address account) view returns (uint256)", "function claim(address account) returns (uint256 amountNative18)",
  "event ParkedClaimed(address indexed to, uint256 amountNative18)",
]);
// config() retains launch settings after taxes expire or are reduced.
const activeTaxesAbi = parseAbi(["function currentTaxes() view returns (uint16 buyTaxBps, uint16 sellTaxBps)", "function taxProcessor() view returns (address)"]);
const deadlineRouterAbi = parseAbi(["function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)"]);
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const fail = (message, code = "CONTRACT_MISMATCH") => { throw Object.assign(new Error(message), { code, safe: true }); };
function checkedAddress(value, label, allowZero = false) {
  let result;
  try { result = getAddress(value); } catch { fail(`The ${label} is not a valid address.`); }
  if (!allowZero && same(result, zeroAddress)) fail(`The ${label} is missing.`);
  return result;
}
function tax(value) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 0 || result > 9900) fail("The token tax is outside the supported range.");
  return result;
}
function decimals(value) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 0 || result > 36) fail("The asset decimals are outside the supported range.");
  return result;
}
export function legacyPortalAbi(portal) {
  return portal.line === "legacy" ? legacyLaunchesAbi : [...launchesAbi[portal.words], ...portalCommonAbi];
}

/** A bounded lookup of seven known registries. RPC failures are never treated as absence. */
export async function readLegacyState(tokenInput, read, { portal } = {}) {
  const token = checkedAddress(tokenInput, "token");
  const candidates = portal ? LEGACY_PORTALS.filter((item) => same(item.address, typeof portal === "string" ? portal : portal.address)) : LEGACY_PORTALS;
  if (!candidates.length) fail("The historical Portal is not supported.", "UNSUPPORTED");
  for (const candidate of candidates) {
    const raw = await read(candidate.address, legacyPortalAbi(candidate), "launches", [token]);
    if (same(raw[0], zeroAddress)) continue;
    if (!Array.isArray(raw) || raw.length !== candidate.words) fail("The historical launch record has an unexpected shape.");
    const creator = checkedAddress(raw[0], "recorded creator");
    const quoteAsset = candidate.line === "legacy" || candidate.words < 11 ? getAddress(ARC_ADDRESSES.usdc) : checkedAddress(raw[10], "recorded quote", true);
    const tokenIsToken0 = candidate.line === "legacy" ? raw[3] : raw[2];
    if (typeof tokenIsToken0 !== "boolean" || tokenIsToken0 !== (BigInt(token) < BigInt(quoteAsset))) fail("The launch record disagrees with the currency order.");
    const state = { version: "v1", portalGeneration: candidate.generation, line: candidate.line, portal: getAddress(candidate.address), token,
      creator, historicalCreator: creator, controller: creator, payout: creator, proposed: null, split: [], escrow: null, quoteAsset, tokenIsToken0,
      tickStart: Number(raw[1]), tickBond: candidate.line === "legacy" ? Number(raw[2]) : candidate.words >= 10 ? Number(raw[9]) : null,
      locker: checkedAddress(candidate.line === "legacy" ? raw[8] : raw[3], "locker"), positionId: candidate.line === "legacy" ? raw[9] : raw[8],
      capabilities: { management: same(quoteAsset, zeroAddress) ? [] : ["claim_fees"], trading: same(quoteAsset, ARC_ADDRESSES.usdc), ownership: "immutable_creator" } };
    if (candidate.line === "legacy") {
      const pool = checkedAddress(raw[5], "v3 pool");
      if (!same(pool, v3PoolAddress(token, quoteAsset, ARGUS_CONSTANTS.poolFee))) fail("The historical launch does not point at the canonical v3 pool.");
      const processor = checkedAddress(raw[6], "tax processor");
      const [config, activeTaxes, tokenProcessor, feeCreator, feeToken] = await Promise.all([
        read(token, legacyTokenAbi, "config"), read(token, activeTaxesAbi, "currentTaxes"), read(token, activeTaxesAbi, "taxProcessor"),
        read(processor, legacyProcessorAbi, "creatorWallet"), read(processor, legacyProcessorAbi, "token"),
      ]);
      const payout = checkedAddress(feeCreator, "processor creator wallet");
      if (!same(config[5], payout) || !same(tokenProcessor, processor) || !same(feeToken, token)) fail("The legacy token or processor disagrees with the recorded launch.");
      return { ...state, creator: payout, controller: payout, payout, pool, poolId: null, poolKey: null, hook: null, splitter: null, feeModel: "legacy_processor",
        processor, tracker: checkedAddress(raw[7], "reward tracker", true), buyTaxBps: tax(activeTaxes[0]), sellTaxBps: tax(activeTaxes[1]) };
    }
    const hook = checkedAddress(raw[4], "tax hook");
    const splitter = checkedAddress(raw[5], "fee splitter");
    const poolKey = poolKeyFor(token, quoteAsset, hook);
    const poolId = poolIdFor(poolKey);
    const [recordedPool, feeCreator, feeToken, feeQuote] = await Promise.all([
      read(hook, taxHookAbi, "poolId"), read(splitter, legacySplitterAbi, "creator"),
      read(splitter, legacySplitterAbi, "token"), read(splitter, legacySplitterAbi, "quoteAsset"),
    ]);
    if (!same(recordedPool, poolId) || !same(feeCreator, creator) || !same(feeToken, token) || !same(feeQuote, quoteAsset)) fail("The historical hook or splitter disagrees with the launch record.");
    return { ...state, hook, splitter, pool: null, poolKey, poolId, feeModel: "v4_splitter", buyTaxBps: tax(raw[6]), sellTaxBps: tax(raw[7]) };
  }
  return null;
}

export async function readLegacyFees(state, read) {
  if (state.line === "legacy") {
    const amount = await read(state.processor, legacyProcessorAbi, "claimable", [state.payout]);
    if (amount < 0n) fail("The processor claim ledger returned a negative balance.");
    return { owedCreatorRaw: amount, feeAssets: amount > 0n ? [{ asset: zeroAddress, decimals: 18, amountRaw: amount, delivery: "native" }] : [],
      fees: { model: "legacy_processor", recipient: state.payout, quoteAsset: state.quoteAsset, payoutAsset: zeroAddress,
        quoteDecimals: 6, payoutDecimals: 18, tokenDecimals: 18, claimableQuoteRaw: null, claimableTokenRaw: null, claimableUsdcRaw: null,
        claimableNativeRaw: amount, claimPermission: "permissionless", requiredSigner: null, executionSupported: true, note: "Only parked native USDC is claimable; undispatched processor buckets are not included." } };
  }
  if (same(state.quoteAsset, zeroAddress)) return { owedCreatorRaw: null, feeAssets: [], fees: {
    model: "v4_splitter", recipient: state.creator, quoteAsset: zeroAddress, payoutAsset: null,
    quoteDecimals: 18, payoutDecimals: null, tokenDecimals: null,
    claimableQuoteRaw: null, claimableTokenRaw: null, claimableUsdcRaw: null, claimPermission: null, requiredSigner: null, executionSupported: false,
    reason: "unsupported_native_quote", note: "This recognized token uses a native quote. Its fee units and delivery path are not supported; claimable amounts are unknown, not zero.",
  } };
  const [quoteAmount, tokenAmount, quoteDecimals, tokenDecimals, convertedAmount, converts, defaultQuote] = await Promise.all([
    read(state.splitter, legacySplitterAbi, "claimableQuote6", [state.creator]),
    read(state.splitter, legacySplitterAbi, "claimableToken18", [state.creator]),
    read(state.quoteAsset, erc20Abi, "decimals"),
    read(state.token, erc20Abi, "decimals"),
    state.portalGeneration === 7 ? read(state.splitter, legacySplitterAbi, "claimableUsdc6", [state.creator]) : 0n,
    state.portalGeneration === 7 ? read(state.splitter, legacySplitterAbi, "converts") : false,
    state.portalGeneration === 7 ? read(state.splitter, legacySplitterAbi, "defaultQuoteAsset") : ARC_ADDRESSES.usdc,
  ]);
  const qd = decimals(quoteDecimals), td = decimals(tokenDecimals);
  if (state.portalGeneration === 7 && !same(defaultQuote, ARC_ADDRESSES.usdc)) fail("The converter's default payout asset is not the expected USDC.");
  const native = state.portalGeneration <= 5;
  if (native && (!same(state.quoteAsset, ARC_ADDRESSES.usdc) || qd !== 6)) fail("The historical native payout denomination is not supported.", "UNSUPPORTED");
  const assets = [];
  const add = (asset, raw, assetDecimals, delivery = "erc20", extra = {}) => {
    if (raw < 0n) fail("A claim ledger returned a negative balance.");
    if (raw > 0n) {
      const existing = assets.find((entry) => same(entry.asset, asset) && entry.delivery === delivery);
      if (existing) existing.amountRaw += raw;
      else assets.push({ asset: getAddress(asset), amountRaw: raw, decimals: assetDecimals, delivery, ...extra });
    }
  };
  add(native ? zeroAddress : state.quoteAsset, native ? quoteAmount * 10n ** 12n : quoteAmount, native ? 18 : qd, native ? "native" : "erc20",
    native ? { eventAsset: state.quoteAsset, eventDecimals: 6, ledgerAmountRaw: quoteAmount } : {});
  add(state.token, tokenAmount, td);
  add(ARC_ADDRESSES.usdc, convertedAmount, 6);
  return { owedCreatorRaw: quoteAmount, feeAssets: assets, fees: { model: "v4_splitter", recipient: state.creator,
    quoteAsset: state.quoteAsset, payoutAsset: native ? zeroAddress : converts ? getAddress(ARC_ADDRESSES.usdc) : state.quoteAsset,
    quoteDecimals: qd, payoutDecimals: native ? 18 : converts ? 6 : qd, tokenDecimals: td,
    claimableQuoteRaw: quoteAmount, claimableTokenRaw: tokenAmount, claimableUsdcRaw: convertedAmount,
    claimPermission: state.portalGeneration <= 4 ? "recipient_only" : "permissionless",
    requiredSigner: state.portalGeneration <= 4 ? state.creator : null, executionSupported: true } };
}

export function prepareLegacyClaim(state, fees, actor, block) {
  if (!fees.fees.executionSupported || !state.capabilities.management.includes("claim_fees")) fail("This token does not expose a supported manual creator-fee claim.", "UNSUPPORTED");
  if (fees.fees.claimPermission === "recipient_only" && !same(actor, fees.fees.requiredSigner)) {
    fail("This historical splitter only lets the original creator claim with its own signer; an unrelated agent wallet cannot claim these fees.", "UNAUTHORIZED");
  }
  if (!fees.feeAssets.length) fail("No creator fees are currently claimable.", "NOTHING_TO_CLAIM");
  const feeContract = state.line === "legacy" ? state.processor : state.splitter;
  const recipientOnly = fees.fees.claimPermission === "recipient_only";
  const feeAbi = state.line === "legacy" ? legacyProcessorAbi : recipientOnly ? legacySelfClaimAbi : legacySplitterAbi;
  const expected = { version: "v1", portal: state.portal, portalGeneration: state.portalGeneration, feeModel: state.feeModel,
    token: state.token, actor, operation: "claim_fees", controllerBefore: state.payout, feeContract, splitter: state.splitter,
    claimPermission: fees.fees.claimPermission, requiredSigner: fees.fees.requiredSigner,
    recipients: [{ recipient: state.payout, bps: 10000 }], claimAssets: fees.feeAssets,
    quoteAsset: state.quoteAsset, payoutAsset: fees.fees.payoutAsset, owedCreatorRaw: fees.owedCreatorRaw,
    owedCreatorTokenRaw: fees.fees.claimableTokenRaw, owedCreatorUsdcRaw: fees.fees.claimableUsdcRaw };
  return { steps: [{ to: feeContract, data: encodeFunctionData({ abi: feeAbi, functionName: "claim", args: recipientOnly ? [] : [state.payout] }), value: "0", abi: feeAbi, label: state.portalGeneration <= 4 ? "Claim parked fees to the immutable creator" : "Claim credited fees to the immutable creator" }],
    expected, summary: { kind: "management", ...expected, spendUsdcRaw: "0", observedBlockNumber: block.number,
      ownershipNote: recipientOnly ? "The original V1 creator is immutable. This splitter requires that creator to call claim() with its own signer." : "The original V1 creator is immutable. This permissionless claim cannot redirect fees." } };
}

/** Exact-input quote inside one tick interval; crossing unknown liquidity is refused. */
export function quoteLegacyWithinTick({ amountIn, zeroForOne, sqrtPriceX96, tick, liquidity, taxBps, slippageBps, legacy }) {
  if (liquidity <= 0n || sqrtPriceX96 <= 0n || amountIn <= 0n || !Number.isInteger(tick) || tick < -887272 || tick > 887272) fail("The pool quote state is invalid.", "NO_LIQUIDITY");
  if (sqrtPriceX96 < sqrtRatioAtTick(tick) || (tick < 887272 && sqrtPriceX96 > sqrtRatioAtTick(tick + 1))) fail("The pool price and tick disagree.");
  const q96 = 1n << 96n;
  const netIn = amountIn * BigInt(1_000_000 - ARGUS_CONSTANTS.poolFee) / 1_000_000n;
  const numerator = liquidity * sqrtPriceX96 * q96;
  const denominator = liquidity * q96 + netIn * sqrtPriceX96;
  // Match pool rounding: token0-in rounds the next sqrt price up, never output up.
  const next = zeroForOne ? (numerator + denominator - 1n) / denominator : sqrtPriceX96 + netIn * q96 / liquidity;
  const raw = { sqrtPriceAfterX96: next, amountOut: zeroForOne ? liquidity * (sqrtPriceX96 - next) / q96 : liquidity * q96 * (next - sqrtPriceX96) / (next * sqrtPriceX96) };
  const spacing = ARGUS_CONSTANTS.tickSpacing;
  let boundary = zeroForOne ? Math.floor(tick / spacing) * spacing : (Math.floor(tick / spacing) + 1) * spacing;
  if (zeroForOne && sqrtPriceX96 === sqrtRatioAtTick(boundary)) boundary -= spacing;
  const limit = sqrtRatioAtTick(boundary);
  if ((zeroForOne && raw.sqrtPriceAfterX96 <= limit) || (!zeroForOne && raw.sqrtPriceAfterX96 >= limit)) {
    fail("This amount crosses a liquidity boundary that cannot be quoted safely. Reduce the trade amount.", "QUOTE_RANGE_EXCEEDED");
  }
  const afterTax = (value) => value - value * BigInt(taxBps) / 10000n;
  const amountOut = afterTax(raw.amountOut);
  const routerMinOut = (legacy ? raw.amountOut : amountOut) * BigInt(10000 - slippageBps) / 10000n;
  const minimum = legacy ? afterTax(routerMinOut) : routerMinOut;
  if (minimum <= 0n) fail("The quote has no supported positive minimum output.", "INVALID_INPUT");
  return { amountOut, routerMinOut, minimum, impactBps: priceImpactBps(amountIn, raw.amountOut, sqrtPriceX96, zeroForOne) };
}

export async function prepareLegacyTrade(state, { actor, side, amountIn, slippageBps }, block, read) {
  if (!same(state.quoteAsset, ARC_ADDRESSES.usdc)) fail("V1 trading currently supports direct ERC-20 USDC pairs only; native and other quote routes are unsupported.", "UNSUPPORTED");
  if (Number(await read(state.token, erc20Abi, "decimals")) !== 18) fail("V1 trading requires the verified 18-decimal launch token.", "UNSUPPORTED");
  const isBuy = side === "buy";
  const legacy = state.line === "legacy";
  const router = getAddress(legacy ? ARC_ADDRESSES.swapRouter02 : ARC_ADDRESSES.universalRouter);
  const currencyIn = isBuy ? state.quoteAsset : state.token;
  const currencyOut = isBuy ? state.token : state.quoteAsset;
  const spender = legacy ? router : ARC_ADDRESSES.permit2;
  const [slot, inRange, balance, allowance, permit, liveBuyTax, liveSellTax, snipe] = await Promise.all([
    legacy ? read(state.pool, v3PoolAbi, "slot0") : read(ARC_ADDRESSES.stateView, stateViewAbi, "getSlot0", [state.poolId]),
    legacy ? read(state.pool, v3PoolAbi, "liquidity") : read(ARC_ADDRESSES.stateView, stateViewAbi, "getLiquidity", [state.poolId]),
    read(currencyIn, erc20Abi, "balanceOf", [actor]), read(currencyIn, erc20Abi, "allowance", [actor, spender]),
    legacy ? null : read(ARC_ADDRESSES.permit2, permit2Abi, "allowance", [actor, currencyIn, router]),
    legacy ? state.buyTaxBps : read(state.hook, hookedIdentityAbi, "buyTaxBps"),
    legacy ? state.sellTaxBps : read(state.hook, hookedIdentityAbi, "sellTaxBps"),
    legacy ? 0n : read(state.hook, hookedIdentityAbi, "currentSnipeTaxBps"),
  ]);
  if (balance < amountIn) fail("The trading wallet does not hold the full input amount.", "INSUFFICIENT_BALANCE");
  if (!legacy && (tax(liveBuyTax) !== state.buyTaxBps || tax(liveSellTax) !== state.sellTaxBps)) fail("The hook taxes disagree with the launch record.");
  if (!legacy && Number(slot[3]) !== ARGUS_CONSTANTS.poolFee) fail("The live pool fee differs from its verified route.");
  if (!legacy && Number(slot[2]) !== 0) fail("The pool protocol fee is not supported by this quote.", "UNSUPPORTED");
  if (legacy && slot[6] !== true) fail("The v3 pool is locked.", "NO_LIQUIDITY");
  let liquidity = inRange;
  const zeroForOne = isBuy ? !state.tokenIsToken0 : state.tokenIsToken0;
  const tick = Number(slot[1]);
  if (!legacy && liquidity === 0n && tick % ARGUS_CONSTANTS.tickSpacing === 0 && slot[0] === sqrtRatioAtTick(tick)) {
    const [gross, net] = await read(ARC_ADDRESSES.stateView, stateViewAbi, "getTickLiquidity", [state.poolId, tick]);
    // Only enter the adjacent range when the boundary's signed liquidity proves it exists.
    const entering = zeroForOne ? -net : net;
    if (entering > 0n && entering <= gross) liquidity = entering;
  }
  if (slot[0] <= 0n || liquidity <= 0n) fail("The pool has no usable liquidity in this trade direction.", "NO_LIQUIDITY");
  const taxBps = legacy ? (isBuy ? state.buyTaxBps : 0) : Math.min(9900, (isBuy ? state.buyTaxBps : state.sellTaxBps) + tax(snipe));
  const quote = quoteLegacyWithinTick({ amountIn, zeroForOne, sqrtPriceX96: slot[0], tick, liquidity, taxBps, slippageBps, legacy });
  if (!legacy && quote.routerMinOut > (1n << 128n) - 1n) fail("The output minimum exceeds the supported router amount range.", "INVALID_INPUT");
  const deadline = block.timestamp + 600n;
  const steps = [];
  const add = (to, abi, functionName, args, label) => steps.push({ to, abi, data: encodeFunctionData({ abi, functionName, args }), value: "0", label });
  if (allowance < amountIn) {
    if (allowance > 0n) add(currencyIn, erc20Abi, "approve", [spender, 0n], "Reset the input approval");
    add(currencyIn, erc20Abi, "approve", [spender, amountIn], "Approve the exact trade input");
  }
  if (legacy) {
    const swap = encodeFunctionData({ abi: swapRouter02Abi, functionName: "exactInputSingle", args: [{ tokenIn: currencyIn, tokenOut: currencyOut,
      fee: ARGUS_CONSTANTS.poolFee, recipient: actor, amountIn, amountOutMinimum: quote.routerMinOut, sqrtPriceLimitX96: 0n }] });
    add(router, deadlineRouterAbi, "multicall", [deadline, [swap]], `${isBuy ? "Buy" : "Sell"} the V1 token before the deadline`);
  } else {
    if (permit[0] < amountIn || BigInt(permit[1]) < deadline) add(ARC_ADDRESSES.permit2, permit2Abi, "approve", [currencyIn, router, amountIn, Number(deadline)], "Approve the exact router amount for ten minutes");
    steps.push({ to: router, abi: universalRouterAbi, data: encodeV4ExactInSwap({ key: state.poolKey, zeroForOne, amountIn,
      amountOutMinimum: quote.routerMinOut, currencyIn, currencyOut, deadline }), value: "0", label: `${isBuy ? "Buy" : "Sell"} the V1 token` });
  }
  const expected = { version: "v1", portal: state.portal, portalGeneration: state.portalGeneration, token: state.token, actor, side,
    currencyIn, currencyOut, amountInRaw: amountIn, minimumAmountOutRaw: quote.minimum, routerMinimumAmountOutRaw: quote.routerMinOut, deadline };
  return { steps, expected, summary: { kind: "trade", ...expected, quotedAmountOutRaw: quote.amountOut, taxBps, slippageBps,
    spendUsdcRaw: isBuy ? amountIn : 0n, observedBlockNumber: block.number, impactBps: quote.impactBps,
    note: "The output minimum is after token tax. The quote refuses unknown liquidity crossings; simulate the exact transaction before signing." } };
}
