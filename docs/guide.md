# Argus for Agents: user guide

This package connects a local agent to Argus on Arc mainnet through Circle Agent Wallets. It includes standard MCP over stdio, a JSON CLI, and a skill. The package targets macOS, Windows and Linux with Node.js 22.13 or newer. Platform/client verification is reported separately; a standard interface does not imply every agent has been tested.

The package contains no wallet session, access token, private key, journal or infrastructure secret. It is MIT licensed. Transactions spend real USDC on Arc mainnet.

## Install

Install Node.js 22.13 or newer, then run in your terminal:

```text
npm install --global @argus-world/agent
argus-agent --help
```

On every OS use your own private account directory for configuration. POSIX files use owner-only permissions; Windows users must restrict that directory to their user with Windows ACLs.

## Connect your wallets

For new V2 launches, the human wallet controls creator-fee settings. The Circle wallet submits agent transactions. They must be distinct. Existing tokens retain their onchain authority and recipients when imported; V1 fee recipients cannot be changed. Reuse your existing Circle wallet across agents; changing conversations must never create a replacement wallet.

```text
argus-agent circle-setup
```

This installs a pinned Circle CLI and a reproducible Argus calldata compatibility layer in your private directory. It does not accept terms, authenticate or create a wallet. Run these commands in your own terminal; they work the same in macOS/Linux shells, PowerShell and Windows Command Prompt:

```text
argus-agent circle terms show
argus-agent circle terms accept
argus-agent circle wallet login YOUR_EMAIL --type agent
argus-agent circle wallet list --type agent --chain ARC --output json
```

Run `terms accept` only after reviewing and accepting the displayed terms. The login command prompts for the emailed code directly in your terminal. Agents must not capture that code; do not put an OTP, key or persistent credential into an agent prompt. Argus forwards this command to the pinned runtime with the correct session directory, so no shell-specific environment assignment is needed.

Use the same email when restoring access. Circle reuses its existing wallets on subsequent logins and automatically provisions wallets at first login; do not run `wallet create` after logging in. Confirm that the returned ARC address matches your existing wallet before continuing recovery. For a custom workspace, put `--home "/absolute/workspace"` immediately after `circle` in each command, matching the path supplied to `circle-setup` and `setup`.

Configure the returned Circle address and your personal wallet:

```text
argus-agent setup --controller YOUR_PERSONAL_WALLET --circle-wallet YOUR_CIRCLE_WALLET --budget 5
argus-agent doctor
```

Setup starts read-only and does not submit transactions. It prints the absolute configuration and MCP configuration paths. `ARGUS_AGENT_CONFIG` can select another workspace; the default is `.argus-agent/config.json` under your OS user home. Setup refuses to overwrite an existing workspace.

The default treasury is your personal wallet. Agent operations involving its tokens return an Argus link for human signing. To allocate a Circle working treasury, choose `--treasury circle` during setup. That choice makes the Circle wallet custodian of those tokens. For new V2 launches, creator-fee control remains with your personal wallet. Timed-lock beneficiary rights default to the personal wallet; permanent locks have no withdrawal.

A workspace accepts a cumulative budget of up to 100 USDC; without `--budget` it is 10 USDC. This is application accounting, not a wallet-enforced total. Sponsored operation fees are conservatively included, and sale proceeds do not replenish it.

A workspace keeps the budget it was created with. Workspaces made by an earlier build keep their old limit; to use the 100 USDC limit, run `setup` with `--home /absolute/new-folder` and `--budget 100`, then point `ARGUS_AGENT_CONFIG` at its `config.json`. Settle any pending action in the old workspace first; its journal stays where it is. Apart from this upgrade, do not create replacement workspaces to get around a limit or an unresolved transaction.

## Connect an agent

For an MCP-capable client, copy the generated `mcp.json` entry into that client's MCP configuration. The command is the absolute Node executable, arguments are the installed `entry.mjs` path followed by `mcp`, and the environment supplies only the absolute `ARGUS_AGENT_CONFIG` path. The server uses standard stdio, not a hosted URL.

For an agent with terminal access, provide the bundled `skills/argus-agent/SKILL.md` and let it invoke `argus-agent tools` and the JSON operations. The CLI accepts `--input /absolute/request.json` to avoid shell quoting differences. An agent with neither MCP nor command execution needs a connector before it can use this package.

No setup command modifies Claude, Codex, Hermes or another client's settings automatically. Use the same workspace across clients on one computer.

