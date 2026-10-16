import { encodeFunctionData, parseAbi, toFunctionSelector, zeroAddress } from 'viem';

// Circle's contractExecution API accepts this call with the wallet as target.
// https://developers.circle.com/wallets/batch-operations
export const CIRCLE_BATCH_ABI = parseAbi(['function executeBatch((address target,uint256 value,bytes data)[] calls) payable returns(bytes[])']);
export const CIRCLE_BATCH_SELECTOR = toFunctionSelector(CIRCLE_BATCH_ABI[0]);
const address = /^0x[0-9a-fA-F]{40}$/;
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const fail = message => { throw Object.assign(new Error(message), { code: 'ARGUS_INVALID_BATCH', safe: true }); };

/** One atomic, zero-native-value wallet call containing the exact ordered plan. */
export function buildAtomicBatch({ account, steps, label = 'Execute atomic trade' } = {}) {
  if (!address.test(account ?? '') || same(account, zeroAddress)) fail('A nonzero wallet address is required.');
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 4) fail('An atomic trade needs between one and four calls.');
  const batchCalls = steps.map(step => {
    if (!step || !address.test(step.to ?? '') || same(step.to, zeroAddress) || same(step.to, account)) fail('Every batch target must be a nonzero external contract.');
    if (step.value !== '0' && step.value !== 0n && step.value !== undefined) fail('Atomic trade calls cannot send native value.');
    if (typeof step.data !== 'string' || step.data.length > 262146 || !/^0x(?:[0-9a-fA-F]{2}){4,}$/.test(step.data)) fail('Every batch call needs bounded ABI calldata.');
    if (same(step.data.slice(0, 10), CIRCLE_BATCH_SELECTOR)) fail('Nested batch calls are unsupported.');
    if (step.label !== undefined && typeof step.label !== 'string') fail('Batch call labels must be strings.');
    return Object.freeze({ to: step.to, value: '0', data: step.data, ...(step.label === undefined ? {} : { label: step.label }) });
  });
  const data = encodeFunctionData({ abi: CIRCLE_BATCH_ABI, functionName: 'executeBatch',
    args: [batchCalls.map(call => ({ target: call.to, value: 0n, data: call.data }))] });
  if (data.length > 262146) fail('The encoded batch exceeds the supported calldata size.');
  return Object.freeze({ to: account, value: '0', data, abi: CIRCLE_BATCH_ABI, label, batchCalls: Object.freeze(batchCalls) });
}
