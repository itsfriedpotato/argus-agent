import { readFileSync } from 'node:fs';
import { decodeAbiParameters, decodeEventLog, decodeFunctionResult, encodeFunctionData, getAddress, parseAbi, zeroAddress } from 'viem';
import { ARC_ADDRESSES, ARGUS_CONSTANTS, PORTALS } from './generated/addresses.mjs';
import { erc20Abi, legacyLaunchesAbi, legacyTokenAbi, permit2Abi, portalCommonAbi, stateViewAbi, swapRouter02Abi, universalRouterAbi, v3PoolAbi } from './generated/abis.mjs';
import { decodeLaunchRecord, launchesAbiFor } from './generated/launch-record.mjs';
import { legacyTaxFromConfig } from './generated/legacy-token.mjs';
import { afterTaxBps, priceImpactBps, quoteExactInput, v3PoolAddress } from './generated/pool.mjs';
import { encodeV4ExactInSwap } from './generated/swap-encoding.mjs';

const bundle = JSON.parse(readFileSync(new URL('./vendor/argus-v4.json', import.meta.url), 'utf8'));
// The compiled legacy v3 artifacts, published beside the bundle for reading and trading Portals 1-2.
const artifacts = JSON.parse(readFileSync(new URL('./vendor/argus-abi.json', import.meta.url), 'utf8')).abis;

/** The only Portal this package launches on. Older Portals are looked up, never launched on. */
export const PORTAL8 = getAddress(bundle.launchPortal);
const portal8Abi = bundle.portal8.contracts.ArgusV5Portal.abi;
export const USDC = getAddress(ARC_ADDRESSES.usdc);

export const hookAbi = bundle.contracts.ArgusV4TaxHook.abi;
// Portals 3 and 4 predate the bundle. Their distribute(), claimableQuote6, creator and Paid
// share the Portal 5 selectors and topics; claim(address) does not exist on them.
export const splitterAbis = Object.freeze({ 3: bundle.contracts.ArgusV4HookedSplitter.abi, 4: bundle.contracts.ArgusV4HookedSplitter.abi,
  5: bundle.contracts.ArgusV4HookedSplitter.abi, 6: bundle.contracts.ArgusV4HookedSplitter6.abi, 7: bundle.portal7.contracts.ArgusV4HookedSplitter7.abi });
/** Each splitter is an EIP-1167 clone; these are the implementations the bundle's ABIs describe. */
export const splitterImplementations = Object.freeze({ 5: getAddress(bundle.contracts.ArgusV4HookedSplitter.address),
  6: getAddress(bundle.contracts.ArgusV4HookedSplitter6.address), 7: getAddress(bundle.portal7.contracts.ArgusV4HookedSplitter7.address) });
export const legacyAbis = Object.freeze({ token: artifacts.ArgusTaxToken, processor: artifacts.ArgusTaxProcessor, locker: artifacts.ArgusFeeLocker });

function fail(message, code = 'INVALID_INPUT') {
  throw Object.assign(new Error(message), { code, safe: true });
}
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/** An EIP-1167 clone's target, or null for any other runtime. */
export function cloneTarget(code) {
  const match = typeof code === 'string' && code.match(/^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i);
  return match ? getAddress(`0x${match[1]}`) : null;
}

/**
 * Which Argus Portal launched `token`, from the Portals' own records: Portal 8 when its
 * record names a hook, otherwise the newest earlier Portal whose record names a creator.
 * Null when none did. A Portal that cannot be read throws; it is never read as "not ours".
 * `read(address, abi, functionName, args)` must be pinned to one block.
 */
export async function findLaunch(read, tokenInput) {
  const token = getAddress(tokenInput);
  const v5 = await read(PORTAL8, portal8Abi, 'launches', [token]);
  if (!same(v5[0], zeroAddress)) return { line: 'v5', generation: 8, portal: PORTAL8, token, record: v5 };
  for (const portal of PORTALS) {
    const raw = await read(getAddress(portal.address), launchesAbiFor(portal), 'launches', [token]);
    const record = decodeLaunchRecord(portal, token, raw);
    if (record) return { line: record.line, generation: portal.generation, portal: getAddress(portal.address), token, record };
  }
  return null;
}

/** The TokenCreated event an older Portal emitted for its launches. */
export const tokenCreatedEvent = line => (line === 'legacy' ? legacyLaunchesAbi : portalCommonAbi).find(item => item.type === 'event' && item.name === 'TokenCreated');

