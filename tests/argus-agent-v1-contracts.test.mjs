import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { decodeFunctionData, getAddress, zeroAddress } from "viem";
import { createContractAdapter } from "../scripts/argus-agent/contracts.mjs";
import { LEGACY_PORTALS, quoteLegacyWithinTick, readLegacyState } from "../scripts/argus-agent/legacy-contracts.mjs";
import { ARC_ADDRESSES } from "../scripts/argus-agent/generated/addresses.mjs";
import { swapRouter02Abi } from "../scripts/argus-agent/generated/abis.mjs";
import { poolIdFor, poolKeyFor, sqrtRatioAtTick, v3PoolAddress } from "../scripts/argus-agent/generated/pool.mjs";

const bundle = JSON.parse(readFileSync(new URL("../scripts/argus-agent/vendor/argus-v4.json", import.meta.url), "utf8"));
const TOKEN = getAddress("0x1111111111111111111111111111111111111111");
const CREATOR = getAddress("0x2222222222222222222222222222222222222222");
const ACTOR = getAddress("0x3333333333333333333333333333333333333333");
const HOOK = getAddress("0x4444444444444444444444444444444444444444");
const SPLITTER = getAddress("0x5555555555555555555555555555555555555555");
const PROCESSOR = getAddress("0x6666666666666666666666666666666666666666");
const LOCKER = getAddress("0x7777777777777777777777777777777777777777");
const OTHER_QUOTE = getAddress("0x8888888888888888888888888888888888888888");
const USDC = getAddress(ARC_ADDRESSES.usdc);
const same = (a,b) => a.toLowerCase() === b.toLowerCase();
function fixture(generation, options = {}) {
  const token = options.token ?? TOKEN;
  const portal = LEGACY_PORTALS.find((p) => p.generation === generation);
  const quote = options.quote ?? USDC;
  const key = poolKeyFor(token, quote, HOOK);
  const poolId = poolIdFor(key);
  const pool = v3PoolAddress(token, USDC, 10000);
  const historicalCreator = options.historicalCreator ?? CREATOR;
  const record = portal.line === "legacy"
    ? [historicalCreator, 0, 200, BigInt(token) < BigInt(USDC), false, pool, PROCESSOR, zeroAddress, LOCKER, 1n]
    : [historicalCreator, 0, BigInt(token) < BigInt(quote), LOCKER, HOOK, SPLITTER, 300, 500, 1n, ...(portal.words >= 10 ? [200] : []), ...(portal.words === 11 ? [quote] : [])];
  const calls = [];
  const read = async (address, abi, functionName, args = []) => {
    const request = { address, abi, functionName, args };
    calls.push(request);
    if (options.overrides?.[functionName] !== undefined) {
      const value = options.overrides[functionName];
      return typeof value === "function" ? value(request) : value;
    }
    switch (functionName) {
      case "creatorRegistry": return bundle.portal8.addresses.creatorRegistry;
      case "launches": return same(address, portal.address) ? record : [zeroAddress];
      case "config": return [900n, 900n, 5000n, 5000n, 0n, CREATOR, 0n, 0n];
      case "currentTaxes": return [300, 500];
      case "taxProcessor": return PROCESSOR;
      case "creatorWallet": return CREATOR;
      case "creator": return historicalCreator;
      case "token": return token;
      case "quoteAsset": return quote;
      case "poolId": return poolId;
      case "name": return "Existing V1 token";
      case "symbol": return "VONE";
      case "logo": return "ipfs://v1-art";
      case "decimals": return same(address, token) ? 18 : same(address, OTHER_QUOTE) ? 8 : 6;
      case "claimable": return options.parked ?? 7001n;
      case "claimableQuote6": return options.quoteFees ?? 17n;
      case "claimableToken18": return options.tokenFees ?? 19n;
      case "claimableUsdc6": return options.convertedFees ?? 23n;
      case "converts": return options.converts ?? false;
      case "defaultQuoteAsset": return USDC;
      case "balanceOf": return 10n ** 30n;
      case "allowance": return args.length === 3 ? [0n, 0, 0] : 7n;
      case "slot0": return [sqrtRatioAtTick(50), 50, 0, 0, 0, 0, true];
      case "getSlot0": return [sqrtRatioAtTick(50), 50, 0, 10000];
      case "liquidity": case "getLiquidity": return 10n ** 24n;
      case "buyTaxBps": return 300;
      case "sellTaxBps": return 500;
      case "currentSnipeTaxBps": return 0n;
      default: throw new Error(`Unexpected ${functionName}`);
    }
  };
  const client = { getChainId: async () => 5042, getBlock: async () => ({ number: 30_000_000n, timestamp: 1_800_000_000n }),
    readContract: ({ address, abi, functionName, args }) => read(address, abi, functionName, args), getLogs: async () => [] };
  return { adapter: createContractAdapter(client), read, calls, portal, record, client };
}
const trade = (extra = {}) => ({ token: TOKEN, actor: ACTOR, side: "buy", amountIn: "0.001", slippageBps: 100, ...extra });
const decode = (step) => decodeFunctionData({ abi: step.abi, data: step.data });

