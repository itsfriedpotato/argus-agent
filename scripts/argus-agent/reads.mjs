import { readFileSync } from 'node:fs';
import { formatUnits, getAddress, zeroAddress } from 'viem';
import { validateOperation } from './catalog.mjs';
import { createContractAdapter } from './contracts.mjs';
import { erc20Abi } from './generated/abis.mjs';
import { timeLockAbi } from './generated/time-lock.mjs';
import { CURRENT_TIME_LOCK } from './locks.mjs';

const bundle = JSON.parse(readFileSync(new URL('./vendor/argus-v4.json', import.meta.url), 'utf8'));
const usdc = getAddress(bundle.portal8.addresses.defaultQuoteAsset);
const escrowAbi = bundle.portal8.contracts.ArgusV5PayoutEscrow.abi;
const names = new Set(['argus_get_token_details', 'argus_get_claim_details', 'argus_get_wallet_balances',
  'argus_get_lock', 'argus_list_locks', 'argus_search_projects']);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const plain = value => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item));
const fail = (code, message) => { throw Object.assign(new Error(message), { code, safe: true }); };
const amount = (raw, decimals) => ({ raw: raw.toString(), decimals, formatted: formatUnits(BigInt(raw), decimals) });

/** Public reads only. The store dependency is used exclusively to read saved references. */
export function createReadOperations({ client, store, roles = {} }) {
  async function snapshot(blockNumber) {
    if (await client.getChainId() !== 5042) fail('ARGUS_READ_CHAIN_MISMATCH', 'Arc mainnet chain 5042 is required.');
    const block = await client.getBlock(blockNumber === undefined ? { blockTag: 'latest' } : { blockNumber: BigInt(blockNumber) });
    if (typeof block.number !== 'bigint' || typeof block.timestamp !== 'bigint' || !/^0x[0-9a-fA-F]{64}$/.test(block.hash ?? ''))
      fail('ARGUS_READ_SNAPSHOT_INVALID', 'A canonical mined block is required for these reads.');
    if (blockNumber !== undefined && block.number !== BigInt(blockNumber)) fail('ARGUS_READ_SNAPSHOT_INVALID', 'The RPC returned a different block than requested.');
    const readContract = request => client.readContract({ ...request, blockNumber: block.number });
    // The shared adapter's snapshots must use this exact block too.
    const contracts = createContractAdapter({ getChainId: async () => 5042, getBlock: async () => block,
      readContract, getLogs: request => client.getLogs(request),
      call: request => client.call({ ...request, blockNumber: block.number }), getCode: request => client.getCode({ ...request, blockNumber: block.number }) });
    return { block, contracts, readContract, async finish(value, scope) {
      const final = await client.getBlock({ blockNumber: block.number });
      if (!same(final.hash, block.hash)) fail('ARGUS_READ_SNAPSHOT_CHANGED', 'The observed block changed during the read. Retry the read.');
      return plain({ ...value, chainId: 5042, source: 'arc-rpc', observedBlockNumber: block.number,
        observedBlockHash: block.hash, observedTimestamp: block.timestamp,
        coverage: { indexedDiscovery: false, historicalAnalytics: false, scope } });
    } };
  }

  async function feeAssets(project, readContract) {
    // Portals 1-7 have no escrow: the launch's own quote is the fee asset. A Portal 7 splitter that
    // converts pays the converted share in USDC; the legacy line keeps native 18dp USDC.
    const [quote, payout] = project.line && project.line !== 'v5' ? [project.quoteAsset, project.converts ? usdc : project.quoteAsset]
      : await Promise.all(['quoteAsset', 'payoutAsset'].map(functionName =>
        readContract({ address: project.escrow, abi: escrowAbi, functionName })));
    const quoteAsset = getAddress(quote), payoutAsset = getAddress(payout);
    if (same(quoteAsset, zeroAddress) || same(payoutAsset, zeroAddress)) fail('ARGUS_TOKEN_UNITS_INVALID', 'The creator-fee assets could not be verified.');
    const [rawDecimals, symbol] = await Promise.all(['decimals', 'symbol'].map(functionName =>
      readContract({ address: quoteAsset, abi: erc20Abi, functionName })));
    const decimals = Number(rawDecimals);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255 || typeof symbol !== 'string')
      fail('ARGUS_TOKEN_UNITS_INVALID', 'The creator-fee quote asset units could not be verified.');
    if (project.owedCreatorUnit === 'native-usdc-18dp') return { quoteAsset, payoutAsset, decimals: 18, quoteDecimals: decimals, symbol, native: true };
    return { quoteAsset, payoutAsset, decimals, symbol };
  }
  const older = project => Boolean(project.line) && project.line !== 'v5';

  /** A Portals 1-7 creator lane: one immutable payee, read from the launch's own contracts. */
  function lineClaim(project, owed, fees, preview) {
    const legacy = project.line === 'legacy';
    const pushes = project.line === 'hooked' && project.generation < 5;
    const creatorOnly = legacy ? BigInt(project.lockerParkedRaw ?? 0) : pushes ? owed : 0n;
    const available = pushes ? 0n : owed;
    return { token: project.token, line: project.line, generation: project.generation, portal: project.portal,
      payer: legacy ? project.processor : project.splitter, controller: project.controller,
      quoteAsset: fees.quoteAsset, payoutAsset: fees.payoutAsset, currency: fees.symbol,
      claimable: amount(available, fees.decimals), canClaim: available > 0n,
      amountKind: legacy ? 'parked-native-usdc-18dp' : 'credited-quote-asset',
      creatorOnly: creatorOnly > 0n ? { amount: amount(creatorOnly, fees.decimals),
        contract: legacy ? project.locker : project.splitter, call: 'claim()',
        note: 'Only the creator wallet can send this call. This agent never signs as the creator.' } : null,
      ...(project.converts ? { conversionQueued: true } : {}),
      // Simulated at this block: what one prepared claim would deliver now, splitting first where that adds to it.
      deliverableNow: preview.supported ? { ...amount(BigInt(preview.deliverableWei), 18), unit: 'native-usdc-18dp', flow: preview.flow } : null,
      executionSupported: preview.supported,
      ...(preview.supported ? {} : { refusal: { code: preview.code, message: preview.message } }),
      reason: preview.supported ? 'fees_available' : available > 0n ? 'fees_available' : 'nothing_to_claim',
      recipients: [{ recipient: project.controller, bps: 10000 }],
      permission: legacy ? 'The processor pushes the creator share on dispatch; a parked share is delivered by permissionless claim(creator).'
        : pushes ? 'This splitter pushes the creator share on distribute(). A share it could not push stays parked for the creator alone.'
          : 'Permissionless: claim(creator) on the splitter always pays the creator. A read does not reserve fees or prepare a transaction.' };
  }

  function lockRecord(id, value, block) {
    if (!value || same(value.token, zeroAddress) || same(value.owner, zeroAddress) || typeof value.amount !== 'bigint' || value.amount <= 0n)
      fail('ARGUS_LOCK_NOT_FOUND', 'No recorded lock exists for this ID in the supported deployment.');
    const withdrawn = value.withdrawn;
    if (typeof withdrawn !== 'boolean') fail('ARGUS_LOCK_INVALID', 'The lock withdrawal state could not be verified.');
    const eligible = !withdrawn && BigInt(value.unlockAt) <= block.timestamp;
    return { chainId: 5042, deployment: CURRENT_TIME_LOCK, lockId: id.toString(), token: getAddress(value.token), owner: getAddress(value.owner),
      amountRaw: value.amount.toString(), amountUnit: 'token-base-units', lockedAt: value.lockedAt.toString(),
      unlockAt: value.unlockAt.toString(), withdrawn, withdrawable: eligible,
      withdrawalReason: withdrawn ? 'already_withdrawn' : eligible ? 'unlocked' : 'still_locked' };
  }

  async function execute(name, input = {}) {
    if (!names.has(name)) fail('ARGUS_UNKNOWN_OPERATION', 'Unknown Argus read operation.');
    const args = validateOperation(name, input);
    if (name === 'argus_search_projects') {
      const query = args.query.toLowerCase();
      const matches = store.listProjects().filter(project => [project.token, project.name, project.symbol,
        project.brand?.name, project.brand?.symbol, project.metadata?.name, project.metadata?.symbol]
        .some(value => typeof value === 'string' && value.toLowerCase().includes(query)));
      const projects = matches.slice(args.offset, args.offset + args.limit);
      const nextOffset = args.offset + projects.length < matches.length ? args.offset + projects.length : null;
      return { projects, total: matches.length, offset: args.offset, limit: args.limit, nextOffset,
        source: 'local-project-references', coverage: { indexedDiscovery: false, currentOnchainState: false,
          scope: 'Saved projects only. Read token details to refresh state; this does not discover other tokens.' } };
    }
    const view = await snapshot(args.blockNumber);
    const { block, contracts, readContract } = view;
    if (name === 'argus_get_token_details') {
      const saved = store.listProjects().find(project => same(project.token, args.token));
      const fromBlock = args.launchBlock ?? saved?.launchBlock;
      const project = await contracts.readProject(args.token, { roles, ...(fromBlock === undefined ? {} : { fromBlock }) });
      const decimals = Number(await readContract({ address: getAddress(args.token), abi: erc20Abi, functionName: 'decimals' }));
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) fail('ARGUS_TOKEN_UNITS_INVALID', 'Token decimals could not be verified.');
      const fees = await feeAssets(project, readContract);
      return view.finish({ project, units: { tokenDecimals: decimals, usdcDecimals: 6, roleBalanceUsdcAsset: usdc,
        creatorFees: fees, owedCreatorUnit: project.owedCreatorUnit ?? 'quote-asset-base-units' } },
        'One Argus token (Portals 1-8) and configured role balances. Metadata is read only from a supplied or saved exact launch block.');
    }
    if (name === 'argus_get_claim_details') {
      const project = await contracts.readProject(args.token);
      const owed = BigInt(project.owedCreatorRaw);
      const fees = await feeAssets(project, readContract);
      if (older(project)) return view.finish({ claim: lineClaim(project, owed, fees, await contracts.previewClaim(args.token)) },
        'Creator fees already credited or parked for this launch\'s own creator. Fees not yet split, holder rewards and claim history are not inferred.');
      return view.finish({ claim: { token: project.token, escrow: project.escrow, controller: project.controller,
        quoteAsset: fees.quoteAsset, payoutAsset: fees.payoutAsset, currency: fees.symbol, claimable: amount(owed, fees.decimals), canClaim: owed > 0n,
        amountKind: 'owed-quote-asset-before-any-payout-conversion',
        executionSupported: same(fees.quoteAsset, usdc) && same(fees.payoutAsset, usdc),
        reason: owed > 0n ? 'fees_available' : 'nothing_to_claim',
        recipients: project.split.length ? project.split : [{ recipient: project.controller, bps: 10000 }],
        permission: 'Permissionless delivery to registered recipients; a read does not reserve fees or prepare a transaction.' } },
      'Current creator fees denominated in the quote asset only. No payout-conversion output, claim history, holder rewards or sponsorship eligibility is inferred.');
    }
    if (name === 'argus_get_wallet_balances') {
      const portfolio = await contracts.readPortfolio(args);
      return view.finish({ portfolio: { ...portfolio, usdc: amount(portfolio.usdcRaw, 6),
        holdings: portfolio.holdings.map(holding => ({ ...holding, balance: amount(holding.balanceRaw, holding.decimals) })) } },
      'USDC and explicitly supplied Argus tokens (Portals 1-8) only; no complete wallet discovery, prices or PnL.');
    }
    const code = await client.getCode({ address: CURRENT_TIME_LOCK, blockNumber: block.number });
    if (!code || code === '0x') fail('ARGUS_LOCK_DEPLOYMENT_MISSING', 'The supported time-lock deployment has no contract code at the observed block.');
    if (name === 'argus_get_lock') {
      const value = await readContract({ address: CURRENT_TIME_LOCK, abi: timeLockAbi, functionName: 'getLock', args: [BigInt(args.lockId)] });
      return view.finish({ lock: lockRecord(args.lockId, value, block) }, 'One timed lock in the current supported deployment; no inventory recovery.');
    }
    const result = await readContract({ address: CURRENT_TIME_LOCK, abi: timeLockAbi, functionName: 'locksOf',
      args: [getAddress(args.owner), BigInt(args.offset), BigInt(args.limit)] });
    const [ids, records, total] = result;
    if (!Array.isArray(ids) || !Array.isArray(records) || ids.length !== records.length || ids.length > args.limit || typeof total !== 'bigint'
      || total < 0n || new Set(ids.map(String)).size !== ids.length || (ids.length > 0 && BigInt(args.offset) + BigInt(ids.length) > total))
      fail('ARGUS_LOCK_PAGE_INVALID', 'The lock page does not match its requested bounds.');
    const remaining = total > BigInt(args.offset) ? total - BigInt(args.offset) : 0n;
    const expectedLength = remaining < BigInt(args.limit) ? remaining : BigInt(args.limit);
    if (BigInt(ids.length) !== expectedLength) fail('ARGUS_LOCK_PAGE_INVALID', 'The lock page omits records within its requested bounds.');
    const locks = records.map((value, index) => lockRecord(ids[index], value, block));
    if (locks.some(lock => !same(lock.owner, args.owner))) fail('ARGUS_LOCK_PAGE_INVALID', 'The lock page contains a record for a different owner.');
    const end = BigInt(args.offset) + BigInt(locks.length);
    return view.finish({ deployment: CURRENT_TIME_LOCK, owner: getAddress(args.owner), locks, total: total.toString(),
      offset: args.offset, limit: args.limit, nextOffset: locks.length > 0 && end < total ? end.toString() : null },
    'One owner page in the current time-lock deployment. Legacy deployments, permanent locks and lock history are not searched.');
  }
  return Object.freeze({ handles: name => names.has(name), execute });
}
