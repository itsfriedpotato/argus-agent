// Generated from the Argus app source src/lib/contracts/v5-launch-rules.ts. Do not edit by hand.
export const V5_BPS = 10_000;
export const V5_PPM = 1_000_000;
export const V5_MIN_TOTAL_SUPPLY = 10n ** 18n;
export const V5_MAX_TOTAL_SUPPLY = 10n ** 27n;
export const V5_MAX_INT128 = (1n << 127n) - 1n;
export const V5_MAX_BUNDLE = 1;
export const V5_MAX_SNIPE_EXEMPT = 25;
export const V5_MAX_IMAGE_URI_BYTES = 512;
export const V5_MAX_SPLIT_PARTS = 8;
export const V5_MIN_TAX_BPS = 100;
export const V5_MAX_TAX_BPS = 1_000;
export const V5_MAX_UINT128 = (1n << 128n) - 1n;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO = "0x0000000000000000000000000000000000000000";
export function isAddressLike(value) {
    return ADDRESS.test(value);
}
export function sameAddress(a, b) {
    if (!a || !b)
        return false;
    return a.toLowerCase() === b.toLowerCase();
}
function isZeroAddress(value) {
    return value.toLowerCase() === ZERO;
}
export function allocationTuple(a) {
    return [a.creatorBps, a.burnBps, a.dividendBps, a.liquidityBps, a.lockBps];
}
function refuse(error, message, field) {
    return { error, field, message };
}
export function checkSupply(totalSupply, imageUriBytes) {
    if (totalSupply < V5_MIN_TOTAL_SUPPLY) {
        return refuse("InvalidConfig", "Total supply must be at least one whole token.", "totalSupply");
    }
    if (totalSupply > V5_MAX_INT128 || totalSupply > V5_MAX_TOTAL_SUPPLY) {
        return refuse("InvalidConfig", "Total supply is above what the Portal allows.", "totalSupply");
    }
    if (imageUriBytes > V5_MAX_IMAGE_URI_BYTES) {
        return refuse("InvalidConfig", "The image link is too long to store on the token.", "image");
    }
    return null;
}
export function checkAllocation(alloc, terms) {
    const total = allocationTuple(alloc).reduce((sum, bps) => sum + bps, 0);
    if (total !== V5_BPS) {
        return refuse("InvalidConfig", "The allocation must total exactly 100%.", "split");
    }
    if (allocationTuple(alloc).some((bps) => bps < 0)) {
        return refuse("InvalidConfig", "The allocation must total exactly 100%.", "split");
    }
    if (alloc.burnBps !== 0 && isZeroAddress(terms.burnExecutor)) {
        return refuse("InvalidConfig", "This Portal cannot burn, so the burn share must be 0%.", "split");
    }
    if (alloc.liquidityBps !== 0 && isZeroAddress(terms.liquidityExecutor)) {
        return refuse("InvalidConfig", "This Portal cannot add liquidity, so that share must be 0%.", "split");
    }
    if (alloc.lockBps !== 0 && isZeroAddress(terms.lockExecutor)) {
        return refuse("InvalidConfig", "This Portal cannot lock, so the lock share must be 0%.", "split");
    }
    return null;
}
export function checkTaxes(buyTaxBps, sellTaxBps) {
    if (buyTaxBps > V5_MAX_TAX_BPS || sellTaxBps > V5_MAX_TAX_BPS) {
        return refuse("TaxTooHigh", "Buy and sell tax cannot be above 10%.", "buyTax");
    }
    if (buyTaxBps < V5_MIN_TAX_BPS || sellTaxBps < V5_MIN_TAX_BPS) {
        return refuse("TaxTooLow", "Buy and sell tax must each be at least 1%.", "buyTax");
    }
    return null;
}
export function checkPayoutAsset(payoutAsset, quoteAsset, terms) {
    if (sameAddress(payoutAsset, quoteAsset))
        return null;
    if (sameAddress(payoutAsset, terms.defaultQuoteAsset)) {
        if (isZeroAddress(terms.converter)) {
            return refuse("PayoutNotAllowed", "This Portal has no converter, so fees can only be paid in the pair's own asset.", "payoutAsset");
        }
        return null;
    }
    return refuse("PayoutNotAllowed", "Fees pay in the pair's own asset or in the default quote.", "payoutAsset");
}
export function checkKoth(kothBps, terms) {
    if (kothBps > terms.maxKothBps) {
        return refuse("KothAboveCeiling", "That milestone is above what this Portal allows.", "kothBps");
    }
    return null;
}
export function seedFloor(bondFdvQuote, minSeedPpm) {
    if (minSeedPpm === 0)
        return 0n;
    const floor = (bondFdvQuote * BigInt(minSeedPpm)) / BigInt(V5_PPM);
    return floor === 0n ? 1n : floor;
}
const CENT_QUOTES = new Set(["USDC", "USDT", "EURC", "GBPA"]);
export function formatSeedFloor(raw, decimals, symbol) {
    if (!CENT_QUOTES.has(symbol.toUpperCase()) || decimals < 2) {
        const unit = 10n ** BigInt(decimals);
        const digits = raw.toString().length;
        const drop = digits > 3 ? BigInt(digits - 3) : 0n;
        const scale = 10n ** drop;
        const rounded = ((raw + scale - 1n) / scale) * scale;
        const fraction = (rounded % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
        return fraction ? `${rounded / unit}.${fraction}` : `${rounded / unit}`;
    }
    const step = 10n ** BigInt(decimals - 2);
    const cents = (raw + step - 1n) / step;
    return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}
export function checkBundle(bundle, floor, reserved) {
    if (bundle.length > V5_MAX_BUNDLE) {
        return refuse("BundleTooLong", "The dev buy pays one wallet.", "devBuyRecipient");
    }
    const seed = bundle.reduce((sum, entry) => sum + entry.amountQuote, 0n);
    if (seed < floor) {
        return refuse("SeedBuyTooSmall", "The dev buy is below this pair's minimum.", "devBuy");
    }
    const seen = new Set();
    for (const entry of bundle) {
        if (!isAddressLike(entry.to) || isZeroAddress(entry.to) || entry.amountQuote === 0n) {
            return refuse("BundleEmptyEntry", "The dev buy needs a wallet and an amount.", "devBuyRecipient");
        }
        if (entry.amountQuote > V5_MAX_UINT128) {
            return refuse("BundleEmptyEntry", "That dev buy is too large.", "devBuy");
        }
        if (reserved.some((address) => sameAddress(address, entry.to))) {
            return refuse("BundleRecipientRefused", "That wallet is a protocol address and cannot hold the launch.", "devBuyRecipient");
        }
        const key = entry.to.toLowerCase();
        if (seen.has(key)) {
            return refuse("BundleDuplicateRecipient", "The same wallet is listed twice.", "devBuyRecipient");
        }
        seen.add(key);
    }
    return null;
}
export function checkCreatorPayout(payout, reserved) {
    if (!isAddressLike(payout)) {
        return refuse("ZeroAddress", "Enter a wallet address for the creator fees.", "payoutAddress");
    }
    if (isZeroAddress(payout)) {
        return refuse("ZeroAddress", "Enter a wallet address for the creator fees.", "payoutAddress");
    }
    if (reserved.some((address) => sameAddress(address, payout))) {
        return refuse("CreatorPayoutRefused", "That is a protocol address. Fees sent there are unrecoverable.", "payoutAddress");
    }
    return null;
}
export function checkSnipeExempt(entries, hasNonDelegationCode) {
    if (entries.length > V5_MAX_SNIPE_EXEMPT) {
        return refuse("SnipeExemptTooLong", `At most ${V5_MAX_SNIPE_EXEMPT} wallets.`, "snipeExempt");
    }
    const seen = new Set();
    for (const entry of entries) {
        if (!isAddressLike(entry) || isZeroAddress(entry)) {
            return refuse("SnipeExemptZeroEntry", "Every wallet on the list needs an address.", "snipeExempt");
        }
        const key = entry.toLowerCase();
        if (seen.has(key)) {
            return refuse("SnipeExemptDuplicate", "The same wallet is listed twice.", "snipeExempt");
        }
        seen.add(key);
        if (hasNonDelegationCode(entry)) {
            return refuse("SnipeExemptSmartWallet", "Smart contract wallets cannot get the waiver. Name the signer instead.", "snipeExempt");
        }
    }
    return null;
}
export function isDelegationCode(code) {
    if (!code)
        return false;
    const bytes = code.startsWith("0x") ? code.slice(2) : code;
    return bytes.length === 46 && bytes.toLowerCase().startsWith("ef0100");
}
export function checkIdentity(identity, identityEscrow, payout, predicted) {
    const hasProvider = Boolean(identity.provider);
    const hasSubject = Boolean(identity.subject);
    if (!hasProvider && !hasSubject)
        return null;
    if (!hasProvider || !hasSubject) {
        return refuse("IncompleteIdentity", "Pick a provider and enter its numeric id.", "identitySubject");
    }
    let subject;
    try {
        subject = BigInt(identity.subject);
    }
    catch {
        return refuse("ZeroSubject", "The id is a number, not a handle.", "identitySubject");
    }
    if (subject <= 0n) {
        return refuse("ZeroSubject", "The id is a number, not a handle.", "identitySubject");
    }
    if (!identityEscrow || isZeroAddress(identityEscrow)) {
        return refuse("IdentityUnsupported", "This Portal cannot direct fees to an account.", "identityProvider");
    }
    if (!predicted) {
        return refuse("IdentityPayoutMismatch", "That account's address could not be read. Try again in a moment.", "identitySubject");
    }
    if (!sameAddress(payout, predicted)) {
        return refuse("IdentityPayoutMismatch", "The payout address must be the one that account derives to.", "payoutAddress");
    }
    return null;
}
export function checkPayoutSplit(parts, token, escrow) {
    if (parts.length === 0)
        return null;
    if (parts.length > V5_MAX_SPLIT_PARTS) {
        return refuse("SplitTooLong", `At most ${V5_MAX_SPLIT_PARTS} wallets.`, "split");
    }
    const seen = new Set();
    let sum = 0;
    for (const part of parts) {
        if (!isAddressLike(part.recipient) || isZeroAddress(part.recipient)) {
            return refuse("SplitRecipientRefused", "Every share needs a wallet address.", "split");
        }
        if (sameAddress(part.recipient, token) || (escrow && sameAddress(part.recipient, escrow))) {
            return refuse("SplitRecipientRefused", "That is a protocol address and cannot receive a share.", "split");
        }
        if (!Number.isInteger(part.bps) || part.bps <= 0) {
            return refuse("SplitZeroShare", "A share of 0% pays nothing. Remove the wallet instead.", "split");
        }
        const key = part.recipient.toLowerCase();
        if (seen.has(key)) {
            return refuse("SplitDuplicate", "The same wallet is listed twice.", "split");
        }
        seen.add(key);
        sum += part.bps;
    }
    if (sum !== V5_BPS) {
        return refuse("SplitBpsNotFull", "The shares must total exactly 100%.", "split");
    }
    return null;
}
export function reservedAddresses(terms, mined) {
    const list = [
        terms.portal,
        terms.poolManager,
        terms.positionManager,
        terms.treasury,
        terms.lockVault,
        terms.burnExecutor,
        terms.liquidityExecutor,
        terms.lockExecutor,
        terms.converter,
    ];
    if (mined)
        list.push(mined.hook, mined.escrow);
    return list.filter((address) => isAddressLike(address) && !isZeroAddress(address));
}
export function parseExemptAdditions(raw, existing, max = V5_MAX_SNIPE_EXEMPT) {
    const accepted = [];
    const rejected = [];
    const seen = new Set(existing.map((address) => address.toLowerCase()));
    for (const input of raw.split(/[\s,;]+/).map((entry) => entry.trim()).filter(Boolean)) {
        if (!isAddressLike(input))
            rejected.push({ input, reason: "not an address" });
        else if (isZeroAddress(input))
            rejected.push({ input, reason: "the zero address" });
        else if (seen.has(input.toLowerCase()))
            rejected.push({ input, reason: "already listed" });
        else if (existing.length + accepted.length >= max)
            rejected.push({ input, reason: `the list holds ${max}` });
        else {
            accepted.push(input);
            seen.add(input.toLowerCase());
        }
    }
    return { accepted, rejected };
}