test("V1 resolves every supported portal shape without relying on a token-supplied portal", async () => {
  for (let generation=1; generation<=7; generation++) {
    const { adapter, calls } = fixture(generation);
    const result = await adapter.readProject(TOKEN);
    assert.equal(result.version, "v1");
    assert.equal(result.portalGeneration, generation);
    assert.equal(result.creator, CREATOR);
    assert.equal(result.escrow, null);
    assert.deepEqual(result.capabilities.management, ["claim_fees"]);
    assert.ok(calls.filter((c)=>c.functionName === "launches").length <= 8);
  }
});

test("V1 rejects unknown tokens, forged pool links and conflicting fee authority", async () => {
  const unknown = fixture(7, { overrides: { launches: [zeroAddress] } });
  await assert.rejects(unknown.adapter.readProject(TOKEN), { code: "UNSUPPORTED" });
  const forged = fixture(1);
  forged.record[5] = ACTOR;
  await assert.rejects(forged.adapter.readProject(TOKEN), { code: "CONTRACT_MISMATCH" });
  for (const options of [{ overrides: { creator: ACTOR } }, { overrides: { token: ACTOR } }, { overrides: { poolId: `0x${"ff".repeat(32)}` } }]) {
    await assert.rejects(fixture(7, options).adapter.readProject(TOKEN), { code: "CONTRACT_MISMATCH" });
  }
  await assert.rejects(fixture(1, { overrides: { taxProcessor: ACTOR } }).adapter.readProject(TOKEN), { code: "CONTRACT_MISMATCH" });
  await assert.rejects(readLegacyState(TOKEN, fixture(1).read, { portal: ACTOR }), { code: "UNSUPPORTED" });
});

test("legacy creator payout is distinct from the historical launcher and parked claims always pay that wallet", async () => {
  const { adapter } = fixture(1, { historicalCreator: ACTOR });
  const state = await adapter.readProject(TOKEN);
  assert.equal(state.historicalCreator, ACTOR);
  assert.equal(state.controller, CREATOR);
  assert.equal(state.fees.model, "legacy_processor");
  assert.equal(state.fees.claimableNativeRaw, "7001");
  const plan = await adapter.prepareManagement({ token: TOKEN, actor: ACTOR, operation: "claim_fees" });
  assert.equal(plan.steps[0].to, PROCESSOR);
  assert.deepEqual(decode(plan.steps[0]).args, [CREATOR]);
  assert.deepEqual(plan.expected.claimAssets, [{ asset: zeroAddress, decimals: 18, amountRaw: "7001", delivery: "native" }]);
});

test("V1 claim handles native splitter units and groups all three P7 credited legs without losing dust", async () => {
  const native = await fixture(5).adapter.prepareManagement({ token: TOKEN, actor: ACTOR, operation: "claim_fees" });
  const nativeAsset = native.expected.claimAssets.find((a)=>a.delivery === "native");
  assert.equal(nativeAsset.amountRaw, "17000000000000");
  assert.equal(nativeAsset.decimals, 18);
  assert.equal(nativeAsset.ledgerAmountRaw, "17");
  assert.equal(native.expected.payoutAsset, zeroAddress);
  for (const generation of [3,4,5]) {
    const project = await fixture(generation).adapter.readProject(TOKEN);
    assert.equal(project.fees.quoteAsset, USDC);
    assert.equal(project.fees.quoteDecimals, 6);
    assert.equal(project.fees.claimableQuoteRaw, "17");
    assert.equal(project.fees.payoutAsset, zeroAddress);
    assert.equal(project.fees.payoutDecimals, 18);
  }
  const converted = await fixture(7, { converts: true }).adapter.prepareManagement({ token: TOKEN, actor: ACTOR, operation: "claim_fees" });
  assert.equal(converted.expected.claimAssets.find((a)=>same(a.asset,USDC)).amountRaw, "40");
  assert.equal(converted.expected.claimAssets.find((a)=>same(a.asset,TOKEN)).amountRaw, "19");
  const other = await fixture(7, { quote: OTHER_QUOTE, converts: true }).adapter.prepareManagement({ token: TOKEN, actor: ACTOR, operation: "claim_fees" });
  assert.equal(other.expected.claimAssets.length, 3);
  assert.equal(other.expected.claimAssets.find((a)=>same(a.asset,OTHER_QUOTE)).decimals, 8);
});

