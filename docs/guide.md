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

The human wallet controls creator-fee settings. The Circle wallet submits agent transactions. They must be distinct. Reuse your existing Circle wallet across agents; changing conversations must never create a replacement wallet.

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

The default treasury is your personal wallet. Agent operations involving its tokens return an Argus link for human signing. To allocate a Circle working treasury, choose `--treasury circle` during setup. That choice makes the Circle wallet custodian of those tokens. Creator-fee control remains with your personal wallet. Timed-lock beneficiary rights default to the personal wallet; permanent locks have no withdrawal.

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
| `argus_get_token_details` | Any Argus token by address, with its Portal and line, current creator-fee roles and known role balances. Launch metadata needs a known launch block. |
| `argus_get_claim_details` | Current creator fees, precise asset units, recipients, what one claim would deliver now and whether the claim workflow is supported. |
| `argus_get_wallet_balances` | USDC and up to 20 supplied Argus token addresses for a wallet. |
| `argus_get_lock` | A timed lock by ID from the supported deployment, including maturity and withdrawal state. |
| `argus_list_locks` | A page of an owner's timed locks, up to 50 per request. |
| `argus_search_projects` | Saved project names, symbols and token addresses in this workspace. |

The search is local, and balance reads cover only the supplied tokens. These are not market-wide search or complete portfolio discovery. Check the returned observation block and coverage; reuse the observation block for later lock pages. Reading a lock does not recover inventory or grant permission to withdraw it. Check claim details before preparing a claim; a zero balance needs no transaction.

## Which tokens work

Every Argus token works, from Portal 1 to Portal 8, ARGUS and ARCASH included. The agent finds the Portal that launched a token from the Portals' own records. Launching uses Portal 8 only.

| Tokens from | Read | Buy and sell | Creator-fee claim | Lock |
| --- | --- | --- | --- | --- |
| Portal 8 | Yes | Yes | Yes | Yes |
| Portals 5 to 7 | Yes | Yes | Split, then claim to the creator | Yes |
| Portals 3 and 4 | Yes | Yes | The split pays the creator directly | Yes |
| Portals 1 and 2 | Yes | Yes, once the token has graduated | A parked payout or an undispatched share | Yes |

- **Trades** go through the token's own pool, as argus.world routes them. The minimum output includes the launch tax read from the launch's own contracts. Only USDC pairs trade; other pairs answer `UNSUPPORTED`, because their routes skip the launch tax. On every Portal, Portal 8 included, a buy keeps 0.25 USDC back for gas, which comes out of the same balance: a buy that would leave less is refused when it is prepared. Selling a Portal 1 or 2 token also costs its sell tax, taken from the tokens you keep: selling 100 ARGUS uses 101. The plan reserves that from your inventory as `inventoryDebitRaw`.
- **Claims** on Portals 1 to 7 only send calls anyone may send, and each pays the launch's own creator address. The Circle wallet pays the gas and receives nothing. Every claim is simulated before it is prepared and again before it is sent. If another caller delivers the share in between, the claim confirms with `delivered: false` and moves nothing.
- **Refused claims.** A share a Portal 3 or 4 splitter could not pay out, and the Portal 1 and 2 fee locker share, can only be collected by the creator wallet: `CREATOR_SIGNATURE_REQUIRED` names the contract and the call. A Portal 7 share queued for conversion to USDC answers `CONVERSION_QUEUED` until a keeper converts it. Nothing to deliver answers `NOTHING_TO_CLAIM`.
- **Management.** Portals 1 to 7 have no payout split or controller rotation, so those actions answer `UNSUPPORTED`.
- **Import** an older token with its launch transaction hash, as with Portal 8. Trades and locks need an imported project, like any other.

## Recover an existing project first

Ask your agent:

> Import my Argus project using this confirmed launch transaction hash. Show the human fee controller, historical launch sender, current known balances and the Argus project link. Do not submit transactions.

The tool is `argus_import_project` with `launchTxHash` and optional `token`. It verifies the canonical receipt and current Argus registry. A token address alone needs its launch transaction reference; the client does not scan all chain history. `argus_export_projects` returns portable public references that can be imported into a clean workspace on another computer.

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

New Circle trade plans combine required approvals and the swap into one atomic wallet batch. Inspect the ordered `batchCalls` in the saved plan. A trade with sufficient allowances remains one direct swap; older saved actions retain their original steps. A Portals 5 to 7 claim that splits before it pays is batched the same way. If a batch outcome is uncertain, reconcile that same action. Do not replace it with separate approvals or another swap. Actual Circle-hosted batch submission, sponsorship and timing still need a budgeted mainnet acceptance test; simulations do not establish those results.

Use `argus_cancel_action` to abandon a preparation whose remaining steps were never submitted; it preserves completed fees and refuses uncertain submissions. If Circle returned no transaction hash or provider ID, obtain the transaction hash from Circle history and use `argus_reconcile_transaction` with the original action ID and step index. The SDK verifies the exact canonical transaction before attaching it. Circle CLI 1.1.4 history omits the original idempotency key, so that case cannot be resolved by guessing from the request ID.

```text
argus-agent disable-execution
```

Disabling retains the wallet, journal and budget. Creator-fee split or controller changes use the existing Argus browser interface and your personal wallet. The historical creator address is not the same thing as current creator-fee authority.

## Shared service

The included `scripts/argus-agent/beta-service.mjs` is a small single-host service backed by durable SQLite. The file name is kept for compatibility. Run `node beta-service.mjs /absolute/private/service.sqlite 3199` using the installed script path. It binds to loopback; deploy behind HTTPS on a host with persistent storage. Configure `ARGUS_BETA_TOKENS` (random access tokens mapped to user IDs) and `PINATA_JWT` privately. Never put them in a package or client configuration.

Defaults are 100 project bookmarks per user, 120 requests/minute, 20 image uploads/day, 200 retained image references and 2 MiB per image. Each user has a separate namespace. Rotate a token while keeping the user ID to retain that user's bookmarks. Back up the service database. This service stores project references and image records, not wallet keys, complete transaction journals or analytics.

The package does not create a public endpoint or issue tokens. This optional service is a REST API for bookmarks and images. MCP, wallet login, signing and the action journal remain on each user's computer. It is not a hosted MCP endpoint. Automatic package updates and factory-update mechanisms are not included; install releases from npm.

## Report a problem

Open an issue with the package version, OS, agent/client version, operation name, safe error code and public transaction hash if one exists. Keep credentials, OTPs and full private configuration out of reports. Include whether the action is prepared, pending, confirmed or unknown. Report security problems privately, as described in SECURITY.md. Analytics and market-wide discovery are outside this MVP.