/**
 * Current state of a Portals 1-7 launch, read from that launch's own contracts.
 * The payee is the contract's own creator (splitter `creator()`, processor `creatorWallet()`),
 * immutable on these lines: there is no registry, split or controller rotation.
 */
export async function lineState(read, launch) {
  const { record } = launch;
  if (launch.line === 'hooked') {
    const abi = splitterAbis[launch.generation];
    const [quoteAsset, hookToken, hookSplitter, buyTaxBps, sellTaxBps, snipeTaxBps, payee, creatorBps, rangeBound] = await Promise.all([
      read(record.hook, hookAbi, 'quoteAsset'), read(record.hook, hookAbi, 'token'), read(record.hook, hookAbi, 'splitter'),
      read(record.hook, hookAbi, 'buyTaxBps'), read(record.hook, hookAbi, 'sellTaxBps'), read(record.hook, hookAbi, 'currentSnipeTaxBps'),
      read(record.splitter, abi, 'creator'), read(record.splitter, abi, 'creatorBps'), read(record.splitter, abi, 'rangeBound'),
    ]);
    if (!same(quoteAsset, record.quoteAsset) || !same(hookToken, launch.token) || !same(hookSplitter, record.splitter))
      fail('The launch hook disagrees with its Portal record.', 'CONTRACT_MISMATCH');
    const p7 = launch.generation === 7;
    const [creditedQuoteRaw, creditedUsdcRaw, converts] = await Promise.all([
      read(record.splitter, abi, 'claimableQuote6', [payee]),
      p7 ? read(record.splitter, abi, 'claimableUsdc6', [payee]) : 0n,
      p7 ? read(record.splitter, abi, 'converts') : false,
    ]);
    return { line: 'hooked', generation: launch.generation, portal: launch.portal, token: launch.token, historicalCreator: getAddress(record.creator),
      payee: getAddress(payee), hook: getAddress(record.hook), splitter: getAddress(record.splitter), locker: getAddress(record.locker),
      pool: null, processor: null, tracker: null, poolId: record.poolId, poolKey: record.poolKey, quoteAsset: getAddress(quoteAsset),
      tokenIsToken0: record.tokenIsToken0, buyTaxBps: Number(buyTaxBps), sellTaxBps: Number(sellTaxBps), snipeTaxBps: Number(snipeTaxBps),
      creatorBps: Number(creatorBps), rangeBound, converts, creditedQuoteRaw, creditedUsdcRaw, owedCreatorRaw: creditedQuoteRaw + creditedUsdcRaw,
      owedCreatorUnit: 'quote-asset-base-units', creatorPayout: launch.generation >= 5 ? 'credited-then-claimed' : 'pushed-by-distribute' };
  }
  const token = launch.token;
  const [config, taxes, graduated, mainPool, processor, payee] = await Promise.all([
    read(token, legacyTokenAbi, 'config'), read(token, legacyAbis.token, 'currentTaxes'), read(token, legacyAbis.token, 'graduated'),
    read(token, legacyAbis.token, 'mainPool'), read(token, legacyAbis.token, 'taxProcessor'), read(record.processor, legacyAbis.processor, 'creatorWallet'),
  ]);
  if (!same(processor, record.processor) || !same(mainPool, record.pool)) fail('The legacy token disagrees with its Portal record.', 'CONTRACT_MISMATCH');
  const [parkedRaw, bucketRaw, lockerParkedRaw] = await Promise.all([
    read(record.processor, legacyAbis.processor, 'claimable', [payee]), read(record.processor, legacyAbis.processor, 'creatorBucket'),
    read(record.locker, legacyAbis.locker, 'claimableNative18', [payee]),
  ]);
  const configured = legacyTaxFromConfig(config);
  // Taxes only ever go down on this token. The larger reading is the conservative one for a minimum output.
  const buyTaxBps = Math.max(configured.buyTaxBps, Number(taxes[0]));
  return { line: 'legacy', generation: launch.generation, portal: launch.portal, token, historicalCreator: getAddress(record.creator),
    payee: getAddress(payee), hook: null, splitter: null, locker: getAddress(record.locker), pool: getAddress(record.pool),
    processor: getAddress(record.processor), tracker: same(record.tracker, zeroAddress) ? null : getAddress(record.tracker),
    quoteAsset: USDC, tokenIsToken0: record.tokenIsToken0, graduated, buyTaxBps, sellTaxBps: Math.max(configured.sellTaxBps, Number(taxes[1])),
    // Sells through SwapRouter02 reach the pool untaxed (the site's measured rule); buys are taxed as tokens leave the pool.
    // The seller still pays the sell tax from the remaining balance: see planLineTrade.
    routerSellTaxBps: 0, creatorBps: Number(config[2]), parkedRaw, bucketRaw, lockerParkedRaw, owedCreatorRaw: parkedRaw + bucketRaw,
    owedCreatorUnit: 'native-usdc-18dp', creatorPayout: 'pushed-by-dispatch' };
}

