import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { decodeFunctionData, getAddress, zeroAddress } from "viem";
import { createContractAdapter } from "../scripts/argus-agent/contracts.mjs";

const bundle = JSON.parse(readFileSync(new URL("../scripts/argus-agent/vendor/argus-v4.json", import.meta.url), "utf8"));
const p8 = bundle.portal8;
const A = getAddress("0x1111111111111111111111111111111111111111");
const B = getAddress("0x2222222222222222222222222222222222222222");
const C = getAddress("0x3333333333333333333333333333333333333333");
const TOKEN = getAddress("0x5555555555555555555555555555555555555555");
const HOOK = getAddress("0x6666666666666666666666666666666666666666");
const ESCROW = getAddress("0x7777777777777777777777777777777777777777");
const USDC = p8.addresses.defaultQuoteAsset;
const BRAND = { name: "Approved Project", symbol: "APRV", description: "The approved original project description.",
  imageURI: "ipfs://approved-image", website: "https://project.example", twitter: "https://x.com/project", telegram: "https://t.me/project" };

function fixture(overrides = {}) {
  const calls = [];
  const client = {
    getChainId: async () => 5042,
    getBlock: async () => ({ number: 900n, timestamp: 1_000n }),
    getCode: async () => "0x",
    getLogs: async (request) => {
      calls.push({ method: "getLogs", ...request });
      return [{ args: { token: TOKEN, ...BRAND } }];
    },
    readContract: async (request) => {
      calls.push(request);
      const { functionName, address } = request;
      if (functionName in overrides) return typeof overrides[functionName] === "function" ? overrides[functionName](request) : overrides[functionName];
      switch (functionName) {
        case "creatorRegistry": return p8.addresses.creatorRegistry;
        case "launches": return [HOOK, ESCROW, A, 1n, 0, 200, false];
        case "payoutOf": return B;
        case "proposedPayout": return C;
        case "escrowOf": return ESCROW;
        case "payoutSplit": return [[], []];
        case "balanceOf": return address.toLowerCase() === USDC.toLowerCase() ? 10_000_000n : 10n ** 24n;
        case "allowance": return request.args.length === 3 ? [0n, 0, 0] : 7n;
        case "MAX_IMAGE_URI_BYTES": return 512n;
        case "name": return BRAND.name;
        case "symbol": return BRAND.symbol;
        case "logo": return BRAND.imageURI;
        case "owedCreator": return 25_000n;
        case "quoteAsset": return USDC;
        case "buyTaxBps": return 300;
        case "sellTaxBps": return 300;
        case "launchedAt": return 900;
        case "decimals": return 18;
        case "getSlot0": return [1n << 96n, 0, 0, 0];
        case "getLiquidity": return 10n ** 24n;
        default: throw new Error(`Unexpected read ${functionName}`);
      }
    },
  };
  const helperCalls = [];
  const helper = async (_client, _bundle, settings) => {
    helperCalls.push(settings);
    return { agrees: true, floor: 4_500_000n, mined: { hook: HOOK, escrow: ESCROW, hookSalt: `0x${settings.saltStart.toString(16).padStart(64, "0")}` },
      params: { name: settings.name, symbol: settings.symbol, totalSupply: settings.totalSupply,
        buyTaxBps: settings.buyTaxBps, sellTaxBps: settings.sellTaxBps, alloc: settings.alloc,
        quoteAsset: settings.quote, payoutAsset: settings.payoutAsset, kothBps: 0, payoutAddress: settings.payoutAddress,
        identityProvider: `0x${"00".repeat(32)}`, identitySubject: 0n,
        bundle: [{ to: settings.devBuyTo, amountQuote: settings.seed }], snipeExempt: [],
        meta: { imageURI: settings.imageURI, website: "", twitter: "", telegram: "", description: "" } } };
  };
  return { calls, helperCalls, client, adapter: createContractAdapter(client, { prepareLaunch: helper }) };
}
const project = (extra = {}) => ({ operator: A, controller: B, treasury: C, brand: BRAND, seedUsdc: "4.5", idempotencyKey: "approved-project-one", ...extra });
const decode = (step) => decodeFunctionData({ abi: step.abi, data: step.data });

test("launch preserves three independent roles and every approved brand field in actual calldata", async () => {
  const { adapter, helperCalls, calls } = fixture();
  const plan = await adapter.prepareProject(project());
  assert.equal(helperCalls[0].creator, A);
  assert.equal(helperCalls[0].payoutAddress, B);
  assert.equal(helperCalls[0].devBuyTo, C);
  assert.equal(helperCalls[0].seed, 4_500_000n);
  assert.equal(plan.steps.length, 3);
  assert.equal(decode(plan.steps[0]).args[1], 0n);
  assert.equal(decode(plan.steps[1]).args[1], 4_500_000n);
  const launch = decode(plan.steps[2]);
  assert.equal(launch.functionName, "launch");
  assert.equal(launch.args[0].payoutAddress, B);
  assert.equal(launch.args[0].bundle[0].to, C);
  for (const key of ["description", "imageURI", "website", "twitter", "telegram"]) assert.equal(launch.args[0].meta[key], BRAND[key]);
  assert.equal(plan.expected.controller, B);
  assert.equal(plan.expected.treasury, C);
  assert.equal(plan.summary.spendUsdcRaw, "4500000");
  assert.ok(plan.steps.every((step) => step.value === "0"));
  assert.ok(calls.every((call) => call.blockNumber === 900n));
  assert.doesNotThrow(() => JSON.stringify(plan));
  assert.throws(() => { plan.expected.brand.name = "Changed"; }, TypeError);
  assert.ok(Object.isFrozen(plan.steps[2].abi));
});

