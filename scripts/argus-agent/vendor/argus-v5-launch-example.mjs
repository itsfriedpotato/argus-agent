#!/usr/bin/env node
/**
 * Argus Portal #8: build a launch from argus-v4.json, mine its hook salt, and
 * SIMULATE it. Nothing signs and nothing sends.
 *
 *   npm i viem                                  # the only dependency
 *   node argus-v5-launch-example.mjs
 *
 * Settings come from the environment, all optional:
 *
 *   CREATOR   the wallet that will SEND the launch       default: a throwaway address
 *   QUOTE     the asset the pool pairs with              default: USDC, the default quote
 *   BUY_TAX_BPS / SELL_TAX_BPS                           default: 300 / 300
 *   SEED      the opening buy, in the quote's raw units  default: the Portal's floor
 *   RPC       an Arc mainnet endpoint                    default: the bundle's chain.rpc
 *   BUNDLE    a path or URL for argus-v4.json            default: https://argus.world/argus-v4.json
 *
 * Set RPC. Public Arc endpoints vary a great deal in reliability, and the
 * bundle's chain.rpc is not always reachable.
 *
 * Every new Argus launch goes to Portal #8, `launchPortal` in argus-v4.json.
 * The older Portals in that file are legacy, and their launch calls, selectors
 * and hook salts do not work on Portal #8. Portal #7 launches made after its
 * listing cutoff (block 22,732,233, 2026-09-25) never appear in King of the
 * Hill or Top by market cap on Argus, and stay off its boards and search until
 * they bond.
 *
 * Four things are easy to get wrong, and each one fails as a revert AFTER the
 * creator has paid for gas. They are numbered in the code.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  bytesToHex,
  createPublicClient,
  decodeErrorResult,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  getContractAddress,
  hexToBytes,
  http,
  keccak256,
  pad,
  parseAbi,
  toHex,
} from "viem";

const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

/** The bundle, from a path or a URL. */
export async function loadBundle(source) {
  if (/^https?:\/\//.test(source)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`${source} answered ${response.status}`);
    return response.json();
  }
  return JSON.parse(readFileSync(source, "utf8"));
}

// ------------------------------------------------------------ the hook salt --

/**
 * (1) NOTHING LAUNCHES WITHOUT A MINED hookSalt, AND IT IS MINED FOR THE SENDER.
 *
 * Uniswap v4 reads a hook's permissions from the low 14 bits of its address,
 * and every launch deploys its own hook, so the salt must land that hook on
 * 0x20CC. The hook's constructor names the launch's ESCROW, and the escrow's
 * CREATE2 salt folds in `msg.sender` and the hook salt, so the escrow address
 * moves with every candidate and is re-derived inside the loop.
 *
 * A salt mined for the payout address, or for any wallet other than the one
 * that sends `launch()`, deploys the escrow somewhere the launch does not look,
 * and the launch reverts HookMismatch. `portal8.hookSalt` in the bundle spells
 * out every step; this is the same derivation.
 */
const ESCROW_DOMAIN = new TextEncoder().encode("argus.v5.escrow");

function create2(deployer, salt, initCodeHash) {
  const pre = new Uint8Array(85);
  pre[0] = 0xff;
  pre.set(deployer, 1);
  pre.set(salt, 21);
  pre.set(initCodeHash, 53);
  return keccak256(pre, "bytes").slice(12);
}

/**
 * The escrow and hook ONE candidate salt produces. `template` is patched in
 * place (the escrow word), so a loop allocates nothing per try.
 */