const multicallAbi = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
  'function getEthBalance(address addr) view returns (uint256 balance)',
]);
const MULTICALL3 = getAddress(ARC_ADDRESSES.multicall3);
/** Arc logs every native USDC movement from this pseudo-address at 18dp; 0x3600 mirrors only the ERC-20 subset. Read this one alone. */
export const NATIVE_USDC_EMITTER = '0xfffffffffffffffffffffffffffffffffffffffe';
const transferEvent = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);
const USDC_SCALE = 10n ** 12n;

/**
 * One eth_call through Multicall3, so each call sees the state the previous one left. Every
 * call may fail and reports its own success; only an RPC failure throws. The calls are
 * permissionless, so Multicall3 as their sender answers what any sender would get.
 */
async function simulate(call, calls) {
  const data = encodeFunctionData({ abi: multicallAbi, functionName: 'aggregate3',
    args: [calls.map(item => ({ target: item.to, allowFailure: true, callData: item.data }))] });
  const { data: raw } = await call({ to: MULTICALL3, data });
  if (!raw) fail('The claim simulation returned no data. Nothing was prepared.', 'CLAIM_SIMULATION_FAILED');
  return decodeFunctionResult({ abi: multicallAbi, functionName: 'aggregate3', data: raw });
}
const uintOf = result => result.success ? decodeAbiParameters([{ type: 'uint256' }], result.returnData)[0] : null;
const step = (to, abi, functionName, args, label) => ({ to, data: encodeFunctionData({ abi, functionName, args }), value: '0', label, abi });
const balanceOf = account => ({ to: MULTICALL3, data: encodeFunctionData({ abi: multicallAbi, functionName: 'getEthBalance', args: [account] }) });

/**
 * The creator-fee delivery a Portals 1-7 launch allows, decided by simulating it at the
 * observed block, never by a cached figure. Every call it returns is permissionless and
 * pays only the launch's own creator. Anything only the creator wallet may call is refused.
 *
 * - Portals 5-7: distribute() then claim(creator), or claim alone when nothing new splits,
 *   as the site's creator card does.
 * - Portals 3-4: distribute() pushes the creator share (Paid). A share it could not push is
 *   parked behind claim(), which only the creator can call.
 * - Portals 1-2: the processor's permissionless claim(creator) for a parked payout and
 *   dispatch() for an undispatched creator bucket. The fee locker's claim() is creator-only.
 */
