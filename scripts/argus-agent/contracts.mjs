import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { encodeFunctionData, getAddress, parseUnits, zeroAddress } from "viem";
import { prepareLaunch as publishedPrepareLaunch } from "./vendor/argus-v5-launch-example.mjs";
import * as rules from "./generated/v5-launch-rules.mjs";
import * as market from "./generated/v5-market.mjs";
import { ARC_ADDRESSES } from "./generated/addresses.mjs";
import { erc20Abi, permit2Abi, stateViewAbi, universalRouterAbi } from "./generated/abis.mjs";
import { encodeV4ExactInSwap } from "./generated/swap-encoding.mjs";
import { legacyPortalAbi, LEGACY_PORTALS, readLegacyState, readLegacyFees, prepareLegacyClaim, prepareLegacyTrade } from "./legacy-contracts.mjs";

const bundleDefault = JSON.parse(readFileSync(new URL("./vendor/argus-v4.json", import.meta.url), "utf8"));

function fail(message, code = "INVALID_INPUT") {
  throw Object.assign(new Error(message), { code, safe: true });
}
function address(value, label) {
  let result;
  try { result = getAddress(value); } catch { fail(`${label} must be an address.`); }
  if (result === zeroAddress) fail(`${label} must not be the zero address.`);
  return result;
}
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
function amount(value, decimals, label) {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value) || (value.split(".")[1]?.length ?? 0) > decimals) {
    fail(`${label} must be an exact decimal string with at most ${decimals} decimal places.`);
  }
  const raw = parseUnits(value, decimals);
  if (raw <= 0n || raw > rules.V5_MAX_UINT128) fail(`${label} is outside the supported positive uint128 range.`);
  return raw;
}
function immutable(value) {
  const result = JSON.parse(JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item));
  const freeze = (item) => {
    if (item && typeof item === "object") {
      Object.values(item).forEach(freeze);
      Object.freeze(item);
    }
    return item;
  };
  return freeze(result);
}
function checked(refusal) { if (refusal) fail(refusal.message); }
function brandInput(value) {
  if (!value || typeof value !== "object") fail("Supply the approved project brand.");
  const brand = {};
  for (const key of ["name", "symbol", "description", "imageURI", "website", "twitter", "telegram"]) {
    if (value[key] !== undefined && typeof value[key] !== "string") fail(`brand.${key} must be text.`);
    brand[key] = value[key] ?? "";
  }
  if (!brand.name.trim() || !brand.symbol.trim() || !brand.imageURI) fail("A project name, symbol and existing imageURI are required.");
  if (!/^(https:\/\/|ipfs:\/\/)/.test(brand.imageURI)) fail("Use an existing HTTPS or IPFS imageURI.");
  return brand;
}