test("zero fee ledgers and unsupported V1 administration cannot create gas-only actions", async () => {
  for (const generation of [1, 3, 6, 7]) {
    const { adapter } = fixture(generation, { parked: 0n, quoteFees: 0n, tokenFees: 0n, convertedFees: 0n });
    await assert.rejects(adapter.prepareManagement({ token: TOKEN, actor: CREATOR, operation: "claim_fees" }), { code: "NOTHING_TO_CLAIM" });
    for (const operation of ["set_split", "propose_owner", "accept_owner"]) {
      await assert.rejects(adapter.prepareManagement({ token: TOKEN, actor: CREATOR, operation }), { code: "UNSUPPORTED" });
    }
  }
});

test("legacy v3 trade uses the canonical router, current tax, post-tax minimum and a chain deadline", async () => {
  const { adapter } = fixture(1);
  const plan = await adapter.prepareTrade(trade());
  assert.equal(plan.steps.length, 3);
  assert.equal(plan.steps.at(-1).to, getAddress(ARC_ADDRESSES.swapRouter02));
  const batch = decode(plan.steps.at(-1));
  assert.equal(batch.functionName, "multicall");
  assert.equal(batch.args[0], 1_800_000_600n);
  const swap = decodeFunctionData({ abi: swapRouter02Abi, data: batch.args[1][0] });
  assert.equal(swap.functionName, "exactInputSingle");
  assert.equal(swap.args[0].amountIn, 1000n);
  assert.equal(swap.args[0].recipient, ACTOR);
  assert.equal(plan.summary.taxBps, 300);
  const routerMinimum = BigInt(plan.expected.routerMinimumAmountOutRaw);
  assert.equal(BigInt(plan.expected.minimumAmountOutRaw), routerMinimum - routerMinimum * 300n / 10000n);
  const sold = await adapter.prepareTrade(trade({ side: "sell", amountIn: "0.000000000001" }));
  assert.equal(sold.summary.taxBps, 0);
  assert.equal(sold.summary.spendUsdcRaw, "0");
  const expiredTax = await fixture(2, { overrides: { currentTaxes: [0,0] } }).adapter.prepareTrade(trade());
  assert.equal(expiredTax.summary.taxBps, 0);
});

test("hooked V1 trades preserve timed exact approvals and account for live anti-snipe tax", async () => {
  for (const generation of [3,4,5,6,7]) {
    const plan = await fixture(generation, { overrides: { currentSnipeTaxBps: 300n } }).adapter.prepareTrade(trade());
    assert.equal(plan.steps.length, 4);
    assert.equal(plan.steps.at(-1).to, getAddress(ARC_ADDRESSES.universalRouter));
    assert.equal(decode(plan.steps.at(-1)).functionName, "execute");
    assert.equal(decode(plan.steps[2]).args[2], 1000n);
    assert.equal(plan.summary.taxBps, 600);
    assert.equal(plan.expected.minimumAmountOutRaw, plan.expected.routerMinimumAmountOutRaw);
  }
});

test("V1 quotes reject unsupported denominations, spoofed fees, zero liquidity and invalid units", async () => {
  for (const quote of [OTHER_QUOTE,zeroAddress]) await assert.rejects(fixture(7, { quote }).adapter.prepareTrade(trade()), { code: "UNSUPPORTED" });
  await assert.rejects(fixture(7, { overrides: { decimals: 8 } }).adapter.prepareTrade(trade()), { code: "UNSUPPORTED" });
  await assert.rejects(fixture(7, { overrides: { buyTaxBps: 600 } }).adapter.prepareTrade(trade()), { code: "CONTRACT_MISMATCH" });
  await assert.rejects(fixture(7, { overrides: { getSlot0: [sqrtRatioAtTick(50),50,0,500] } }).adapter.prepareTrade(trade()), { code: "CONTRACT_MISMATCH" });
  await assert.rejects(fixture(7, { overrides: { getLiquidity: 0n } }).adapter.prepareTrade(trade()), { code: "NO_LIQUIDITY" });
  await assert.rejects(fixture(7).adapter.prepareTrade(trade({ amountIn: "0.0000001" })), /exact decimal/);
  await assert.rejects(fixture(1).adapter.prepareTrade(trade({ slippageBps: 10000 })), /slippageBps/);
});