export async function planLineClaim({ call, getCode }, state) {
  const payee = state.payee;
  if (!same(state.quoteAsset, USDC)) {
    if (state.converts) fail('This Portal 7 launch converts the creator share to USDC through a keeper queue. The queued share is not claimable here until the keeper converts it.', 'CONVERSION_QUEUED');
    fail('Creator-fee claims through this agent cover USDC-paired launches only.', 'UNSUPPORTED');
  }
  if (state.creatorBps === 0) fail('This launch gives its creator no share of the fees.', 'NOTHING_TO_CLAIM');
  let candidates;
  let flow;
  if (state.line === 'hooked' && state.generation >= 5) {
    const implementation = cloneTarget(await getCode(state.splitter));
    if (!same(implementation, splitterImplementations[state.generation])) fail('The splitter is not the published implementation for its Portal.', 'CONTRACT_MISMATCH');
    const abi = splitterAbis[state.generation];
    const credit = [step(state.splitter, abi, 'claimableQuote6', [payee]), ...(state.generation === 7 ? [step(state.splitter, abi, 'claimableUsdc6', [payee])] : [])];
    const distribute = step(state.splitter, abi, 'distribute', [], 'Split the fees waiting on the splitter');
    const results = await simulate(call, [...credit, distribute, ...credit]);
    const total = items => items.reduce((sum, item) => { const value = uintOf(item); if (value === null) fail('The splitter credit could not be read.', 'CONTRACT_MISMATCH'); return sum + value; }, 0n);
    const now = total(results.slice(0, credit.length));
    const after = total(results.slice(credit.length + 1));
    const claim = step(state.splitter, abi, 'claim', [payee], 'Claim the creator share to the launch creator');
    if (results[credit.length].success && after > now) { candidates = [distribute, claim]; flow = 'distribute-and-claim'; }
    else if (now > 0n) { candidates = [claim]; flow = 'claim'; }
    else if (state.converts) fail('This Portal 7 splitter queues the creator share for a keeper conversion. Nothing is credited to claim yet.', 'CONVERSION_QUEUED');
    else fail('Nothing can be credited to the creator right now. The splitter sells a limited amount per window; try again later.', 'NOTHING_TO_CLAIM');
  } else if (state.line === 'hooked') {
    candidates = [step(state.splitter, splitterAbis[state.generation], 'distribute', [], 'Split the fees and push the creator share')];
    flow = 'distribute-push';
  } else {
    candidates = [
      ...(state.bucketRaw > 0n ? [step(state.processor, legacyAbis.processor, 'dispatch', [], 'Dispatch the creator bucket to the launch creator')] : []),
      ...(state.parkedRaw > 0n ? [step(state.processor, legacyAbis.processor, 'claim', [payee], 'Deliver the parked creator payout')] : []),
    ];
    flow = 'processor';
  }
  // The exact sequence, bracketed by the creator's USDC balance: every call must succeed and money must reach the creator.
  const proof = candidates.length ? await simulate(call, [balanceOf(payee), ...candidates, balanceOf(payee)]) : null;
  const before = proof && uintOf(proof[0]);
  const after = proof && uintOf(proof.at(-1));
  const delivered = proof && proof.slice(1, -1).every(result => result.success) && before !== null && after !== null && after > before ? after - before : 0n;
  if (delivered === 0n) {
    const parked = state.line === 'legacy' ? state.lockerParkedRaw : state.line === 'hooked' && state.generation < 5 ? state.creditedQuoteRaw : 0n;
    if (parked > 0n) fail(`Only the creator wallet can call claim() on ${state.line === 'legacy' ? 'the fee locker' : 'the splitter'} ${state.line === 'legacy' ? state.locker : state.splitter} to collect its parked share. This agent never signs as the creator.`, 'CREATOR_SIGNATURE_REQUIRED');
    if (candidates.length && proof && !proof.slice(1, -1).every(result => result.success)) fail('The claim would revert on chain. Nothing was prepared.', 'CLAIM_SIMULATION_FAILED');
    fail('Nothing can be delivered to the creator right now.', 'NOTHING_TO_CLAIM');
  }
  return { steps: candidates, flow, payer: state.line === 'legacy' ? state.processor : state.splitter, deliveredWei: delivered };
}

/** Receipt evidence for a Portals 1-7 claim: the payer's own event to the creator, matched to native USDC from the one superset emitter. */
export function verifyLineClaim(receipt, expected) {
  const mismatch = message => fail(message, 'ARGUS_RECEIPT_MISMATCH');
  const legacy = expected.line === 'legacy';
  const abi = legacy ? legacyAbis.processor : splitterAbis[expected.generation];
  const names = legacy ? ['PayoutSent', 'ParkedClaimed'] : expected.flow === 'distribute-push' ? ['Paid'] : ['Claimed'];
  let creditedWei = 0n;
  for (const log of receipt.logs.filter(item => same(item.address, expected.payer) && !item.removed)) {
    let event;
    try { event = decodeEventLog({ abi, data: log.data, topics: log.topics, strict: true }); } catch { continue; }
    if (!names.includes(event.eventName)) continue;
    if (!same(event.args.to, expected.controllerBefore)) {
      // A split pays the treasury and holders too; a claim only ever pays the account it names.
      if (['Claimed', 'ParkedClaimed'].includes(event.eventName)) mismatch('A claim from the launch contract paid someone other than the creator.');
      continue;
    }
    if (!legacy && !same(event.args.currency, USDC)) mismatch('A creator payout was made in an asset other than USDC.');
    creditedWei += legacy ? event.args.amountNative18 : event.args.amount * USDC_SCALE;
  }
  let receivedWei = 0n;
  for (const log of receipt.logs.filter(item => same(item.address, NATIVE_USDC_EMITTER) && !item.removed)) {
    let event;
    try { event = decodeEventLog({ abi: transferEvent, data: log.data, topics: log.topics, strict: true }); } catch { continue; }
    if (same(event.args.from, expected.payer) && same(event.args.to, expected.controllerBefore)) receivedWei += event.args.value;
  }
  const base = { payer: expected.payer, flow: expected.flow };
  // distribute() and dispatch() succeed on nothing. When another caller delivered the share between
  // simulation and inclusion, the exact saved call still confirms and moves nothing: a real outcome.
  if (creditedWei === 0n && receivedWei === 0n) return { ...base, actualCreatorFeesWei: '0', actualCreatorFeesUsdcRaw: '0', payouts: [], delivered: false,
    reason: 'The call confirmed and paid the creator nothing. Another caller most likely delivered this share first.' };
  if (creditedWei <= 0n) mismatch('The creator received USDC from the launch contract without its payout event.');
  if (receivedWei !== creditedWei) mismatch('The USDC the creator received differs from the payout the launch contract recorded.');
  return { ...base, actualCreatorFeesWei: creditedWei.toString(), actualCreatorFeesUsdcRaw: (creditedWei / USDC_SCALE).toString(),
    payouts: [{ recipient: expected.controllerBefore, asset: USDC, amountWei: creditedWei.toString() }], delivered: true };
}