/** Read and prepare only. Signing, policy admission and receipt verification belong to the engine. */
export function createContractAdapter(client, { bundle = bundleDefault, prepareLaunch = publishedPrepareLaunch } = {}) {
  const p8 = bundle.portal8;
  const portal = address(bundle.launchPortal, "Portal");
  const registry = address(p8.addresses.creatorRegistry, "Creator registry");
  const usdc = address(p8.addresses.defaultQuoteAsset, "USDC");
  const abi = (name) => p8.contracts[name].abi;
  const portalAbi = abi("ArgusV5Portal");
  const registryAbi = abi("ArgusV5CreatorRegistry");
  const escrowAbi = abi("ArgusV5PayoutEscrow");
  const tokenAbi = abi("ArgusV5RewardedToken");
  const hookAbi = abi("ArgusV5TaxHook");
  const call = (to, contractAbi, functionName, args, label) => ({
    to, data: encodeFunctionData({ abi: contractAbi, functionName, args }), value: "0", label, abi: contractAbi,
  });
  const approve = (token, spender, raw, label) => call(token, erc20Abi, "approve", [spender, raw], label);

  async function snapshot() {
    if (await client.getChainId() !== 5042 || bundle.chain.chainId !== 5042) fail("Arc mainnet (5042) is required.", "CHAIN_MISMATCH");
    const block = await client.getBlock();
    const read = (to, contractAbi, functionName, args = []) => client.readContract({ address: to, abi: contractAbi, functionName, args, blockNumber: block.number });
    return { block, read };
  }

  async function creatorState(token, read) {
    const liveRegistry = await read(portal, portalAbi, "creatorRegistry");
    if (!same(liveRegistry, registry)) fail("The Portal creator registry differs from the published bundle.", "CONTRACT_MISMATCH");
    const record = await read(portal, portalAbi, "launches", [token]);
    if (same(record[0], zeroAddress)) {
      const legacy = await readLegacyState(token, read);
      if (!legacy) fail("This token was not launched by a supported Argus Portal.", "UNSUPPORTED");
      return legacy;
    }
    const [payout, proposed, escrow, split] = await Promise.all([
      read(registry, registryAbi, "payoutOf", [token]), read(registry, registryAbi, "proposedPayout", [token]),
      read(registry, registryAbi, "escrowOf", [token]), read(registry, registryAbi, "payoutSplit", [token]),
    ]);
    if (same(payout, zeroAddress) || !same(escrow, record[1])) fail("The creator registry and launch escrow disagree.", "CONTRACT_MISMATCH");
    return { version: "v2", portalGeneration: 8, line: "v5", portal, feeModel: "v5_escrow",
      capabilities: { management: ["set_split", "propose_owner", "accept_owner", "claim_fees"], trading: true, ownership: "payout_controller" },
      token, hook: record[0], escrow, payout, controller: payout, proposed: same(proposed, zeroAddress) ? null : proposed,
      split: split[0].map((recipient, i) => ({ recipient, bps: Number(split[1][i]) })), tokenIsToken0: record[6] };
  }

  async function prepareProject(input) {
    const operator = address(input.operator, "Operator");
    const controller = address(input.controller, "Controller");
    const treasury = address(input.treasury, "Treasury");
    const brand = brandInput(input.brand);
    const seed = amount(input.seedUsdc, 6, "seedUsdc");
    const buyTaxBps = input.buyTaxBps ?? 300;
    const sellTaxBps = input.sellTaxBps ?? 300;
    if (!Number.isInteger(buyTaxBps) || !Number.isInteger(sellTaxBps)) fail("Tax basis points must be integers.");
    checked(rules.checkTaxes(buyTaxBps, sellTaxBps));
    const totalSupply = input.totalSupply === undefined ? 10n ** 27n : amount(input.totalSupply, 18, "totalSupply");
    checked(rules.checkSupply(totalSupply, new TextEncoder().encode(brand.imageURI).length));
    const alloc = input.alloc ?? [10_000, 0, 0, 0, 0];
    if (!Array.isArray(alloc) || alloc.length !== 5 || alloc.some((v) => !Number.isInteger(v) || v < 0) || alloc.reduce((a, b) => a + b, 0) !== 10_000) fail("Five allocation basis-point values must total 10000.");
    if (typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim() || input.idempotencyKey.length > 128) fail("Supply a stable idempotency key of at most 128 characters.");
    const { block, read } = await snapshot();
    const settings = {
      creator: operator, payoutAddress: controller, devBuyTo: treasury, quote: usdc, payoutAsset: usdc,
      name: brand.name, symbol: brand.symbol, imageURI: brand.imageURI, seed, buyTaxBps, sellTaxBps, totalSupply, alloc,
    };
    // Give independently approved launches distinct deterministic search ranges.
    // The helper bounds each salt search; at most three occupied candidates are
    // considered here. The final simulation still catches a deployment race.
    const saltDomain = JSON.stringify(["argus-agent-project-v1", operator, controller, treasury, input.idempotencyKey, brand, input.seedUsdc, buyTaxBps, sellTaxBps]);
    let saltStart = BigInt(`0x${createHash("sha256").update(saltDomain).digest("hex").slice(0, 32)}`);
    let launch;
    for (let attempt = 0; attempt < 3; attempt++) {
      const candidate = await prepareLaunch({ readContract: (request) => client.readContract({ ...request, blockNumber: block.number }) }, bundle, { ...settings, saltStart });
      if (!candidate.agrees) fail("The hook and escrow prediction did not match the Portal.", "CONTRACT_MISMATCH");
      const codes = await Promise.all([candidate.mined.hook, candidate.mined.escrow].map((target) => client.getCode({ address: target, blockNumber: block.number })));
      if (codes.every((code) => !code || code === "0x")) { launch = candidate; break; }
      saltStart = BigInt(candidate.mined.hookSalt) + 1n;
    }
    if (!launch) fail("No unused hook and escrow were found within the bounded launch search. No transaction was prepared.", "LAUNCH_SALT_OCCUPIED");
    if (seed < launch.floor) fail(`Opening buy is below the current floor of ${launch.floor} raw USDC units.`);
    checked(rules.checkCreatorPayout(controller, [portal, launch.mined.escrow, ...Object.values(p8.addresses)]));
    const [balance, allowance, maxImageBytes] = await Promise.all([
      read(usdc, erc20Abi, "balanceOf", [operator]), read(usdc, erc20Abi, "allowance", [operator, portal]),
      read(portal, portalAbi, "MAX_IMAGE_URI_BYTES"),
    ]);
    if (balance < seed) fail("The operator does not hold the opening-buy USDC.", "INSUFFICIENT_BALANCE");
    if (BigInt(new TextEncoder().encode(brand.imageURI).length) > maxImageBytes) fail("The imageURI exceeds the current Portal limit.");
    // The published example omits the descriptive fields. Preserve the approved
    // brand by encoding its actual launch tuple here; do not alter the example.
    const params = { ...launch.params, meta: Object.fromEntries(["imageURI", "website", "twitter", "telegram", "description"].map((k) => [k, brand[k]])) };
    const steps = [];
    if (allowance < seed) {
      if (allowance > 0n) steps.push(approve(usdc, portal, 0n, "Reset the Portal USDC approval"));
      steps.push(approve(usdc, portal, seed, "Approve the exact opening-buy USDC"));
    }
    steps.push(call(portal, portalAbi, "launch", [params, launch.mined.hookSalt], "Launch the approved project"));
    return immutable({ steps, expected: { chainId: 5042, portal, operator, controller, treasury, quoteAsset: usdc,
      hook: launch.mined.hook, escrow: launch.mined.escrow, hookSalt: launch.mined.hookSalt, brand, totalSupplyRaw: totalSupply, buyTaxBps, sellTaxBps, alloc, seedUsdcRaw: seed },
      summary: { kind: "launch", ...brand, operator, controller, treasury, seedUsdcRaw: seed, minimumSeedUsdcRaw: launch.floor,
        spendUsdcRaw: seed, observedBlockNumber: block.number, buyTaxBps, sellTaxBps,
        roleNote: "Operator funds and sends; controller controls creator fees; treasury receives the opening-buy tokens." } });
  }

  async function roleBalances(token, roles, block, read) {
    const entries = Object.entries(roles ?? {});
    if (entries.length > 8) fail("At most eight role balances can be read.");
    return Promise.all(entries.map(async ([role, value]) => {
      const owner = address(value, `Role ${role}`);
      const [tokenRaw, usdcRaw] = await Promise.all([
        read(token, erc20Abi, "balanceOf", [owner]), read(usdc, erc20Abi, "balanceOf", [owner]),
      ]);
      return { role, address: owner, tokenRaw, usdcRaw, observedBlockNumber: block.number };
    }));
  }

  async function readProject(tokenInput, { roles, fromBlock, toBlock } = {}) {
    const token = address(tokenInput, "Token");
    const { block, read } = await snapshot();
    const state = await creatorState(token, read);
    const [name, symbol, logo, owedCreatorRaw, balances] = await Promise.all([
      read(token, tokenAbi, "name"), read(token, tokenAbi, "symbol"), read(token, tokenAbi, "logo"),
      state.version === "v1" ? readLegacyFees(state, read) : read(state.escrow, escrowAbi, "owedCreator"), roleBalances(token, roles, block, read),
    ]);
    let metadata = null;
    let metadataStatus = "launch_block_required";
    if (fromBlock !== undefined) {
      const start = BigInt(fromBlock);
      const end = toBlock === undefined ? start : BigInt(toBlock);
      if (start < 0n || end < start || end > block.number || end - start >= 10_000n) fail("Metadata reads require a known launch range of at most 10000 blocks.");
      const metadataPortal = state.version === "v1" ? LEGACY_PORTALS.find((item) => same(item.address, state.portal)) : null;
      const metadataAbi = metadataPortal ? legacyPortalAbi(metadataPortal) : portalAbi;
      const eventName = metadataPortal ? "TokenCreated" : "LaunchMetadata";
      const logs = await client.getLogs({ address: state.portal, event: metadataAbi.find((x) => x.type === "event" && x.name === eventName),
        args: { token }, fromBlock: start, toBlock: end, strict: true });
      if (logs.length > 1) fail("Multiple launch metadata events were returned for one token.", "CONTRACT_MISMATCH");
      metadata = logs[0]?.args ?? null;
      if (metadataPortal && metadata) {
        const log = logs[0];
        const poolMatches = state.line === "legacy" ? same(metadata.pool, state.pool) : same(metadata.poolId, state.poolId);
        if (log.removed === true || !same(metadata.token, token) || !same(metadata.creator, state.historicalCreator) || !poolMatches) {
          fail("The historical metadata event disagrees with the verified launch record.", "CONTRACT_MISMATCH");
        }
      }
      metadataStatus = metadata ? "confirmed_event" : "not_found_in_requested_range";
    }
    return immutable({ ...state, name, symbol, logo, metadata, metadataStatus,
      ...(state.version === "v1" ? owedCreatorRaw : { owedCreatorRaw }), balances, observedBlockNumber: block.number });
  }

  async function prepareManagement(input) {
    if (!["set_split", "propose_owner", "accept_owner", "claim_fees"].includes(input.operation)) {
      fail("Supported management is fee splits, two-step payout-controller rotation and creator-fee claims. Post-launch metadata and tax changes are unsupported.", "UNSUPPORTED");
    }
    const token = address(input.token, "Token");
    const actor = address(input.actor, "Actor");
    const { block, read } = await snapshot();
    const state = await creatorState(token, read);
    if (state.version === "v1") {
      if (input.operation !== "claim_fees") fail("V1 creator authority and allocations are immutable; splits and owner rotation are unsupported.", "UNSUPPORTED");
      return immutable(prepareLegacyClaim(state, await readLegacyFees(state, read), actor, block));
    }
    if (["set_split", "propose_owner"].includes(input.operation) && !same(actor, state.payout)) fail("Only the current payout controller can make this change.", "UNAUTHORIZED");
    let step;
    const expected = { token, actor, operation: input.operation, controllerBefore: state.payout };
    if (input.operation === "set_split") {
      const parts = input.parts;
      if (!Array.isArray(parts) || parts.some((p) => !Number.isInteger(p.bps))) fail("Supply split parts with integer basis points; an empty list clears the split.");
      checked(rules.checkPayoutSplit(parts, token, state.escrow));
      const normalized = parts.map((p) => ({ recipient: address(p.recipient, "Recipient"), bps: p.bps }));
      step = call(registry, registryAbi, "setPayoutSplit", [token, normalized], "Set creator-fee recipients");
      expected.split = normalized;
    } else if (input.operation === "propose_owner") {
      const newController = address(input.newController, "New controller");
      checked(rules.checkCreatorPayout(newController, [token, state.escrow, ...Object.values(p8.addresses)]));
      step = call(registry, registryAbi, "proposePayout", [token, newController], "Propose the next payout controller");
      expected.proposedController = newController;
      expected.requiresAcceptance = true;
    } else if (input.operation === "accept_owner") {
      if (!state.proposed || !same(actor, state.proposed)) fail("Only the proposed payout controller can accept.", "UNAUTHORIZED");
      step = call(registry, registryAbi, "acceptPayout", [token], "Accept payout control and clear the previous split");
      expected.controller = actor;
      expected.split = [];
    } else {
      const owed = await read(state.escrow, escrowAbi, "owedCreator");
      if (owed <= 0n) fail("No creator fees are currently claimable.", "NOTHING_TO_CLAIM");
      // claimCreator is permissionless; its recipients are fixed by the registry.
      step = call(state.escrow, escrowAbi, "claimCreator", [], "Claim creator fees to the registered recipients");
      expected.owedCreatorRaw = owed;
      expected.recipients = state.split.length ? state.split : [{ recipient: state.payout, bps: 10_000 }];
    }
    return immutable({ steps: [step], expected, summary: { kind: "management", ...expected, observedBlockNumber: block.number,
      ownershipNote: "Controller refers to creator-fee authority, not arbitrary token admin rights.", spendUsdcRaw: "0" } });
  }

  async function prepareTrade(input) {
    const token = address(input.token, "Token");
    const actor = address(input.actor, "Actor");
    if (!["buy", "sell"].includes(input.side)) fail("Trade side must be buy or sell.");
    const isBuy = input.side === "buy";
    const amountIn = amount(input.amountIn, isBuy ? 6 : 18, "amountIn");
    const slippageBps = input.slippageBps ?? 100;
    if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) fail("slippageBps must be between 0 and 9999.");
    const { block, read } = await snapshot();
    const state = await creatorState(token, read);
    if (state.version === "v1") return immutable(await prepareLegacyTrade(state, { actor, side: input.side, amountIn, slippageBps }, block, read));
    const [quoteAsset, buyTaxBps, sellTaxBps, launchedAt, tokenDecimals] = await Promise.all([
      read(state.hook, hookAbi, "quoteAsset"), read(state.hook, hookAbi, "buyTaxBps"), read(state.hook, hookAbi, "sellTaxBps"),
      read(state.hook, hookAbi, "launchedAt"), read(token, erc20Abi, "decimals"),
    ]);
    if (!same(quoteAsset, usdc) || Number(tokenDecimals) !== 18) fail("Only direct USDC-paired Portal8 tokens with 18 decimals are supported.", "UNSUPPORTED");
    const key = market.v5PoolKey(token, usdc, state.hook);
    const poolId = market.v5PoolId(token, usdc, state.hook);
    const currencyIn = isBuy ? usdc : token;
    const currencyOut = isBuy ? token : usdc;
    const router = address(p8.addresses.universalRouter, "Router");
    const [slot0, liquidity, balance, allowance, permit] = await Promise.all([
      read(p8.addresses.stateView, stateViewAbi, "getSlot0", [poolId]), read(p8.addresses.stateView, stateViewAbi, "getLiquidity", [poolId]),
      read(currencyIn, erc20Abi, "balanceOf", [actor]), read(currencyIn, erc20Abi, "allowance", [actor, ARC_ADDRESSES.permit2]),
      read(ARC_ADDRESSES.permit2, permit2Abi, "allowance", [actor, currencyIn, router]),
    ]);
    if (balance < amountIn) fail("The trading wallet does not hold the full input amount.", "INSUFFICIENT_BALANCE");
    if (liquidity <= 0n || slot0[0] <= 0n) fail("The pool has no usable liquidity.", "NO_LIQUIDITY");
    const raw = market.quoteV5ExactIn({ isBuy, amountIn, tokenIsToken0: BigInt(token) < BigInt(usdc), sqrtPriceX96: slot0[0], liquidity,
      buyTaxBps: Number(buyTaxBps), sellTaxBps: Number(sellTaxBps), snipeBps: market.v5SnipeBps(Number(block.timestamp) - Number(launchedAt)) });
    const minimum = raw.amountOut * BigInt(10_000 - slippageBps) / 10_000n;
    if (minimum <= 0n || raw.amountOut > rules.V5_MAX_UINT128) fail("The quote has no supported positive minimum output.");
    const deadline = block.timestamp + 600n;
    const steps = [];
    if (allowance < amountIn) {
      if (allowance > 0n) steps.push(approve(currencyIn, ARC_ADDRESSES.permit2, 0n, "Reset the input approval to Permit2"));
      steps.push(approve(currencyIn, ARC_ADDRESSES.permit2, amountIn, "Approve exactly the input amount to Permit2"));
    }
    if (permit[0] < amountIn || BigInt(permit[1]) < deadline) steps.push(call(ARC_ADDRESSES.permit2, permit2Abi, "approve", [currencyIn, router, amountIn, Number(deadline)], "Approve the exact router amount for ten minutes"));
    steps.push({ to: router, data: encodeV4ExactInSwap({ key, zeroForOne: isBuy ? BigInt(usdc) < BigInt(token) : BigInt(token) < BigInt(usdc),
      amountIn, amountOutMinimum: minimum, currencyIn, currencyOut, deadline }), value: "0", label: `${isBuy ? "Buy" : "Sell"} the project token`, abi: universalRouterAbi });
    const expected = { token, actor, side: input.side, currencyIn, currencyOut, amountInRaw: amountIn, minimumAmountOutRaw: minimum, deadline };
    return immutable({ steps, expected, summary: { kind: "trade", ...expected, quotedAmountOutRaw: raw.amountOut, slippageBps,
      spendUsdcRaw: isBuy ? amountIn : 0n, observedBlockNumber: block.number, taxBps: raw.taxBps, impactBps: raw.impactBps,
      note: "Estimate from current pool state; simulate the exact transaction before signing. Actual output requires a confirmed receipt." } });
  }

  async function readPortfolio({ account, tokens }) {
    const owner = address(account, "Account");
    if (!Array.isArray(tokens) || tokens.length > 20) fail("Supply at most 20 explicitly tracked token addresses.");
    const tracked = [...new Set(tokens.map((token) => address(token, "Token")))];
    const { block, read } = await snapshot();
    const usdcRaw = await read(usdc, erc20Abi, "balanceOf", [owner]);
    const holdings = await Promise.all(tracked.map(async (token) => {
      await creatorState(token, read);
      const [name, symbol, balanceRaw, decimals] = await Promise.all([read(token, erc20Abi, "name"), read(token, erc20Abi, "symbol"),
        read(token, erc20Abi, "balanceOf", [owner]), read(token, erc20Abi, "decimals")]);
      return { token, name, symbol, balanceRaw, decimals: Number(decimals) };
    }));
    return immutable({ account: owner, usdcRaw, usdcDecimals: 6, holdings, observedBlockNumber: block.number,
      scope: "Explicitly tracked supported Argus tokens only; not complete wallet discovery, historical PnL or USD valuation." });
  }

  return Object.freeze({ prepareProject, readProject, prepareManagement, prepareTrade, readPortfolio });
}
