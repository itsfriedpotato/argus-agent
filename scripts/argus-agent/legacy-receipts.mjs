import { decodeEventLog, encodeFunctionData, getAddress, parseAbi, zeroAddress } from 'viem';
import { ARC_ADDRESSES } from './generated/addresses.mjs';
import { erc20Abi } from './generated/abis.mjs';
import { readLegacyState, legacySplitterAbi, legacyProcessorAbi, legacySelfClaimAbi } from './legacy-contracts.mjs';

const transferAbi = parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const processorAbi = parseAbi(['event ParkedClaimed(address indexed to,uint256 amountNative18)']);
const NATIVE_USDC_LOGS = '0xfffffffffffffffffffffffffffffffffffffffe';
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const requireEvidence = (condition, message) => {
  if (!condition) throw Object.assign(new Error(message), { code: 'ARGUS_RECEIPT_MISMATCH', safe: true });
};
function events(receipt, address, abi, name) {
  return receipt.logs.filter(log => same(log.address, address)).flatMap(log => {
    requireEvidence(log.removed !== true, 'A claim receipt contains a removed event.');
    try {
      const event = decodeEventLog({ abi, topics: log.topics, data: log.data, strict: true });
      return event.eventName === name ? [event.args] : [];
    } catch { return []; }
  });
}

/** Verify actual delivery, not just a successful call or a fee-contract event. */
export async function verifyLegacyClaimReceipt({ receipt, expected, step, read }) {
  requireEvidence(expected.version === 'v1' && expected.operation === 'claim_fees', 'Only a saved V1 creator-fee claim can use this verifier.');
  const state = await readLegacyState(expected.token, read, { portal: expected.portal });
  requireEvidence(state && state.version === 'v1' && state.portalGeneration === expected.portalGeneration,
    'The claim does not belong to the saved V1 deployment.');
  const feeContract = state.splitter ?? state.processor;
  requireEvidence(same(feeContract, expected.feeContract) && same(feeContract, step.to)
    && same(state.creator, expected.controllerBefore) && same(state.quoteAsset, expected.quoteAsset) && state.feeModel === expected.feeModel,
  'The V1 fee contract or immutable recipient differs from the saved claim.');
  requireEvidence(expected.recipients?.length === 1 && same(expected.recipients[0].recipient, state.creator)
    && expected.recipients[0].bps === 10000, 'A V1 claim cannot redirect creator fees.');
  const processor = state.line === 'legacy';
  const recipientOnly = state.portalGeneration === 3 || state.portalGeneration === 4;
  if (recipientOnly)
    requireEvidence(same(expected.actor, state.creator) && same(step.from, state.creator), 'This V1 fee claim must be signed by its immutable recipient.');
  const data = encodeFunctionData({ abi: processor ? legacyProcessorAbi : recipientOnly ? legacySelfClaimAbi : legacySplitterAbi,
    functionName: 'claim', args: recipientOnly ? [] : [state.creator] });
  requireEvidence(step.data === data, 'The saved V1 claim call does not match this deployment and recipient.');
  const claims = processor
    ? events(receipt, feeContract, processorAbi, 'ParkedClaimed').map(event => ({ to: event.to, currency: ARC_ADDRESSES.usdc, amount: event.amountNative18 }))
    : events(receipt, feeContract, legacySplitterAbi, 'Claimed');
  requireEvidence(claims.length > 0 && claims.length <= (processor ? 1 : state.portalGeneration === 7 ? 3 : 2),
    'The receipt does not contain the expected V1 creator-fee claim events.');
  const grouped = new Map();
  for (const claim of claims) {
    requireEvidence(same(claim.to, state.creator) && typeof claim.amount === 'bigint' && claim.amount > 0n,
      'A V1 claim event has the wrong recipient or amount.');
    const quote = same(claim.currency, state.quoteAsset);
    const token = same(claim.currency, state.token);
    const converted = state.portalGeneration === 7 && same(claim.currency, ARC_ADDRESSES.usdc);
    requireEvidence(processor ? same(claim.currency, ARC_ADDRESSES.usdc) : quote || token || converted,
      'A V1 claim event reports an unexpected currency.');
    const native = processor || (state.portalGeneration <= 5 && quote);
    const emitter = native ? NATIVE_USDC_LOGS : getAddress(claim.currency);
    const raw = native && !processor ? claim.amount * 10n ** 12n : claim.amount;
    const key = emitter.toLowerCase();
    const group = grouped.get(key) ?? { emitter, asset: native ? zeroAddress : getAddress(claim.currency), delivery: native ? 'native' : 'erc20', amountRaw: 0n };
    group.amountRaw += raw;
    grouped.set(key, group);
  }
  const payouts = [];
  for (const group of grouped.values()) {
    const transfers = events(receipt, group.emitter, transferAbi, 'Transfer').filter(event => same(event.from, feeContract));
    requireEvidence(transfers.length > 0 && transfers.every(event => same(event.to, state.creator)),
      'The V1 fee transfer does not deliver exclusively to the immutable creator.');
    const received = transfers.reduce((sum, event) => sum + event.value, 0n);
    requireEvidence(received === group.amountRaw, 'The V1 claim events and delivered amounts disagree.');
    const decimals = group.delivery === 'native' ? 18 : Number(await read(group.asset, erc20Abi, 'decimals'));
    requireEvidence(Number.isInteger(decimals) && decimals >= 0 && decimals <= 255, 'Claim payout decimals could not be verified.');
    requireEvidence(!same(group.asset, ARC_ADDRESSES.usdc) || decimals === (group.delivery === 'native' ? 18 : 6), 'USDC payout units differ from the supported denomination.');
    payouts.push({ recipient: state.creator, asset: group.asset, delivery: group.delivery, amountRaw: received.toString(), decimals });
  }
  const usdcWei = payouts.filter(payout => payout.delivery === 'native' || same(payout.asset, ARC_ADDRESSES.usdc))
    .reduce((sum, payout) => sum + (payout.delivery === 'native' ? BigInt(payout.amountRaw) : BigInt(payout.amountRaw) * 10n ** 12n), 0n);
  return { actualCreatorFeesUsdcWei: usdcWei.toString(),
    ...(usdcWei % 10n ** 12n === 0n ? { actualCreatorFeesUsdcRaw: (usdcWei / 10n ** 12n).toString() } : {}), payouts,
    creatorClaims: claims.map(claim => ({ ...claim, amount: claim.amount.toString() })) };
}