test("launch rejects rounded amounts, invalid taxes, unprovided art and the current opening-buy floor", async () => {
  const { adapter } = fixture();
  await assert.rejects(adapter.prepareProject(project({ seedUsdc: "4.5000001" })), /exact decimal/);
  await assert.rejects(adapter.prepareProject(project({ seedUsdc: "4.49" })), /current floor/);
  await assert.rejects(adapter.prepareProject(project({ buyTaxBps: 99 })), /tax/i);
  await assert.rejects(adapter.prepareProject(project({ brand: { ...BRAND, imageURI: "generate it" } })), /existing HTTPS or IPFS/);
});

test("registry management enforces current and proposed controllers without pretending to transfer token admin", async () => {
  const { adapter } = fixture();
  await assert.rejects(adapter.prepareManagement({ token: TOKEN, actor: A, operation: "set_split", parts: [] }), { code: "UNAUTHORIZED" });
  const split = await adapter.prepareManagement({ token: TOKEN, actor: B, operation: "set_split", parts: [{ recipient: C, bps: 10_000 }] });
  assert.equal(decode(split.steps[0]).functionName, "setPayoutSplit");
  assert.deepEqual(decode(split.steps[0]).args[1], [{ recipient: C, bps: 10_000 }]);
  await assert.rejects(adapter.prepareManagement({ token: TOKEN, actor: B, operation: "set_split", parts: [{ recipient: C, bps: 9999 }] }), /100%/);
  await assert.rejects(adapter.prepareManagement({ token: TOKEN, actor: B, operation: "set_split", parts: [{ recipient: ESCROW, bps: 10_000 }] }), /protocol address/);
  const proposed = await adapter.prepareManagement({ token: TOKEN, actor: B, operation: "propose_owner", newController: C });
  assert.equal(decode(proposed.steps[0]).functionName, "proposePayout");
  assert.equal(proposed.expected.requiresAcceptance, true);
  await assert.rejects(adapter.prepareManagement({ token: TOKEN, actor: B, operation: "accept_owner" }), { code: "UNAUTHORIZED" });
  const accepted = await adapter.prepareManagement({ token: TOKEN, actor: C, operation: "accept_owner" });
  assert.equal(decode(accepted.steps[0]).functionName, "acceptPayout");
  assert.deepEqual(accepted.expected.split, []);
  assert.match(accepted.summary.ownershipNote, /not arbitrary token admin/);
});

test("creator-fee claims are permissionless and cannot redirect the registered payout", async () => {
  const { adapter } = fixture({ payoutSplit: [[B, C], [6000, 4000]] });
  const plan = await adapter.prepareManagement({ token: TOKEN, actor: A, operation: "claim_fees" });
  assert.equal(plan.steps[0].to, ESCROW);
  assert.equal(decode(plan.steps[0]).functionName, "claimCreator");
  assert.equal(decode(plan.steps[0]).args, undefined);
  assert.deepEqual(plan.expected.recipients, [{ recipient: B, bps: 6000 }, { recipient: C, bps: 4000 }]);
  const empty = fixture({ owedCreator: 0n });
  await assert.rejects(empty.adapter.prepareManagement({ token: TOKEN, actor: A, operation: "claim_fees" }), { code: "NOTHING_TO_CLAIM" });
});

test("post-launch metadata and taxes fail explicitly; mismatched registries and unsupported tokens fail closed", async () => {
  const { adapter } = fixture();
  for (const operation of ["set_metadata", "set_taxes"]) await assert.rejects(adapter.prepareManagement({ operation }), { code: "UNSUPPORTED" });
  const wrongRegistry = fixture({ creatorRegistry: A });
  await assert.rejects(wrongRegistry.adapter.readProject(TOKEN), { code: "CONTRACT_MISMATCH" });
  const unknown = fixture({ launches: [zeroAddress] });
  await assert.rejects(unknown.adapter.readProject(TOKEN), { code: "UNSUPPORTED" });
});

