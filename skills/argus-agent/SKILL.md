---
name: argus-agent
description: Create and manage Argus token projects using the shared CLI or MCP, including branding, verified project recovery, creator fees, known-token trades and locks on Arc.
---

# Argus agent

Use the installed `argus-agent` CLI or the Argus MCP tools. They share the same engine and durable action state. Circle Agent Wallets provide execution. Installing this skill does not log into Circle, fund a wallet or authorize a transaction.

The installed CLI works outside the Argus repository on macOS, Windows and Linux with Node 22.13 or newer. Use the user's existing setup; `argus-agent doctor` checks readiness. `ARGUS_AGENT_CONFIG` selects an absolute configuration path; otherwise the application uses its per-user default. For repository development, `node scripts/argus-agent/entry.mjs` is the equivalent command. Do not change wallet sessions, configuration or execution mode during ordinary tool use. Never put wallet credentials, session tokens or OTPs in operation inputs.

Discover the current schemas before preparing an unfamiliar operation:

```sh
argus-agent tools
```

For short inputs, prefer `--json` with the JSON object passed as one shell argument. Use the exact operation name from the catalog and the original action identifier returned by the engine:

```sh
argus-agent argus_get_action --json '{"actionId":"<original-action-id>"}'
```

Use shell-safe quoting for user text. For longer inputs or text that is awkward to quote, a JSON file remains available:

```sh
argus-agent argus_prepare_project --input /absolute/path/project.json
```

Both forms accept a JSON object up to 64 KiB. Use one input form per call; `--input -` also accepts stdin. Shell quoting differs by shell, so prefer a JSON input file on Windows when the harness cannot pass argument arrays safely. File paths must follow the local operating system. MCP clients pass the equivalent structured arguments directly.

The CLI returns one JSON result. An `error` result and nonzero exit status mean the operation did not return a successful result. Do not infer that a transaction was never submitted from a transport error.

## Project workflow

Use `argus_prepare_project` to turn the user's launch terms into a prepared action. Preserve the distinct roles: the operator submits transactions, the controller owns payout authority, and the treasury receives the opening-buy tokens. Check the returned chain, contract, recipients, seed, taxes, brand metadata and spend terms against the user's request. Do not substitute a wallet merely to make execution succeed.

Use `argus_execute_action` with the prepared `actionId` when execution is already authorized for the configured environment. Its current schema accepts no additional authorization fields. Preparation is not signing or submission. Local fork execution is not Circle-authenticated or mainnet execution. A read-only or unsupported execution response is a capability boundary; do not work around it with direct Circle CLI calls or invented calldata.

Use `argus_get_action` to inspect the original action after an interrupted, failed or uncertain execution. Keep its identifier, preparation idempotency key and original terms. Do not automatically create another project or execute another action to recover an unknown transaction result. Resume only through the recovery path the engine actually supports.

When an attempted step is unresolved and its confirmed transaction hash is available from Circle history, `argus_reconcile_transaction` checks that hash against the saved step, canonical receipt, effects and fees. It does not send a transaction. `argus_cancel_action` cancels only definitely unsubmitted work; it cannot undo confirmed transactions or dismiss an unknown submission.

Use `argus_list_projects` and `argus_get_project` for projects recorded by this engine. To continue without the original conversation or journal, use `argus_import_project` with the original launch transaction or supported token reference. Import verifies chain evidence and current roles; it does not grant access or submit a replacement launch. `argus_export_projects` preserves portable references. Hosted sync, when configured, stores project bookmarks separately from wallet credentials and pending action recovery. Discover the available sync tools before using them.

Project lists are not a complete wallet inventory or a market-wide index. Use `argus_prepare_management`, `argus_prepare_trade` and `argus_prepare_lock` only for operations present in the discovered schema. A prepared quote or management action does not prove execution succeeded. Imported project references do not recover pending transactions or transfer custody of tokens.

New hosted trade plans group required approvals and the swap into one atomic wallet submission. Inspect `batchCalls` and the summary before execution. A swap with sufficient allowances remains one direct call. Existing saved actions retain their original steps. If a batch submission is uncertain, recover that same action; never fall back to separate approvals or a second swap. Circle remains the executor.