/** USDC a buy keeps back so the wallet can still pay gas: the site's GAS_BUFFER_USDC (trade.ts), in 6dp. */
export const BUY_GAS_HEADROOM_USDC_RAW = 250_000n;

/**
 * Every line, Portal 8 included: the input must be in the wallet, and a USDC buy also keeps the
 * headroom back, because Arc pays gas from the same balance. A near-full-balance buy is refused
 * here rather than saved as an action the execution-time reserve check can never pass.
 */
export function assertTradeBalance(balance, amountIn, isBuy) {
  if (balance < amountIn + (isBuy ? BUY_GAS_HEADROOM_USDC_RAW : 0n))
    fail(isBuy ? 'The trading wallet does not hold the input USDC plus 0.25 USDC of gas headroom.' : 'The trading wallet does not hold the full input amount.', 'INSUFFICIENT_BALANCE');
}
const UNIVERSAL_ROUTER = getAddress(ARC_ADDRESSES.universalRouter);
const SWAP_ROUTER02 = getAddress(ARC_ADDRESSES.swapRouter02);
const PERMIT2 = getAddress(ARC_ADDRESSES.permit2);
const STATE_VIEW = getAddress(ARC_ADDRESSES.stateView);

/**
 * A Portals 1-7 trade, routed as the site routes it. Hooked launches swap through the Universal
 * Router in their own v4 pool; the hook taxes inside the swap, so the router minimum is the net
 * output. Legacy launches swap through SwapRouter02 in their own v3 pool; the token taxes a buy as
 * it leaves the pool, so the router guards the gross and the receipt check the net, and a sell
 * through the router reaches the pool untaxed. USDC pairs only: other pairs route through pools
 * that skip the launch tax.
 */