export function predictHook({ template, escrowInitCodeHash, portal, partsFactory, hookFactory, creator }, hookSalt, flags) {
  const escrowSalt = keccak256(Uint8Array.from([...ESCROW_DOMAIN, ...hexToBytes(getAddress(creator)), ...hookSalt]), "bytes");
  const escrow = create2(
    hexToBytes(getAddress(partsFactory)),
    keccak256(Uint8Array.from([...hexToBytes(getAddress(portal)), ...escrowSalt]), "bytes"),
    hexToBytes(escrowInitCodeHash)
  );
  // (2) THE ESCROW IS THE THIRD OF ELEVEN CONSTRUCTOR WORDS: 352 bytes from the
  //     end, plus 64. The Portal's own NatSpec said 320 until 2026-09-22, which
  //     lands on the treasury word, and every salt mined from it is dead.
  const at = template.length - 352 + 64;
  template.fill(0, at, at + 12);
  template.set(escrow, at + 12);
  // The hook factory takes the RAW salt; only the escrow's salt is hashed.
  const hook = create2(hexToBytes(getAddress(hookFactory)), hookSalt, keccak256(template, "bytes"));
  const mask = ((hook[18] << 8) | hook[19]) & 0x3fff;
  return { escrow: getAddress(bytesToHex(escrow)), hook: getAddress(bytesToHex(hook)), valid: mask === flags };
}

/** Grind salts from `start` until the hook lands on `flags`. The mean is 16,384 tries. */
export function mineHookSalt(inputs, { flags = 0x20cc, start = 0n, maxTries = 1 << 22 } = {}) {
  const working = { ...inputs, template: new Uint8Array(inputs.template) };
  let salt = start;
  for (let tries = 1; tries <= maxTries; tries += 1) {
    const bytes = hexToBytes(pad(toHex(salt), { size: 32 }));
    const prediction = predictHook(working, bytes, flags);
    if (prediction.valid) return { hookSalt: bytesToHex(bytes), hook: prediction.hook, escrow: prediction.escrow, tries };
    salt += 1n;
  }
  throw new Error("no salt in range: check the inputs before trying more");
}

// ------------------------------------------------------------------ launch --

/** Everything `launch()` needs, read and checked against the bundle. */
export async function prepareLaunch(client, bundle, settings) {
  const p8 = bundle.portal8;
  const portal = getAddress(bundle.launchPortal);
  if (portal !== getAddress(p8.addresses.portal)) throw new Error("launchPortal and portal8.addresses.portal disagree");
  const portalAbi = p8.contracts.ArgusV5Portal.abi;
  const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args });

  // The bundle is a snapshot; the Portal is the authority. Ask it.
  for (const key of ["registry", "partsFactory", "hookFactory"]) {
    const live = getAddress(await read(portal, portalAbi, key));
    if (live !== getAddress(p8.addresses[key])) throw new Error(`Portal.${key}() is ${live}, the bundle says ${p8.addresses[key]}`);
  }
  const minSeedPpm = Number(await read(portal, portalAbi, "minSeedPpm"));

  const quote = getAddress(settings.quote ?? p8.addresses.defaultQuoteAsset);
  const admission = await read(p8.addresses.registry, p8.contracts.ArgusQuoteRouteRegistry.abi, "admissionFor", [quote]);
  if (admission.revoked || !admission.admissible || admission.economics.bondFdvQuote === 0n) {
    throw new Error(`${quote} is not a quote Portal #8 admits right now`);
  }

  // (3) THE OPENING BUY IS REQUIRED: a pool nobody has bought into cannot fill
  //     a sell. The floor is a ppm OF THE BOND in the quote's own units, so it
  //     needs no decimals table: 4.50 on a 45,000 USDC bond.
  const floorRaw = (admission.economics.bondFdvQuote * BigInt(minSeedPpm)) / 1_000_000n;
  const floor = floorRaw === 0n ? 1n : floorRaw;
  const seed = settings.seed ?? floor;

  const buyTaxBps = settings.buyTaxBps ?? 300;
  const sellTaxBps = settings.sellTaxBps ?? 300;
  const creator = getAddress(settings.creator);

  const [template, escrowInitCodeHash] = await Promise.all([
    read(portal, portalAbi, "hookInitCodeTemplate", [quote, buyTaxBps, sellTaxBps]),
    read(p8.addresses.partsFactory, p8.contracts.ArgusV5PartsFactory.abi, "escrowInitCodeHash", [portal]),
  ]);
  const inputs = {
    template: hexToBytes(template),
    escrowInitCodeHash,
    portal,
    partsFactory: p8.addresses.partsFactory,
    hookFactory: p8.addresses.hookFactory,
    creator,
  };
  const mined = settings.hookSalt
    ? { hookSalt: settings.hookSalt, ...predictHook({ ...inputs, template: new Uint8Array(inputs.template) }, hexToBytes(settings.hookSalt), Number(p8.hookSalt.flags)) }
    : mineHookSalt(inputs, { flags: Number(p8.hookSalt.flags), start: settings.saltStart ?? 0n });

  // (4) TWO eth_calls CATCH EVERY DERIVATION MISTAKE BEFORE ANY GAS IS SPENT.
  //     The Portal predicts the escrow and hashes the hook's init code itself.
  const [portalEscrow, hookInitCodeHash] = await Promise.all([
    read(portal, portalAbi, "predictEscrow", [creator, mined.hookSalt]),
    read(portal, portalAbi, "hookInitCodeHash", [creator, mined.hookSalt, quote, buyTaxBps, sellTaxBps]),
  ]);
  const portalHook = getContractAddress({ opcode: "CREATE2", from: p8.addresses.hookFactory, salt: mined.hookSalt, bytecodeHash: hookInitCodeHash });
  const agrees = getAddress(portalEscrow) === mined.escrow && getAddress(portalHook) === mined.hook;
  if (!agrees && !settings.hookSalt) throw new Error("the mined escrow or hook disagrees with the Portal; do not send");

  const params = {
    name: settings.name ?? "Argus v5 example",
    symbol: settings.symbol ?? "AV5X",
    totalSupply: settings.totalSupply ?? 1_000_000_000n * 10n ** 18n,
    buyTaxBps,
    sellTaxBps,
    // creator, burn, dividends, liquidity, lock: five lanes totalling 10,000.
    alloc: settings.alloc ?? [10_000, 0, 0, 0, 0],
    quoteAsset: quote,
    payoutAsset: settings.payoutAsset ?? quote,
    kothBps: 0,
    payoutAddress: settings.payoutAddress ?? creator,
    identityProvider: pad("0x00", { size: 32 }),
    identitySubject: 0n,
    bundle: seed === 0n ? [] : [{ to: settings.devBuyTo ?? creator, amountQuote: seed }],
    snipeExempt: [],
    meta: { imageURI: settings.imageURI ?? "", website: "", twitter: "", telegram: "", description: "" },
  };
  const data = encodeFunctionData({ abi: portalAbi, functionName: "launch", args: [params, mined.hookSalt] });
  const approve = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [portal, seed] });
  return { portal, quote, creator, floor, seed, minSeedPpm, mined, agrees, params, data, approve };
}

