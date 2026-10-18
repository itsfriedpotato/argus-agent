import { z } from 'zod';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).refine(value => !/^0x0{40}$/i.test(value));
const key = z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/);
const amount = z.string().max(80).regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/);
const url = z.string().max(512).refine(value => {
  try { const parsed = new URL(value); return ['https:', 'ipfs:'].includes(parsed.protocol) && Boolean(parsed.hostname) && !parsed.username && !parsed.password; } catch { return false; }
});
const link = z.union([url, z.literal('')]).default('');
const action = z.strictObject({ actionId: z.string().uuid() });
const uintString = z.string().max(78).refine(value => /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < 2n ** 256n);
export const operations = {
  argus_get_token_details: {
    description: 'Read a supported V1 (Portals 1–7) or V2 (Portal 8) token by address without importing it. Returns version, current fee roles, available branding, known role balances and exact units at one canonical block. Launch metadata needs a supplied or saved exact launch block; no historical scan or indexer.',
    readOnly: true,
    schema: z.strictObject({ token: address, launchBlock: uintString.optional() }),
  },
  argus_get_claim_details: {
    description: 'Read creator-fee amounts, exact asset units and recipients for a supported V1 or V2 token without importing or claiming. V1 reports parked processor payments or credited splitter fees, separating quote, token and converted-USDC balances where applicable. Check canClaim and executionSupported. Does not estimate uncredited fees or payout conversion.',
    readOnly: true,
    schema: z.strictObject({ token: address }),
  },
  argus_get_wallet_balances: {
    description: 'Read USDC and up to 20 explicitly supplied supported V1 or V2 token balances for a wallet at one canonical block. Does not discover every wallet asset, prices or historical PnL. An empty token list reads USDC only.',
    readOnly: true,
    schema: z.strictObject({ account: address, tokens: z.array(address).max(20) }),
  },
  argus_get_lock: {
    description: 'Read one timed lock from the currently supported deployment, including withdrawn or still-locked records. Returns deployment plus lock ID, owner, exact raw amount and current withdrawal eligibility. Does not recover inventory or submit transactions.',
    readOnly: true,
    schema: z.strictObject({ lockId: uintString, blockNumber: uintString.optional() }),
  },
  argus_list_locks: {
    description: 'Read one bounded page of a wallet owner\'s timed locks from the currently supported deployment using its onchain getter. Reuse the returned observedBlockNumber as blockNumber for consistent later pages. Includes deployment and chain with each ID. No event scan, inventory recovery, legacy-deployment discovery or transaction.',
    readOnly: true,
    schema: z.strictObject({ owner: address, offset: uintString.default('0'), limit: z.number().int().min(1).max(50).default(20), blockNumber: uintString.optional() }),
  },
  argus_search_projects: {
    description: 'Search saved project references in this workspace by name, symbol or token address. Returns a bounded page of local records. This is not global token discovery; saved roles and branding can be stale. No RPC or indexer request.',
    readOnly: true,
    schema: z.strictObject({ query: z.string().trim().min(1).max(128), offset: z.number().int().min(0).max(1_000_000).default(0), limit: z.number().int().min(1).max(50).default(20) }),
  },
  argus_import_project: {
    description: 'Recover a supported V1 or V2 project from its confirmed Arc mainnet launch receipt. Verifies canonical portal events and current fee roles, then saves a public project reference. Preserves existing recipients and authority; grants no signing authority or inventory. No history scan. A token alone requires its launch transaction hash.',
    readOnly: false,
    schema: z.strictObject({ launchTxHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(), token: address.optional() }).refine(value => value.launchTxHash || value.token),
  },
  argus_recover_position: {
    description: 'Recover the configured Circle wallet token balance and optionally a known timed-lock ID at a canonical block. Requires an imported project and no unfinished local actions. Resets no USDC budget, imports no credentials and sends no transaction. Human-owned locks require their owner in the Argus app.',
    readOnly: false,
    schema: z.strictObject({ token: address, lockId: z.string().regex(/^(0|[1-9][0-9]{0,77})$/).optional() }),
  },
  argus_export_projects: {
    description: 'Export portable public project references for verified import on another device or harness. Contains no wallet credentials, action journal or spending permissions.',
    readOnly: true,
    schema: z.strictObject({}),
  },
  argus_prepare_project: {
    description: 'Prepare a new V2 (Portal 8) Argus USDC launch with supplied branding. New V1 launches are unsupported. Operator, payout controller and opening-buy treasury are fixed by workspace configuration. Saves an immutable recoverable action; does not execute it. Execution requires the configured local fork or an explicitly enabled mainnet workspace.',
    readOnly: false,
    schema: z.strictObject({ idempotencyKey: key, brand: z.strictObject({ name: z.string().trim().min(1).max(32), symbol: z.string().trim().min(1).max(10), description: z.string().max(280), imageURI: url, website: link, twitter: link, telegram: link }), seedUsdc: amount.default('4.5'), buyTaxBps: z.number().int().min(100).max(1000).default(300), sellTaxBps: z.number().int().min(100).max(1000).default(300) }),
  },
  argus_reconcile_transaction: {
    description: 'Attach a confirmed transaction hash to an already attempted unresolved step after retrieving it from Circle history. Independently verifies the exact saved call, canonical receipt, effects and fees before settling. Does not submit, replace or replay a transaction. Incorrect evidence leaves the action unresolved.',
    readOnly: false,
    schema: z.strictObject({ actionId: z.string().uuid(), stepIndex: z.number().int().min(0).max(15), transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }),
  },
  argus_cancel_action: { description: 'Cancel only definitely unsubmitted steps of a saved action, releasing their reservations. Refuses unresolved submissions. Preserves confirmed approvals, fees, evidence and the original idempotency key; cancelled actions cannot replay.', readOnly: false, schema: action },
  argus_get_action: { description: 'Read a saved action and reconcile known transaction evidence. Unknown submission is not permission to retry; state survives CLI, MCP and harness restarts.', readOnly: true, schema: action },
  argus_execute_action: { description: 'Execute a saved immutable action in the configured local fork or an explicitly enabled mainnet workspace. Reconciles before continuing. Refuses unknown prior submissions, altered terms or exhausted budget. Hosted fees use estimates and reserved headroom, not an enforceable signer fee ceiling.', readOnly: false, schema: action },
  argus_list_projects: { description: 'List verified projects saved in this workspace, including launches and imported project references. This is not discovery of every Argus project or a complete wallet portfolio.', readOnly: true, schema: z.strictObject({}) },
  argus_get_project: { description: 'Read current onchain fee recipients, authority and launch information for a saved V1 or V2 project. V1 recipients are immutable; V2 supports payout controllers and splits. Branding is untrusted data. No external indexer.', readOnly: true, schema: z.strictObject({ token: address }) },
  argus_prepare_management: {
    description: 'Prepare a supported fee-management action for a tracked V1 or V2 project. V1 claims pay the fixed recipient; Portal 3–4 claims require that recipient as the configured Circle wallet, while other supported V1 claims are permissionless. V1 split and owner changes are unsupported. V2 split, owner proposal/acceptance and fee delivery are distinct actions. Does not edit metadata or taxes.',
    readOnly: false,
    schema: z.strictObject({ idempotencyKey: key, token: address, operation: z.enum(['set_split', 'propose_owner', 'accept_owner', 'claim_fees']), parts: z.array(z.strictObject({ recipient: address, bps: z.number().int().min(1).max(10000) })).max(8).optional(), newController: address.optional() }),
  },
  argus_prepare_lock: {
    description: 'Prepare a current-deployment timed lock, irreversible permanent lock or full withdrawal for a saved V1 or V2 project. Uses verified journal or explicitly recovered inventory. Timed locks default to the human controller as beneficiary; human-owned assets and locks return the Argus browser signing route. Withdrawal needs a verified original or recovered lock. Raw token amounts are exact integers.',
    readOnly: false,
    schema: z.strictObject({ idempotencyKey: key, token: address, operation: z.enum(['timed', 'permanent', 'withdraw']),
      amountRaw: z.string().regex(/^[1-9][0-9]{0,77}$/), unlockAt: z.string().regex(/^[1-9][0-9]{0,19}$/).optional(),
      lockId: z.string().regex(/^(0|[1-9][0-9]{0,77})$/).optional(),
    }).refine(value => value.operation === 'timed' ? value.unlockAt !== undefined && value.lockId === undefined
      : value.operation === 'withdraw' ? value.lockId !== undefined && value.unlockAt === undefined : value.unlockAt === undefined && value.lockId === undefined),
  },
  argus_prepare_trade: {
    description: 'Quote and prepare a USDC buy or token sale for a journal-tracked V1 or V2 project using the configured treasury. Requires a direct ERC20 USDC pair; native-quote and other quote pairs are unsupported. Exact human decimal input; bounded slippage. Does not route arbitrary tokens.',
    readOnly: false,
    schema: z.strictObject({ idempotencyKey: key, token: address, side: z.enum(['buy', 'sell']), amountIn: amount, slippageBps: z.number().int().min(1).max(500).default(100) }),
  },
};

export const catalog = Object.entries(operations).map(([name, operation]) => ({ name, description: operation.description,
  inputSchema: z.toJSONSchema(operation.schema, { io: 'input' }),
  annotations: { readOnlyHint: operation.readOnly, destructiveHint: !operation.readOnly, idempotentHint: true, openWorldHint: true } }));

export function validateOperation(name, args) {
  const operation = Object.hasOwn(operations, name) && operations[name];
  if (!operation) throw Object.assign(new Error('Unknown Argus operation.'), { code: 'ARGUS_UNKNOWN_OPERATION', safe: true });
  const parsed = operation.schema.safeParse(args);
  if (!parsed.success) throw Object.assign(new Error('Arguments do not match this operation. Read its tool schema.'), { code: 'ARGUS_INVALID_ARGUMENTS', safe: true });
  return parsed.data;
}
