// Generated from the Argus app source src/lib/contracts/addresses.ts. Do not edit by hand.
export const PORTALS = [
    { address: "0xB021Be536808f551b31789422Fd28a6c9c6e97Da", line: "hooked", words: 11, deployBlock: 20395275n, current: true, generation: 7 },
    { address: "0xA5628A11c412596E1f63b75a2C0284F843C549d6", line: "hooked", words: 11, deployBlock: 20240260n, current: true, generation: 6 },
    { address: "0x07a688a001f416cC433c68Ff56Aa26bC5131Cc6E", line: "hooked", words: 10, deployBlock: 20081606n, current: false, generation: 5 },
    { address: "0xa36c443A797771Df82533B8B4A86F0AFfd970862", line: "hooked", words: 10, deployBlock: 19690658n, current: false, generation: 4 },
    { address: "0x7A17Ab0106C46C0be30623F3EB7F299CC0058338", line: "hooked", words: 9, deployBlock: 19674154n, current: false, generation: 3 },
    { address: "0xBed9880A0ba12722ba4b8791c0B6F8c74338246C", line: "legacy", words: 10, deployBlock: 19056397n, current: false, generation: 2 },
    { address: "0x0F1C7Cb26D6cD36BD4189E41947658b39437587A", line: "legacy", words: 10, deployBlock: 18817867n, current: false, generation: 1 },
];
export const FIRST_PORTAL_BLOCK = 18817867n;
export const LAUNCH_PORTAL = process.env.ARGUS_LAUNCH_PORTAL ||
    "0xB021Be536808f551b31789422Fd28a6c9c6e97Da";