/**
 * Arc's USDC keeps allowances in mapping slot 10, like Circle's FiatToken, and
 * its balance IS the native balance, 1e12 apart. Those two facts let a
 * simulation hand a throwaway CREATOR the opening buy without any funds.
 * Simulation only: a real launch needs a real approve from a funded wallet.
 */
export function usdcFundingOverride(creator, spender, amount6) {
  const inner = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [creator, 10n]));
  const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [spender, inner]));
  return [
    { address: creator, balance: (amount6 + 1_000_000n) * 10n ** 12n },
    { address: "0x3600000000000000000000000000000000000000", stateDiff: [{ slot, value: pad(toHex(amount6), { size: 32 }) }] },
  ];
}

/** Every error a launch can come back with: the Portal's and the three contracts that run inside it. */
export function launchErrorsAbi(bundle) {
  const c = bundle.portal8.contracts;
  return [c.ArgusV5Portal, c.ArgusV5HookFactory, c.ArgusV5CreatorRegistry, c.ArgusV5IdentityEscrow, c.ArgusV5TaxHook]
    .flatMap((x) => x.abi)
    .filter((x) => x.type === "error");
}

/** `eth_call` the launch. Answers the token it would create, or the decoded refusal. */
export async function simulateLaunch(client, bundle, launch, { stateOverride, gas = 15_000_000n } = {}) {
  try {
    const result = await client.call({ account: launch.creator, to: launch.portal, data: launch.data, gas, stateOverride });
    const token = getAddress(`0x${result.data.slice(-40)}`);
    return { ok: true, token };
  } catch (error) {
    let cause = error;
    while (cause && !cause.data && cause.cause) cause = cause.cause;
    const data = typeof cause?.data === "string" ? cause.data : cause?.data?.data;
    if (typeof data === "string" && data.length >= 10) {
      try {
        const decoded = decodeErrorResult({ abi: launchErrorsAbi(bundle), data });
        return { ok: false, error: decoded.errorName, args: decoded.args };
      } catch {
        return { ok: false, error: data.slice(0, 10) };
      }
    }
    return { ok: false, error: error.shortMessage ?? error.message };
  }
}