export async function planLineTrade(read, block, state, { actor, isBuy, amountIn, slippageBps }) {
  if (!same(state.quoteAsset, USDC)) fail('Only USDC-paired Argus tokens can be traded by this agent. Other pairs route through pools that skip the launch tax.', 'UNSUPPORTED');
  const token = state.token;
  if (Number(await read(token, erc20Abi, 'decimals')) !== 18) fail('Only 18-decimal launch tokens are supported.', 'UNSUPPORTED');
  const tokenIsToken0 = BigInt(token) < BigInt(USDC);
  if (state.tokenIsToken0 !== tokenIsToken0) fail('The Portal record orders the pool differently from its addresses.', 'CONTRACT_MISMATCH');
  const zeroForOne = isBuy ? !tokenIsToken0 : tokenIsToken0;
  const currencyIn = isBuy ? USDC : token;
  const currencyOut = isBuy ? token : USDC;
  const legacy = state.line === 'legacy';
  const spender = legacy ? SWAP_ROUTER02 : PERMIT2;
  let sqrtPriceX96;
  let liquidity;
  if (legacy) {
    if (!state.graduated) fail('This legacy token has not graduated to its pool. Trading it is not supported here.', 'UNSUPPORTED');
    if (!same(v3PoolAddress(token, USDC, ARGUS_CONSTANTS.poolFee), state.pool)) fail('The legacy pool is not the canonical 1% USDC pool for this token.', 'CONTRACT_MISMATCH');
    const [slot0, active] = await Promise.all([read(state.pool, v3PoolAbi, 'slot0'), read(state.pool, v3PoolAbi, 'liquidity')]);
    sqrtPriceX96 = slot0[0];
    liquidity = active;
  } else {
    const [slot0, active] = await Promise.all([read(STATE_VIEW, stateViewAbi, 'getSlot0', [state.poolId]), read(STATE_VIEW, stateViewAbi, 'getLiquidity', [state.poolId])]);
    sqrtPriceX96 = slot0[0];
    // A launch resting on its range boundary reads zero in-range liquidity beside an untouched position (the site's rule).
    liquidity = active > 0n || sqrtPriceX96 <= 0n ? active : (await read(STATE_VIEW, stateViewAbi, 'getTickLiquidity', [state.poolId, slot0[1]]))[0];
  }
  if (liquidity <= 0n || sqrtPriceX96 <= 0n) fail('The pool has no usable liquidity.', 'NO_LIQUIDITY');
  const [balance, allowance, permit] = await Promise.all([
    read(currencyIn, erc20Abi, 'balanceOf', [actor]), read(currencyIn, erc20Abi, 'allowance', [actor, spender]),
    legacy ? null : read(PERMIT2, permit2Abi, 'allowance', [actor, currencyIn, UNIVERSAL_ROUTER]),
  ]);
  assertTradeBalance(balance, amountIn, isBuy);
  const { amountOut: gross } = quoteExactInput(amountIn, zeroForOne, sqrtPriceX96, liquidity, ARGUS_CONSTANTS.poolFee);
  const taxBps = Math.min(legacy ? (isBuy ? state.buyTaxBps : state.routerSellTaxBps) : (isBuy ? state.buyTaxBps : state.sellTaxBps) + state.snipeTaxBps, 9_900);
  const received = afterTaxBps(gross, taxBps);
  const routerMinimum = (legacy ? gross : received) * BigInt(10_000 - slippageBps) / 10_000n;
  // The receipt check counts what the wallet actually receives: net of a legacy buy tax.
  const minimum = legacy ? afterTaxBps(routerMinimum, taxBps) : routerMinimum;
  if (minimum <= 0n || routerMinimum <= 0n) fail('The quote has no supported positive minimum output.');
  const steps = [];
  const via = legacy ? 'SwapRouter02' : 'Permit2';
  if (allowance < amountIn) {
    if (allowance > 0n) steps.push(step(currencyIn, erc20Abi, 'approve', [spender, 0n], `Reset the input approval to ${via}`));
    steps.push(step(currencyIn, erc20Abi, 'approve', [spender, amountIn], `Approve exactly the input amount to ${via}`));
  }
  const deadline = block.timestamp + 600n;
  const label = `${isBuy ? 'Buy' : 'Sell'} the token in its own pool`;
  if (legacy) {
    steps.push(step(SWAP_ROUTER02, swapRouter02Abi, 'exactInputSingle', [{ tokenIn: currencyIn, tokenOut: currencyOut, fee: ARGUS_CONSTANTS.poolFee,
      recipient: actor, amountIn, amountOutMinimum: routerMinimum, sqrtPriceLimitX96: 0n }], label));
  } else {
    if (permit[0] < amountIn || BigInt(permit[1]) < deadline) steps.push(step(PERMIT2, permit2Abi, 'approve', [currencyIn, UNIVERSAL_ROUTER, amountIn, Number(deadline)], 'Approve the exact router amount for ten minutes'));
    steps.push({ to: UNIVERSAL_ROUTER, data: encodeV4ExactInSwap({ key: state.poolKey, zeroForOne, amountIn, amountOutMinimum: routerMinimum, currencyIn, currencyOut, deadline }),
      value: '0', label, abi: universalRouterAbi });
  }
  // Measured on ARGUS: a router sell of 100 debits 101. The legacy token charges its sell tax from the
  // seller's remaining balance (capped at what is left), outside the pool leg the minimum guards.
  const surcharge = legacy && !isBuy ? (amountIn * BigInt(state.sellTaxBps) + 9_999n) / 10_000n : 0n;
  return { steps, currencyIn, currencyOut, minimum, routerMinimum, quoted: received, taxBps, walletDebitRaw: amountIn + surcharge,
    sellSurchargeBps: legacy && !isBuy ? state.sellTaxBps : 0, deadline: legacy ? null : deadline,
    route: legacy ? 'v3-swaprouter02' : 'v4-universal-router', pool: legacy ? state.pool : state.poolId,
    impactBps: priceImpactBps(amountIn, gross, sqrtPriceX96, zeroForOne, ARGUS_CONSTANTS.poolFee) };
}
