// Generated from the Argus app source src/lib/contracts/legacy-token.ts. Do not edit by hand.
export function legacyTaxFromConfig(config) {
    return { buyTaxBps: Number(config[0]), sellTaxBps: Number(config[1]) };
}
export function legacySplitFromConfig(config) {
    const [creator, burn, dividend] = config.slice(2, 5);
    if (typeof creator !== "bigint" || typeof burn !== "bigint" || typeof dividend !== "bigint")
        return null;
    if (creator + burn + dividend !== 10000n)
        return null;
    return { creatorBps: Number(creator), burnBps: Number(burn), dividendBps: Number(dividend), liquidityBps: 0 };
}