## Read without signing

There are 19 core tools, with two more when the optional shared service is configured. Use `argus-agent tools` to inspect the current schemas. These six reads work in an execution-disabled workspace without Circle login or a new indexer:

| Tool | What it reads |
| --- | --- |
| `argus_get_token_details` | A supported token by address, its current creator-fee roles and known role balances. Launch metadata needs a known launch block. |
| `argus_get_claim_details` | Current creator fees, precise asset units, recipients and whether the claim workflow is supported. |
| `argus_get_wallet_balances` | USDC and up to 20 supplied supported token addresses for a wallet. |
| `argus_get_lock` | A timed lock by ID from the supported deployment, including maturity and withdrawal state. |
| `argus_list_locks` | A page of an owner's timed locks, up to 50 per request. |
| `argus_search_projects` | Saved project names, symbols and token addresses in this workspace. |

The search is local, and balance reads cover only the supplied tokens. These are not market-wide search or complete portfolio discovery. Check the returned observation block and coverage; reuse the observation block for later lock pages. Reading a lock does not recover inventory or grant permission to withdraw it. Check claim details before preparing a claim; a zero balance needs no transaction.

## Token versions and management

New launches use V2 (Portal 8) only. Existing V1 tokens from the supported Portals 1–7 can be read, imported and recovered through the same MCP, CLI and skill workflows.

| Operation | Existing V1 tokens | V2 tokens |
| --- | --- | --- |
| Details, named-token balances, project import and position recovery | Supported | Supported |
| Buys and sells | Direct ERC20 USDC pairs only | Direct ERC20 USDC pairs only |
| Fee claims | Portals 1–2 and 5–7: permissionless; Portals 3–4: recipient must sign. Native-quote tokens on 6–7 are unsupported. | Supported when the verified fee and payout assets are USDC |
| Payout-split edits and controller rotation | Unsupported; fee recipients are immutable | Personal-wallet signing route for supported controls |
| Timed locks, permanent locks and eligible withdrawals | Current supported deployments | Current supported deployments |

V1 claims always pay the fixed creator-fee recipient; the caller cannot choose a different destination. That recipient can differ from the historical launch sender. Portals 1–2 and 5–7 allow someone else to submit the claim for that recipient. Portals 3–4 require the recipient's signature: the MCP can execute only if its configured Circle wallet is that recipient. Otherwise it reports the unavailable signer. The current Argus browser claim route is not offered for this case. Fee models differ by portal:

- Portals 1–2 normally push creator payments automatically. Claim details report any parked native USDC payment in 18-decimal units. The processor's creator bucket awaiting dispatch is separate from that claim balance.
- Portals 3–5 keep USDC and token fee credits. The USDC credit uses 6-decimal units and pays as native USDC in 18-decimal units. Claim details normalize that amount to the native payout units; project details retain the ledger units. Token credits use 18-decimal units. Portals 3–4 normally push payments automatically; failed payments leave parked credits that only the recipient can claim. Portal 5 allows permissionless submission for the recipient.
- Portal 6 reports credited quote-asset and token fees separately.
- Portal 7 reports credited quote-asset fees, token fees and converted USDC as three separate balances. Converted USDC uses 6-decimal units.

Use each returned asset and its exact decimals. Claim details do not estimate uncredited fees or pending conversions, and a zero claim balance does not mean no fees have been earned. Do not assume every quote or payout asset is USDC. Native-quote and other non-USDC trade pairs return `UNSUPPORTED`; the engine does not create a conversion route. This MCP does not edit V1 metadata or taxes, or change its immutable creator-fee recipients.

For Portal 6–7 tokens whose quote asset is the zero address (native currency), identity, metadata and balance reads still work. Fee amounts return `null`, with reason `unsupported_native_quote`, and fee execution is unsupported. Unknown amounts must not be reported as zero. This limitation does not apply to Portals 3–5's supported ERC20 USDC quote credits paid out as native USDC.

Legacy V1 trade quotes refuse amounts that cross a liquidity boundary the engine cannot quote reliably (`QUOTE_RANGE_EXCEEDED`). Try a smaller amount; do not bypass the refusal with an assumed price. Hooked V1 pools with unsupported protocol fees also return `UNSUPPORTED`.

## Recover an existing project first

Ask your agent:

> Import my Argus project using this confirmed launch transaction hash. Show the token version, current fee recipients and authority, historical launch sender, current known balances and the Argus project link. Do not submit transactions.

