// An in-memory Arc read surface for Portals 1-7 launches. Values are keyed by
// contract and function, so a test states exactly the chain it depends on.
import { getAddress, zeroAddress } from 'viem';
import { PORTALS } from '../../scripts/argus-agent/generated/addresses.mjs';
import { PORTAL8, USDC } from '../../scripts/argus-agent/lines.mjs';

const at = n => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
export const L = Object.freeze({ TOKEN: at(0xa1), CREATOR: at(0xa2), HOOK: at(0xa3), SPLITTER: at(0xa4), LOCKER: at(0xa5),
  POOL: at(0xa6), PROCESSOR: at(0xa7), HUMAN: at(0xa8), CIRCLE: at(0xa9), OTHER: at(0xaa), USDC, PORTAL8 });
export const portalOf = generation => PORTALS.find(portal => portal.generation === generation);

/** One launch on the Portal of `generation`; every other Portal answers "not ours". */
export function lineChain({ generation = 7, quote = USDC, pool = L.POOL, values = {}, block = { number: 900n, timestamp: 1_000n, hash: `0x${'9'.repeat(64)}` } } = {}) {
  const portal = portalOf(generation);
  const legacy = portal.line === 'legacy';
  const record = legacy
    ? [L.CREATOR, -403_600, -372_200, BigInt(L.TOKEN) < BigInt(USDC), true, pool, L.PROCESSOR, zeroAddress, L.LOCKER, 7n]
    : [L.CREATOR, 405_400, BigInt(L.TOKEN) < BigInt(quote), L.LOCKER, L.HOOK, L.SPLITTER, 100, 300, 9n, 376_400, quote].slice(0, portal.words);
  const table = {
    [L.HOOK]: { quoteAsset: quote, token: L.TOKEN, splitter: L.SPLITTER, buyTaxBps: 100, sellTaxBps: 300, currentSnipeTaxBps: 0n },
    [L.SPLITTER]: { creator: L.CREATOR, creatorBps: 7300, rangeBound: true, claimableQuote6: 0n, claimableUsdc6: 0n, converts: false },
    [L.TOKEN]: { name: 'Older', symbol: 'OLD', logo: 'ipfs://older', decimals: 18, balanceOf: 10n ** 21n, allowance: 0n,
      config: [100n, 100n, 10_000n, 0n, 0n, L.CREATOR, 0n, 0n], currentTaxes: [100, 100], graduated: true, mainPool: pool, taxProcessor: L.PROCESSOR },
    [L.PROCESSOR]: { creatorWallet: L.CREATOR, claimable: 0n, creatorBucket: 0n },
    [L.LOCKER]: { claimableNative18: 0n },
    [USDC]: { balanceOf: 50_000_000n, allowance: 0n, decimals: 6, symbol: 'USDC', name: 'USDC' },
  };
  for (const [contract, entries] of Object.entries(values)) table[getAddress(contract)] = { ...table[getAddress(contract)], ...entries };
  const calls = [];
  const client = {
    getChainId: async () => 5042,
    getBlock: async ({ blockNumber } = {}) => ({ ...block, number: blockNumber ?? block.number }),
    getCode: async () => '0x6000',
    getLogs: async () => [],
    readContract: async request => {
      calls.push(request);
      const { address, functionName, args = [] } = request;
      if (functionName === 'launches') {
        if (getAddress(address) === PORTAL8) return [zeroAddress, zeroAddress, zeroAddress, 0n, 0, 0, false];
        return getAddress(address) === getAddress(portal.address) && getAddress(args[0]) === L.TOKEN ? record : [zeroAddress];
      }
      const entry = table[getAddress(address)]?.[functionName];
      if (entry === undefined) throw new Error(`Unexpected read ${address}.${functionName}`);
      if (entry instanceof Error) throw entry;
      return typeof entry === 'function' ? entry(args, request) : entry;
    },
  };
  return { client, calls, portal, record, table };
}
