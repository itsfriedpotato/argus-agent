// Generated from the Argus app source src/lib/contracts/time-lock.ts. Do not edit by hand.
import { getAddress, parseAbi } from "viem";
export const TIME_LOCK = readTimeLock(process.env.ARGUS_TIMELOCK);
export const TIME_LOCK_LEGACY = readLegacy(process.env.ARGUS_TIMELOCK_LEGACY, TIME_LOCK);
export const TIME_LOCKS = TIME_LOCK ? [TIME_LOCK, ...TIME_LOCK_LEGACY] : [...TIME_LOCK_LEGACY];
function readTimeLock(raw) {
    const value = (raw ?? "").trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/.test(value))
        return null;
    return getAddress(value.toLowerCase());
}
function readLegacy(raw, current) {
    const out = [];
    for (const part of (raw ?? "").split(/[\s,]+/)) {
        const address = readTimeLock(part);
        if (!address || address === current || out.includes(address))
            continue;
        out.push(address);
    }
    return out;
}
export function isTimeLockEnabled() {
    return TIME_LOCK !== null;
}
export function hasTimeLocks() {
    return TIME_LOCKS.length > 0;
}
export function knownTimeLock(address) {
    const want = address.toLowerCase();
    return TIME_LOCKS.find((lock) => lock.toLowerCase() === want) ?? null;
}
export function isLegacyTimeLock(address) {
    const want = address.toLowerCase();
    return TIME_LOCK_LEGACY.some((lock) => lock.toLowerCase() === want);
}
export function timeLockKey(lock, id) {
    return `${lock.toLowerCase()}:${id.toString()}`;
}
export const timeLockAbi = parseAbi([
    "struct Lock { address token; uint64 unlockAt; bool withdrawn; address owner; uint64 lockedAt; uint256 amount; }",
    "function lock(address token, uint256 amount, uint256 unlockAt, address beneficiary) returns (uint256 id)",
    "function withdraw(uint256 id)",
    "function extend(uint256 id, uint256 newUnlockAt)",
    "function transferLock(uint256 id, address newOwner)",
    "function acceptLock(uint256 id)",
    "function getLock(uint256 id) view returns (Lock)",
    "function locksOf(address owner, uint256 offset, uint256 limit) view returns (uint256[] ids, Lock[] records, uint256 total)",
    "function lockCountOf(address owner) view returns (uint256)",
    "function lockedTotal(address token) view returns (uint256)",
    "function pendingOwnerOf(uint256 id) view returns (address)",
    "function lockCount() view returns (uint256)",
    "function MAX_LOCK_DURATION() view returns (uint256)",
    "function sweeper() view returns (address)",
    "function sweepable(address token) view returns (uint256)",
    "function sweep(address token, address to, uint256 amount)",
    "event Locked(uint256 indexed id, address indexed token, address indexed owner, address depositor, uint256 amount, uint64 unlockAt)",
    "event Extended(uint256 indexed id, uint64 previousUnlockAt, uint64 newUnlockAt)",
    "event TransferStarted(uint256 indexed id, address indexed from, address indexed to)",
    "event Transferred(uint256 indexed id, address indexed from, address indexed to)",
    "event Withdrawn(uint256 indexed id, address indexed token, address indexed owner, uint256 amount)",
    "event SurplusSwept(address indexed token, address indexed to, uint256 amount, uint256 lockedTotal)",
    "error ZeroAddress()",
    "error ZeroAmount()",
    "error NothingReceived()",
    "error UnlockNotInFuture(uint256 unlockAt, uint256 nowTs)",
    "error UnlockTooFar(uint256 unlockAt, uint256 latest)",
    "error NoSuchLock(uint256 id)",
    "error NotLockOwner(uint256 id, address caller)",
    "error NotPendingOwner(uint256 id, address caller)",
    "error StillLocked(uint256 id, uint256 unlockAt)",
    "error AlreadyWithdrawn(uint256 id)",
    "error NotLater(uint256 current, uint256 requested)",
    "error NotSweeper(address caller)",
    "error ExceedsSweepable(uint256 requested, uint256 available)",
    "error SweepCrossedTheLocks(uint256 balanceAfter, uint256 lockedTotal)",
]);
const DAY = 86_400;
export const MAX_LOCK_SECONDS = 100 * 365 * DAY;
export const UNLOCK_PICKS = [
    { label: "30d", seconds: 30 * DAY },
    { label: "90d", seconds: 90 * DAY },
    { label: "180d", seconds: 180 * DAY },
    { label: "1y", seconds: 365 * DAY },
];
export function unlockError(unlockAt, nowSeconds) {
    if (unlockAt === null || !Number.isFinite(unlockAt))
        return "Pick an unlock date";
    if (unlockAt <= nowSeconds)
        return "Pick a date in the future";
    if (unlockAt > nowSeconds + MAX_LOCK_SECONDS)
        return "At most 100 years";
    return null;
}
export function unlockAtFromDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match)
        return null;
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (date.getFullYear() !== Number(match[1]) || date.getMonth() !== Number(match[2]) - 1 || date.getDate() !== Number(match[3])) {
        return null;
    }
    return Math.floor(date.getTime() / 1000);
}
export function canWithdraw(lock, nowSeconds) {
    return !lock.withdrawn && nowSeconds >= lock.unlockAt;
}
const ZERO = /^0x0{40}$/i;
export function transferState(owner, pendingOwner, viewer) {
    if (!viewer || !pendingOwner || ZERO.test(pendingOwner))
        return "none";
    const who = viewer.toLowerCase();
    if (pendingOwner.toLowerCase() === who)
        return "incoming";
    if (owner.toLowerCase() === who)
        return "outgoing";
    return "none";
}