export const V5_PORTAL = readConfiguredAddress(process.env.ARGUS_V5_PORTAL);
function readConfiguredAddress(raw) {
    const value = (raw ?? "").trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(value))
        return null;
    if (/^0x0{40}$/.test(value))
        return null;
    return value;
}
const V5_PORTAL_DEPLOY_BLOCKS = {
    "0xeed7559b8a6abf64427dc41cb5cc6400109c5d93": 22251758n,
};
export function v5PortalDeployBlock(portal) {
    return V5_PORTAL_DEPLOY_BLOCKS[portal.toLowerCase()] ?? null;
}
export function isPortal8Portal(portal) {
    if (!portal)
        return false;
    return v5PortalDeployBlock(portal) !== null || (V5_PORTAL !== null && portal.toLowerCase() === V5_PORTAL.toLowerCase());
}
export function isPortal8Enabled() {
    return V5_PORTAL !== null;
}
export const PORTAL7_LAUNCH_ALLOWED = process.env.ALLOW_PORTAL7_LAUNCH === "1";
export function launchPath() {
    if (isPortal8Enabled())
        return "portal8";
    return PORTAL7_LAUNCH_ALLOWED ? "legacy" : "unavailable";
}
export const V5_USDC_PAYOUT_ENABLED = (process.env.ARGUS_V5_USDC_PAYOUT ?? "").trim().toLowerCase() === "true";
export const ARC_ADDRESSES = {
    poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
    stateView: "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b",
    positionManager: "0x6049c9a0e26405C0985f9E3685C87d0aE917f82B",
    universalRouter: "0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1",
    swapRouter02: "0x53BF6B0684Ec7eF91e1387Da3D1a1769bC5A6F77",
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    kyberRouter: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
    multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
    usdc: "0x3600000000000000000000000000000000000000",
    treasury: "0x934DEA9Ab179De155db10519aA89a8C418C50705",
    admin: "0xf5A088fd51f93f798AD3f11e13B737DeD990eeEB",
    launchConfig: "0x8Bf56C35faEA89D81E8eEe45c2FfB3994148A840",
    launchConfig7: "0x87FE2242b83680F3912829014A5915c9B0A51dD3",
    argusToken: "0xeCe5cA8bf9220718E5727754026757512212cb3c",
    arcashToken: "0x0BFFa97f774824e9dA843699aEDd2835cb1b8022",
    eurcToken: "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1",
    cirbtcToken: "0x171A4217b86A807A64eB94757Db6849fb4bDbAA0",
    wethToken: "0x128cC466B61f542da60c70e3aA11c10e19B84EDB",
    xaumToken: "0x178b01f61CBeA1D2a5581Fe1621Be607835EC349",
    gbpaToken: "0xbBe6aAB0Ed76e90AeA0d1cd978EC231c8AdCDF8b",
    burn: "0x000000000000000000000000000000000000dEaD",
};
export function isArgusLaunchQuote(address) {
    const key = address.toLowerCase();
    return LAUNCH_QUOTE_CANDIDATES.some((quote) => quote.isArgusLaunch === true && quote.address.toLowerCase() === key);
}
export const LAUNCH_QUOTE_CANDIDATES = [
    { address: ARC_ADDRESSES.eurcToken, symbol: "EURC", decimals: 6 },
    {
        address: ARC_ADDRESSES.gbpaToken,
        symbol: "GBPA",
        decimals: 6,
        admittedOnly: true,
        inKindOnly: true,
        after: ARC_ADDRESSES.eurcToken,
    },
    { address: ARC_ADDRESSES.cirbtcToken, symbol: "cirBTC", decimals: 8 },
    { address: ARC_ADDRESSES.wethToken, symbol: "WETH", decimals: 18 },
    { address: ARC_ADDRESSES.xaumToken, symbol: "XAUM", decimals: 18 },
    { address: ARC_ADDRESSES.argusToken, symbol: "ARGUS", decimals: 18, isArgusLaunch: true },
    { address: ARC_ADDRESSES.arcashToken, symbol: "ARCASH", decimals: 18, isArgusLaunch: true },
];
export const LISTED_QUOTE_CANDIDATES = LAUNCH_QUOTE_CANDIDATES.filter((quote) => quote.admittedOnly !== true);
export function placeAfterAnchors(items, addressOf) {
    const anchorOf = new Map(LAUNCH_QUOTE_CANDIDATES.filter((quote) => quote.after).map((quote) => [quote.address.toLowerCase(), quote.after.toLowerCase()]));
    const present = new Set(items.map((item) => addressOf(item).toLowerCase()));
    const follows = (item) => {
        const anchor = anchorOf.get(addressOf(item).toLowerCase());
        return anchor !== undefined && present.has(anchor) ? anchor : null;
    };
    const out = [];
    for (const item of items) {
        if (follows(item) !== null)
            continue;
        out.push(item);
        const key = addressOf(item).toLowerCase();
        for (const tail of items)
            if (follows(tail) === key)
                out.push(tail);
    }
    return out;
}
export function isInKindOnlyQuote(address) {
    const key = address.toLowerCase();
    return LAUNCH_QUOTE_CANDIDATES.some((quote) => quote.inKindOnly === true && quote.address.toLowerCase() === key);
}
export const ARGUS_CONSTANTS = {
    poolFee: 10_000,
    tickSpacing: 200,
    tokenDecimals: 18,
    quoteDecimals: 6,
    totalSupply: 1000000000n * 10n ** 18n,
    startFdvUsdc6: 2500n * 10n ** 6n,
    bondFdvUsdc6: 45000n * 10n ** 6n,
    maxTaxBps: 1_000,
    treasuryBps: 1_000,
    hookFlags: 0x2044n,
    hookFlagMask: 0x3fffn,
    poolFeePercent: 1,
};
export const V4_SWAP_TOPIC = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
export const HOOKED_TOKEN_CREATED_TOPIC = "0x1d8917231579f8ce39407f0d616f36f357b07329b0ce5164d0754ac15145ce0a";
export const LEGACY_TOKEN_CREATED_TOPIC = "0x875522b092d9e19a1de359e4bd218090d582fa521c9733889acf1a5ff1941255";