test("bounded quotes refuse crossing unknown liquidity and handle exact tax rounding", () => {
  const input = { amountIn: 1000n, zeroForOne: false, sqrtPriceX96: sqrtRatioAtTick(50), tick: 50, liquidity: 10n**24n,
    taxBps: 300, slippageBps: 100, legacy: true };
  const quote = quoteLegacyWithinTick(input);
  assert.ok(quote.minimum > 0n);
  assert.equal(quote.minimum, quote.routerMinOut - quote.routerMinOut * 300n / 10000n);
  assert.throws(()=>quoteLegacyWithinTick({ ...input, amountIn:10n**28n }), { code: "QUOTE_RANGE_EXCEEDED" });
  assert.throws(()=>quoteLegacyWithinTick({ ...input, amountIn:1n }), /positive minimum/);
});


test("V1 buy and sell routing follows both currency orderings", async () => {
  const highToken = getAddress("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
  for (const generation of [1,7]) for (const token of [TOKEN,highToken]) for (const side of ["buy","sell"]) {
    const plan = await fixture(generation, { token }).adapter.prepareTrade(trade({ token, side,
      amountIn: side === "buy" ? "0.001" : "0.000000000001" }));
    assert.equal(plan.expected.currencyIn, side === "buy" ? USDC : token);
    assert.equal(plan.expected.currencyOut, side === "buy" ? token : USDC);
    assert.ok(BigInt(plan.expected.minimumAmountOutRaw) > 0n);
    assert.equal(plan.summary.taxBps, side === "buy" ? 300 : generation === 1 ? 0 : 500);
  }
});

test("zero in-range liquidity only quotes a proven adjacent range in the actual swap direction", async () => {
  const options = { overrides: { getSlot0: [sqrtRatioAtTick(200), 200, 0, 10000], getLiquidity: 0n, getTickLiquidity: [10n**24n, -(10n**24n)] } };
  const plan = await fixture(7, options).adapter.prepareTrade(trade({ side: "sell", amountIn: "0.000000000001" }));
  assert.ok(BigInt(plan.expected.minimumAmountOutRaw) > 0n);
  await assert.rejects(fixture(7, options).adapter.prepareTrade(trade()), { code: "NO_LIQUIDITY" });
});


test("recognized native-quote V1 tokens keep reads available with explicit unavailable fee amounts", async () => {
  for (const generation of [6,7]) {
    const { adapter, calls } = fixture(generation, { quote: zeroAddress });
    const project = await adapter.readProject(TOKEN);
    assert.equal(project.version, "v1");
    assert.equal(project.name, "Existing V1 token");
    assert.equal(project.quoteAsset, zeroAddress);
    assert.equal(project.owedCreatorRaw, null);
    assert.equal(project.fees.claimableQuoteRaw, null);
    assert.equal(project.fees.executionSupported, false);
    assert.equal(project.fees.reason, "unsupported_native_quote");
    assert.deepEqual(project.capabilities.management, []);
    assert.equal(project.capabilities.trading, false);
    assert.ok(calls.every((call) => !same(call.address, zeroAddress)));
    await assert.rejects(adapter.prepareManagement({ token: TOKEN, actor: CREATOR, operation: "claim_fees" }), { code: "UNSUPPORTED" });
    await assert.rejects(adapter.prepareTrade(trade()), { code: "UNSUPPORTED" });
  }
});


test("Portal 3 and 4 use recipient-only claim() and never prepare claim(address)", async () => {
  for (const generation of [3,4]) {
    const { adapter } = fixture(generation);
    const state = await adapter.readProject(TOKEN);
    assert.equal(state.fees.claimPermission, "recipient_only");
    assert.equal(state.fees.requiredSigner, CREATOR);
    await assert.rejects(adapter.prepareManagement({ token: TOKEN, actor: ACTOR, operation: "claim_fees" }), { code: "UNAUTHORIZED" });
    const plan = await adapter.prepareManagement({ token: TOKEN, actor: CREATOR, operation: "claim_fees" });
    assert.equal(plan.steps[0].data, "0x4e71d92d");
    assert.equal(decode(plan.steps[0]).functionName, "claim");
    assert.equal(decode(plan.steps[0]).args, undefined);
    assert.equal(plan.expected.claimPermission, "recipient_only");
    assert.equal(plan.expected.requiredSigner, CREATOR);
    assert.match(plan.summary.ownershipNote, /requires that creator/);
  }
  for (const generation of [1,2,5,6,7]) {
    const state = await fixture(generation).adapter.readProject(TOKEN);
    assert.equal(state.fees.claimPermission, "permissionless");
    assert.equal(state.fees.requiredSigner, null);
    const plan = await fixture(generation).adapter.prepareManagement({ token: TOKEN, actor: ACTOR, operation: "claim_fees" });
    assert.deepEqual(decode(plan.steps[0]).args, [CREATOR]);
  }
});
