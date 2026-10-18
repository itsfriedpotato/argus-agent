# Argus for Agents

`@argus-world/agent` lets an AI agent on your own computer work with [Argus](https://argus.world) on Arc mainnet. One engine is offered three ways: an MCP server over stdio, a JSON CLI and an agent skill. It has 19 tools for token launches, trades, creator fee claims, locks, project recovery and reads, plus 2 optional tools for a shared bookmark and image service.

Argus prepares and checks each call. The [Circle CLI](https://developers.circle.com/) signs and sends it with your Circle Agent Wallet. Reads use the public Arc RPC. There is no indexer.

## Read this first

- **Real money.** Transactions spend real USDC on Arc mainnet (chain 5042). There is no testnet mode.
- **Spend cap.** Each workspace has a cumulative USDC budget: 10 USDC by default, 100 USDC at most. It is accounting inside the app, not a limit your wallet enforces.
- **Read-only by default.** Setup never submits a transaction. Execution needs a Circle login and `argus-agent enable-execution`.
- **Your wallet keeps control of new launches.** Your own wallet controls creator fees for new V2 launches. It is never the Circle wallet, and Argus holds no keys. Importing an existing token preserves its onchain fee recipients and authority.

See [SECURITY.md](SECURITY.md) before you fund a wallet.

## Install

Node.js 22.13 or newer on macOS, Linux or Windows.

```sh
npm install -g @argus-world/agent
argus-agent --help
```

## Quick start

Connect Circle in your own terminal. Type the email code there, never into an agent.

```sh
argus-agent circle-setup
argus-agent circle terms show
argus-agent circle terms accept
argus-agent circle wallet login YOUR_EMAIL --type agent
argus-agent circle wallet list --type agent --chain ARC --output json
```

Set up a workspace with your own wallet as the controller and the Circle wallet from the list, then check it:

```sh
argus-agent setup --controller YOUR_WALLET --circle-wallet YOUR_CIRCLE_WALLET --budget 10
argus-agent doctor
```

`doctor` should report `"status":"ready_for_reads"`. Reads work now, without a Circle session.

Add the MCP server to Claude Code:

```sh
claude mcp add argus --scope user -- argus-agent mcp              # macOS, Linux
claude mcp add argus --scope user -- cmd /c argus-agent mcp       # Windows
```

Setup also writes an `mcp.json` with the exact paths for other MCP clients, and prints the path of the bundled skill. The [install guide](docs/install.md) covers Claude Desktop, the skill, Windows notes and turning on execution. The [user guide](docs/guide.md) covers recovery, execution and the shared service.

## Tools

| Group | Tools |
| --- | --- |
| Reads, no Circle needed | `argus_get_token_details`, `argus_get_claim_details`, `argus_get_wallet_balances`, `argus_get_lock`, `argus_list_locks`, `argus_search_projects` |
| Projects | `argus_import_project`, `argus_recover_position`, `argus_export_projects`, `argus_list_projects`, `argus_get_project` |
| Actions | `argus_prepare_project`, `argus_prepare_trade`, `argus_prepare_lock`, `argus_prepare_management`, `argus_execute_action`, `argus_get_action`, `argus_cancel_action`, `argus_reconcile_transaction` |
| Shared service, optional | `argus_upload_asset`, `argus_sync_projects` |

`argus-agent tools` prints the current schemas. Prepare calls save an immutable action. Only `argus_execute_action` submits transactions, and only in a workspace with execution enabled.

## Scope and limits

- New launches use V2 (Portal 8) only. Existing V1 tokens from the supported Portals 1–7 can be read, imported and recovered.
- V1 and V2 trades support direct ERC20 USDC pairs. Native-quote and other quote pairs return `UNSUPPORTED`; the package does not add a conversion route.
- V1 fee recipients are immutable. Portals 1–2 support permissionless claims of parked creator payments; Portals 5–7 support permissionless claims of credited splitter fees. Portal 3–4 claims require the fee recipient to sign, so this MCP can execute them only when the configured Circle wallet is that recipient. Amounts are reported separately for each asset. V1 payout-split changes and controller rotation return `UNSUPPORTED`.
- Portal 6–7 tokens with a native quote retain identity, metadata and balance reads, but fee amounts are unknown and fee execution is unsupported. This differs from Portals 3–5, whose ERC20 USDC quote credits can be claimed as native USDC payouts.
- Both versions support timed and permanent locks in the currently supported deployments. Historical lock deployments are not discovered.
- There is no indexer: no market-wide search, trade history or analytics. Balance reads cover the tokens you name.
- Trades with approvals go to Circle as one atomic batch. That hosted batch path has not yet had a live mainnet acceptance test.
- If a result is unclear, check `argus_get_action` before you try again. Never send a replacement request for an unknown outcome.

## Repository layout

- `scripts/argus-agent/`: the runtime. `entry.mjs` is the `argus-agent` command.
- `scripts/argus-agent/generated/`: contract helpers compiled from the Argus app. Do not edit them; `manifest.json` records their hashes.
- `scripts/argus-agent/vendor/`: copies of the public Argus integration files (`argus-v4.json` and `argus-v5-launch-example.mjs` from argus.world) and one validation helper.
- `skills/argus-agent/SKILL.md`: the agent skill.
- `docs/`: the install and user guides.
- `tests/`: the test suite. `scripts/test-package.mjs` packs, installs and smoke-tests the package.

## Development

```sh
npm ci
npm test
npm run test:package -- --offline
```

The tests use fixtures. They never authenticate, sign or submit a mainnet transaction. Some tests skip unless their tools are present:

- Circle hosted-adapter tests need the pinned Circle CLI and its patch: `npm install --prefix .cache/argus-agent/circle-runtime --ignore-scripts @circle-fin/cli@1.1.4`, then `node scripts/argus-agent/patch-circle-hosted.mjs`.
- The local EVM batch test needs Anvil on `PATH` (or `ARGUS_TEST_ANVIL`) and the `solc` npm package (`ARGUS_TEST_SOLC`, or `npm install --prefix .cache/argus-agent/test-runtime/solc solc`).

Releases are published to npm from GitHub Actions with provenance when a `v*` tag is pushed.

## License

[MIT](LICENSE)
