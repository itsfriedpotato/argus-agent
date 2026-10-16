import { readFileSync } from "node:fs";
import { decodeFunctionData, getAddress, isAddress, keccak256, verifyTypedData } from "viem";

const { abi: portalAbi } = JSON.parse(readFileSync(new URL("./argus-v4.json", import.meta.url), "utf8"))
  .portal8.contracts.ArgusV5Portal;
const USDC = "0x3600000000000000000000000000000000000000";
const ZERO_ADDRESS = `0x${"00".repeat(20)}`;
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_UINT128 = (1n << 128n) - 1n;

// This validates a local destination, not the server behind it. The caller must
// refuse redirects and verify its fresh local chain before every write workflow.
export function assertLocalRpc(value) {
  if (typeof value !== "string" || !/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?\/?$/.test(value)) {
    throw new Error("RPC must be an explicit HTTP loopback URL without credentials, path, query or fragment");
  }
  const url = new URL(value);
  if (url.port === "0") throw new Error("RPC port must be positive");
  return url.href;
}

function address(value, field) {
  if (typeof value !== "string" || !isAddress(value) || value.toLowerCase() === ZERO_ADDRESS) {
    throw new Error(`${field} must be a nonzero valid address`);
  }
  return getAddress(value);
}

function uint(value, field, { positive = false, max = MAX_UINT256 } = {}) {
  if (!(typeof value === "bigint" || (typeof value === "number" && Number.isSafeInteger(value))
    || (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)))) {
    throw new Error(`${field} must be an exact unsigned integer`);
  }
  const parsed = BigInt(value);
  if (parsed < (positive ? 1n : 0n) || parsed > max) throw new Error(`${field} is outside its unsigned integer range`);
  return parsed.toString();
}

function calldata(data) {
  if (typeof data !== "string" || !/^0x(?:[0-9a-fA-F]{2}){4,}$/.test(data)) {
    throw new Error("data must be complete hex calldata with a function selector");
  }
  return data.toLowerCase();
}

function normalizeIntent(intent) {
  if (!Number.isSafeInteger(intent.chainId) || intent.chainId <= 0) throw new Error("chainId must be a positive safe integer");
  const normalized = {
    chainId: intent.chainId,
    portal: address(intent.portal, "portal"),
    operator: address(intent.operator, "operator"),
    controller: address(intent.controller, "controller"),
    treasury: address(intent.treasury, "treasury"),
    dataHash: intent.dataHash,
    seed: uint(intent.seed, "seed", { positive: true, max: MAX_UINT128 }),
    nonce: uint(intent.nonce, "nonce"),
    deadline: uint(intent.deadline, "deadline", { positive: true }),
  };
  if (new Set([normalized.operator, normalized.controller, normalized.treasury]).size !== 3) {
    throw new Error("operator, controller and treasury must be distinct addresses");
  }
  if (typeof normalized.dataHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(normalized.dataHash)) {
    throw new Error("dataHash must be bytes32");
  }
  normalized.dataHash = normalized.dataHash.toLowerCase();
  return Object.freeze(normalized);
}

export function createIntent({ chainId, portal, operator, controller, treasury, data, seed, nonce, deadline }) {
  return normalizeIntent({ chainId, portal, operator, controller, treasury, dataHash: keccak256(calldata(data)), seed, nonce, deadline });
}

export function typedIntent(intent) {
  const { chainId, portal, operator, controller, treasury, dataHash, seed, nonce, deadline } = normalizeIntent(intent);
  return {
    domain: { name: "Argus local ownership proof", version: "1", chainId, verifyingContract: portal },
    types: {
      LaunchIntent: [
        { name: "operator", type: "address" },
        { name: "controller", type: "address" },
        { name: "treasury", type: "address" },
        { name: "dataHash", type: "bytes32" },
        { name: "seed", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "LaunchIntent",
    message: { operator, controller, treasury, dataHash, seed: BigInt(seed), nonce: BigInt(nonce), deadline: BigInt(deadline) },
  };
}

// Local proof adapter only: Portal8 does not consume this signature or nonce.
// EOA controller verification here is not Circle authentication or EIP-1271.
// Scope usedNonces to controller/chain/portal. Atomically reserve the returned
// nonce before approvals or other writes; this read-only check does not reserve it.
export async function verifyIntent(intent, signature, { chainId, portal, operator, data, now, usedNonces }) {
  const checked = normalizeIntent(intent);
  if (checked.chainId !== chainId || checked.portal !== address(portal, "portal") || checked.operator !== address(operator, "operator")) {
    throw new Error("Intent chain, portal or operator does not match execution");
  }
  if (BigInt(checked.deadline) <= BigInt(uint(now, "now"))) throw new Error("Intent has expired");
  if (!(usedNonces instanceof Set)) throw new Error("usedNonces must be a scoped Set of decimal nonce strings");
  if (usedNonces.has(checked.nonce)) throw new Error("Intent nonce has already been used");
  const exactData = calldata(data);
  if (keccak256(exactData) !== checked.dataHash) throw new Error("Intent calldata hash does not match execution");
  const decoded = decodeFunctionData({ abi: portalAbi, data: exactData });
  if (decoded.functionName !== "launch") throw new Error("Intent must call Portal8 launch");
  const [params] = decoded.args;
  if (params.quoteAsset.toLowerCase() !== USDC || params.payoutAsset.toLowerCase() !== USDC) {
    throw new Error("Local ownership proof requires USDC quote and payout assets");
  }
  if (params.payoutAddress !== checked.controller || params.bundle.length !== 1
    || params.bundle[0].to !== checked.treasury || params.bundle[0].amountQuote !== BigInt(checked.seed)) {
    throw new Error("Launch payout must match the controller; single bundle recipient and seed must match the treasury and seed");
  }
  if (params.identityProvider !== ZERO_BYTES32 || params.identitySubject !== 0n) {
    throw new Error("Local ownership proof requires identity routing disabled");
  }
  if (!await verifyTypedData({ ...typedIntent(checked), address: checked.controller, signature })) {
    throw new Error("Intent signature does not belong to the controller");
  }
  return checked;
}