The tool is `argus_import_project` with `launchTxHash` and optional `token`. It verifies the canonical receipt against a supported portal and its current launch record. A token address alone needs its launch transaction reference; the client does not scan all chain history. Older V1 launch events do not include every branding field, so missing metadata is reported rather than invented. `argus_export_projects` returns portable public references that can be imported into a clean workspace on another computer.

Importing does not grant signing authority or replay old actions. It does not recover uncertain submissions. Keep the original action journal if an operation is pending or its outcome is unknown.

For tokens already held by the Circle working wallet, `argus_recover_position` verifies the current balance and optionally a known timed-lock ID. This restores usable holdings without increasing the USDC budget. It requires local actions to be settled or safely cancelled. Human-owned lock withdrawals are directed to Argus's Lock page with the verified lock ID.

## Hosted project backups and images

The Argus team can give you a private access token file and the HTTPS URL of the shared service. Add `--service-url URL --service-token-file /absolute/token-file` during setup. Never paste the token into a prompt or share it.

Confirmed project imports and launches then save bookmarks automatically. In a fresh workspace use `argus_sync_projects` to retrieve and independently verify them on-chain. A failed bookmark save does not mean a launch failed; retry the sync, never the launch.

`argus_upload_asset` accepts an absolute local path and PNG/JPEG/WebP content type, up to 2 MiB. The service pins the image and returns an IPFS URI. You do not need a Pinata account. Without the shared service, existing HTTPS/IPFS artwork can still be supplied to launch preparation. Image generation is supplied by your agent or by you.

## Execute only after setup

After authenticating Circle and funding the same ARC wallet, run:

```text
argus-agent enable-execution
```

Ask the agent to prepare your action, show the name/amount/recipient/estimated fees, and execute that saved action when authorized. Always inspect `argus_get_action` after an interrupted response. Do not create a replacement request until the original outcome is known.

New Circle trade plans combine required approvals and the swap into one atomic wallet batch. Inspect the ordered `batchCalls` in the saved plan. A trade with sufficient allowances remains one direct swap; older saved actions retain their original steps. If a batch outcome is uncertain, reconcile that same action. Do not replace it with separate approvals or another swap. Actual Circle-hosted batch submission, sponsorship and timing still need a budgeted mainnet acceptance test; simulations do not establish those results.

Use `argus_cancel_action` to abandon a preparation whose remaining steps were never submitted; it preserves completed fees and refuses uncertain submissions. If Circle returned no transaction hash or provider ID, obtain the transaction hash from Circle history and use `argus_reconcile_transaction` with the original action ID and step index. The SDK verifies the exact canonical transaction before attaching it. Circle CLI 1.1.4 history omits the original idempotency key, so that case cannot be resolved by guessing from the request ID.

```text
argus-agent disable-execution
```

Disabling retains the wallet, journal and budget. Supported V2 creator-fee split or controller changes use the existing Argus browser interface and your personal wallet. V1 rejects these changes because its fee recipients are immutable. The historical creator address is not the same thing as current creator-fee authority for a V2 project.

## Shared service

The included `scripts/argus-agent/beta-service.mjs` is a small single-host service backed by durable SQLite. The file name is kept for compatibility. Run `node beta-service.mjs /absolute/private/service.sqlite 3199` using the installed script path. It binds to loopback; deploy behind HTTPS on a host with persistent storage. Configure `ARGUS_BETA_TOKENS` (random access tokens mapped to user IDs) and `PINATA_JWT` privately. Never put them in a package or client configuration.

Defaults are 100 project bookmarks per user, 120 requests/minute, 20 image uploads/day, 200 retained image references and 2 MiB per image. Each user has a separate namespace. Rotate a token while keeping the user ID to retain that user's bookmarks. Back up the service database. This service stores project references and image records, not wallet keys, complete transaction journals or analytics.

The package does not create a public endpoint or issue tokens. This optional service is a REST API for bookmarks and images. MCP, wallet login, signing and the action journal remain on each user's computer. It is not a hosted MCP endpoint. Automatic package updates and factory-update mechanisms are not included; install releases from npm.

## Report a problem

Open an issue with the package version, OS, agent/client version, operation name, safe error code and public transaction hash if one exists. Keep credentials, OTPs and full private configuration out of reports. Include whether the action is prepared, pending, confirmed or unknown. Report security problems privately, as described in SECURITY.md. Analytics and market-wide discovery are outside this MVP.
