// Generated from the Argus app source src/lib/contracts/launch-record.ts. Do not edit by hand.
import { ARC_ADDRESSES } from "./addresses.mjs";
import { launchesAbi, legacyLaunchesAbi } from "./abis.mjs";
import { poolIdFor, poolKeyFor } from "./pool.mjs";
export function launchesAbiFor(portal) {
    return portal.line === "legacy" ? legacyLaunchesAbi : launchesAbi[portal.words];
}
export function decodeLaunchRecord(portal, token, raw) {
    if (portal.line === "legacy") {
        const [creator, tickStart, tickBond, tokenIsToken0, bonded, pool, processor, tracker, locker, positionId] = raw;
        if (isZero(creator))
            return null;
        return {
            line: "legacy",
            token,
            portal: portal.address,
            creator,
            tickStart,
            tickBond,
            tokenIsToken0,
            bonded,
            pool,
            processor,
            tracker,
            locker,
            positionId,
            quoteAsset: ARC_ADDRESSES.usdc,
        };
    }
    const [creator, tickStart, tokenIsToken0, locker, hook, splitter, buyTaxBps, sellTaxBps, positionId, tickBond, quote] = raw;
    if (isZero(creator))
        return null;
    const quoteAsset = portal.words === 11 && quote ? quote : ARC_ADDRESSES.usdc;
    const poolKey = poolKeyFor(token, quoteAsset, hook);
    return {
        line: "hooked",
        token,
        portal: portal.address,
        creator,
        tickStart,
        tickBond: portal.words >= 10 && tickBond !== undefined ? tickBond : null,
        tokenIsToken0,
        locker,
        hook,
        splitter,
        buyTaxBps,
        sellTaxBps,
        positionId,
        quoteAsset,
        poolKey,
        poolId: poolIdFor(poolKey),
    };
}
function isZero(address) {
    return /^0x0{40}$/i.test(address);
}