## Older tokens, Portals 1 to 7

Every Argus token works for reads, trades, creator-fee claims and locks; launching uses Portal 8 only. The engine finds the launching Portal itself and reports its line and generation; do not infer it from a name or symbol.

- Trades use the token's own pool with its launch tax in the minimum output. Only USDC pairs trade. Legacy Portals 1 and 2 tokens trade once graduated, and a sell also spends their sell tax from the remaining balance (`inventoryDebitRaw`).
- A claim receipt with `delivered: false` means another caller delivered the share first. It is settled; do not prepare it again.
- `claim_fees` is the only management operation on these tokens. Each claim sends only calls anyone may send and pays the launch's own creator address. Read `argus_get_claim_details` first: `deliverableNow` is what one claim delivers, and `refusal` explains a refused one.
- `CREATOR_SIGNATURE_REQUIRED` means only the creator wallet can collect that share. Tell the user which contract and call it names. Never ask for the creator's key, and never route it through the Circle wallet.
- `CONVERSION_QUEUED` means a Portal 7 share waits for a keeper conversion to USDC. `NOTHING_TO_CLAIM` means nothing can be delivered now. Neither is a failure to retry in a loop.

## Reads without an indexer

- `argus_get_token_details` reads any Argus token (Portals 1 to 8) by address without importing it. Supply its exact `launchBlock` only when known; otherwise launch metadata can be unavailable.
- `argus_get_claim_details` reads creator-fee amounts, asset units and registered recipients. Check `canClaim` and `executionSupported` before preparing a claim. A zero amount does not need a transaction. This is an observation, not reserved fees, payout-conversion output or a guarantee of sponsorship.
- `argus_get_wallet_balances` reads USDC and at most 20 supplied Argus tokens for an account. It does not discover every asset or calculate portfolio value.
- `argus_get_lock` and `argus_list_locks` inspect timed locks in the supported deployment without recovering inventory. Identify a lock by chain, deployment and ID together. For another page, use `nextOffset` and preserve the returned `observedBlockNumber` as `blockNumber`; compare block hashes across pages.
- `argus_search_projects` searches saved project names, symbols and addresses only. Empty results do not establish that a token does not exist onchain.

Use returned block, source and coverage fields when explaining results. Do not treat missing data as zero, saved references as current authority, or read-only lock eligibility as permission to submit a withdrawal. These operations do not access an indexer or scan chain history.

After importing a project into a fresh workspace, `argus_recover_position` can recover the configured Circle wallet's current token balance and an optional known timed-lock ID from the chain. It does not reset the USDC budget, discover every lock, or override a lock's owner. Resolve unfinished local actions first. If the result requires a human signature, follow its management link.

Human payout control and custody are distinct. The user's Circle account must restore the same execution wallet across harnesses; never silently create a new wallet to replace a missing session. Direct human-controller settings to the Argus management link returned by the engine. Human-held launch allocations require that human's signature to move. Timed locks belong to their recorded beneficiary; permanent locks have no withdrawal.

Clarify a request to change the "treasury": changing fee recipients with a payout split, rotating the payout controller, and replacing the wallet holding purchased tokens are different operations. A payout split does not move tokens already bought or replace the configured trading treasury.

## Boundaries

- Use Argus tools for Argus contract workflows so prepared terms, action identifiers and confirmed outcomes remain consistent. Circle remains the configured wallet executor; these instructions do not claim to prevent a user from using that wallet elsewhere.
- Use user-provided or harness-generated brand assets. If asset upload is configured, discover its tool and upload the final image before preparing a launch. No Pinata credentials should be requested from the user. An existing image URI remains supported. Do not claim that an image was generated, uploaded, pinned or published unless a tool actually performed that step.
- Do not promise edits to immutable launch terms, complete portfolio/history data, or arbitrary contract management. Report unsupported capabilities explicitly.
- Report confirmed action and transaction status separately from simulated, prepared, fixture, and read-only results. Preserve the engine's stated limitations.