test("project reads use one known launch block for metadata and report each role's actual balances", async () => {
  const { adapter, calls } = fixture();
  const state = await adapter.readProject(TOKEN, { roles: { operator: A, controller: B, treasury: C }, fromBlock: "800" });
  const logs = calls.filter((call) => call.method === "getLogs");
  assert.equal(logs.length, 1);
  assert.equal(logs[0].fromBlock, 800n);
  assert.equal(logs[0].toBlock, 800n);
  assert.equal(state.metadata.description, BRAND.description);
  assert.equal(state.metadataStatus, "confirmed_event");
  assert.equal(state.logo, BRAND.imageURI);
  assert.equal(state.balances.length, 3);
  assert.equal(state.balances[2].role, "treasury");
  assert.equal(state.balances[2].tokenRaw, (10n ** 24n).toString());
  assert.equal(state.owedCreatorRaw, "25000");
  await assert.rejects(adapter.readProject(TOKEN, { fromBlock: 0, toBlock: 20_000 }), /known launch range/);
  const noRange = fixture();
  assert.equal((await noRange.adapter.readProject(TOKEN)).metadataStatus, "launch_block_required");
  assert.ok(noRange.calls.every((call) => call.method !== "getLogs"));
});

test("trade uses exact input approvals, a timed router allowance and the supplied treasury actor", async () => {
  const { adapter } = fixture();
  const plan = await adapter.prepareTrade({ token: TOKEN, actor: C, side: "sell", amountIn: "0.000000000001", slippageBps: 100 });
  assert.equal(plan.expected.actor, C);
  assert.equal(plan.expected.currencyIn, TOKEN);
  assert.equal(plan.expected.currencyOut, USDC);
  assert.equal(plan.expected.amountInRaw, "1000000");
  assert.equal(plan.summary.spendUsdcRaw, "0");
  assert.equal(plan.expected.deadline, "1600");
  assert.equal(plan.steps.length, 4);
  const permit = decode(plan.steps[2]);
  assert.equal(permit.functionName, "approve");
  assert.equal(permit.args[2], 1_000_000n);
  assert.equal(permit.args[3], 1600);
  const swap = decode(plan.steps[3]);
  assert.equal(swap.functionName, "execute");
  assert.equal(swap.args[0], "0x10");
  assert.equal(swap.args[2], 1600n);
  const buy = await adapter.prepareTrade({ token: TOKEN, actor: C, side: "buy", amountIn: "0.5" });
  assert.equal(buy.expected.amountInRaw, "500000");
  assert.equal(buy.summary.spendUsdcRaw, "500000");
  await assert.rejects(adapter.prepareTrade({ token: TOKEN, actor: C, side: "buy", amountIn: "0.5000001" }), /exact decimal/);
});

test("known-token portfolio remains explicitly scoped and never scans for untracked holdings", async () => {
  const { adapter, calls } = fixture();
  const portfolio = await adapter.readPortfolio({ account: C, tokens: [TOKEN, TOKEN] });
  assert.equal(portfolio.holdings.length, 1);
  assert.equal(portfolio.usdcRaw, "10000000");
  assert.equal(portfolio.usdcDecimals, 6);
  assert.match(portfolio.scope, /not complete wallet discovery/);
  assert.ok(calls.every((call) => call.method !== "getLogs"));
});

test("every chain-backed method refuses a non-mainnet client before preparation or reads", async () => {
  const { client, adapter, calls } = fixture();
  client.getChainId = async () => 5042002;
  await assert.rejects(adapter.prepareProject(project()), { code: "CHAIN_MISMATCH" });
  await assert.rejects(adapter.readProject(TOKEN), { code: "CHAIN_MISMATCH" });
  await assert.rejects(adapter.prepareTrade({ token: TOKEN, actor: C, side: "buy", amountIn: "0.5" }), { code: "CHAIN_MISMATCH" });
  assert.equal(calls.length, 0);
});

test("launch salt search is stable per approval, distinct across approvals, and skips already deployed parts", async () => {
  const { adapter, client, helperCalls } = fixture();
  const first = await adapter.prepareProject(project());
  const replay = await adapter.prepareProject(project());
  const second = await adapter.prepareProject(project({ idempotencyKey: "approved-project-two" }));
  assert.equal(first.expected.hookSalt, replay.expected.hookSalt);
  assert.notEqual(first.expected.hookSalt, second.expected.hookSalt);
  let checks = 0;
  client.getCode = async ({ blockNumber }) => { assert.equal(blockNumber, 900n); return ++checks === 1 ? "0x6000" : "0x"; };
  const before = helperCalls.length;
  const skipped = await adapter.prepareProject(project());
  assert.equal(helperCalls.length - before, 2);
  assert.equal(BigInt(skipped.expected.hookSalt), BigInt(first.expected.hookSalt) + 1n);
  client.getCode = async () => "0x6000";
  const boundedBefore = helperCalls.length;
  await assert.rejects(adapter.prepareProject(project()), { code: "LAUNCH_SALT_OCCUPIED", safe: true });
  assert.equal(helperCalls.length - boundedBefore, 3);
});

test("public validation errors are safe while RPC failures are left untrusted for SDK redaction", async () => {
  const { adapter, client } = fixture();
  await assert.rejects(adapter.prepareProject(project({ seedUsdc: "invalid" })), { code: "INVALID_INPUT", safe: true });
  const rpcError = new Error("upstream provider details must be redacted");
  client.getCode = async () => { throw rpcError; };
  await assert.rejects(adapter.prepareProject(project()), (error) => error === rpcError && error.safe === undefined);
});