// -------------------------------------------------------------------- main --

export async function main(env = process.env) {
  const bundle = await loadBundle(env.BUNDLE ?? "https://argus.world/argus-v4.json");
  const rpc = env.RPC ?? bundle.chain.rpc;
  // Arc refuses JSON-RPC batches on several endpoints; one call per request.
  const client = createPublicClient({ transport: http(rpc, { batch: false, retryCount: 3 }) });
  const chainId = await client.getChainId().catch(() => null);
  if (chainId === null) throw new Error(`Could not reach ${rpc}. Set RPC to an Arc mainnet endpoint (chain ${bundle.chain.chainId}) you trust.`);
  if (chainId !== bundle.chain.chainId) throw new Error(`${rpc} is chain ${chainId}, not Arc mainnet (${bundle.chain.chainId}).`);

  const creator = env.CREATOR ?? "0x000000000000000000000000000000000000A115";
  const launch = await prepareLaunch(client, bundle, {
    creator,
    quote: env.QUOTE,
    buyTaxBps: env.BUY_TAX_BPS ? Number(env.BUY_TAX_BPS) : undefined,
    sellTaxBps: env.SELL_TAX_BPS ? Number(env.SELL_TAX_BPS) : undefined,
    seed: env.SEED ? BigInt(env.SEED) : undefined,
  });

  const [symbol, decimals, allowance, balance] = await Promise.all([
    client.readContract({ address: launch.quote, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address: launch.quote, abi: erc20Abi, functionName: "decimals" }),
    client.readContract({ address: launch.quote, abi: erc20Abi, functionName: "allowance", args: [launch.creator, launch.portal] }),
    client.readContract({ address: launch.quote, abi: erc20Abi, functionName: "balanceOf", args: [launch.creator] }),
  ]);
  const funded = allowance >= launch.seed && balance >= launch.seed;
  const isUsdc = launch.quote === getAddress(bundle.portal8.addresses.defaultQuoteAsset);
  const stateOverride = !funded && isUsdc ? usdcFundingOverride(launch.creator, launch.portal, launch.seed) : undefined;
  const result = await simulateLaunch(client, bundle, launch, { stateOverride });

  console.log(`
Portal #8 launch, simulated
  portal         ${launch.portal}
  creator        ${launch.creator}   (the wallet that SENDS; the salt is mined for it)
  quote          ${symbol} ${launch.quote}
  opening buy    ${launch.seed} raw, floor ${launch.floor} raw (${Number(launch.floor) / 10 ** Number(decimals)} ${symbol}, minSeedPpm ${launch.minSeedPpm})
  taxes          ${launch.params.buyTaxBps} / ${launch.params.sellTaxBps} bps
  hookSalt       ${launch.mined.hookSalt}   (${launch.mined.tries} tries)
  hook           ${launch.mined.hook}
  escrow         ${launch.mined.escrow}
  Portal agrees  ${launch.agrees ? "yes: predictEscrow and hookInitCodeHash match" : "NO"}
  funding        ${funded ? "the creator's own balance and allowance" : stateOverride ? "a simulation-only state override (no funds needed to simulate)" : "MISSING: approve the Portal for the opening buy first"}
  result         ${result.ok ? `launch() would create ${result.token}` : `reverts ${result.error}`}

  1. approve     to ${launch.quote}
                 data ${launch.approve}
  2. launch      to ${launch.portal}, value 0, gas about 8,000,000 (set it yourself)
                 data ${launch.data.slice(0, 74)}... (${(launch.data.length - 2) / 2} bytes)
`);
  return { launch, result, funded, stateOverride: Boolean(stateOverride) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { result } = await main();
  process.exit(result.ok ? 0 : 1);
}
