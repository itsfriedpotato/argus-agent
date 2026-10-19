# Argus for Agents

`@argus-world/agent` lets an AI agent on your own computer work with [Argus](https://argus.world) on Arc mainnet. One engine is offered three ways: an MCP server over stdio, a JSON CLI and an agent skill. It has 19 tools for token launches, trades, creator fee claims, locks, project recovery and reads, plus 2 optional tools for a shared bookmark and image service.

Argus prepares and checks each call. The [Circle CLI](https://developers.circle.com/) signs and sends it with your Circle Agent Wallet. Reads use the public Arc RPC. There is no indexer.

## Read this first

- **Real money.** Transactions spend real USDC on Arc mainnet (chain 5042). There is no testnet mode.
- **Spend cap.** Each workspace has a cumulative USDC budget: 10 USDC by default, 100 USDC at most. It is accounting inside the app, not a limit your wallet enforces.
- **Read-only by default.** Setup never submits a transaction. Execution needs a Circle login and `argus-agent enable-execution`.
- **Your wallet keeps control.** Your own wallet controls creator fees. It is never the Circle wallet, and Argus holds no keys.

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

Every Argus token works, from Portal 1 to Portal 8. Launching uses Portal 8 only.

| Tokens from | Read | Buy and sell | Creator-fee claim | Lock |
| --- | --- | --- | --- | --- |
| Portal 8 | Yes | Yes | Yes | Yes |
| Portals 5 to 7 | Yes | Yes | Split, then claim to the creator | Yes |
| Portals 3 and 4 | Yes | Yes | The split pays the creator directly | Yes |
| Portals 1 and 2, with ARGUS and ARCASH | Yes | Yes, once the token has graduated | A parked payout or an undispatched share | Yes |

- Trades go through the token's own pool, and the minimum output includes the live launch tax. Only USDC pairs trade: other pairs route through pools that skip the launch tax.
- Selling a Portal 1 or 2 token also costs its sell tax, taken from the tokens you keep: selling 100 ARGUS uses 101.
- A buy must leave 0.25 USDC in the wallet for gas, on every Portal: Arc pays gas from the same USDC balance.
- Claims on Portals 1 to 7 only send calls anyone may send, and each pays the launch's own creator address. Every claim is simulated first.
- Some shares only the creator wallet can collect: a share a Portal 3 or 4 splitter could not pay out, and the Portal 1 and 2 fee locker share. The agent never signs as the creator, so it refuses these and names the contract and call.
- A Portal 7 share queued for conversion to USDC cannot be claimed until a keeper converts it.
- Portals 1 to 7 have no payout split or controller rotation.
- There is no indexer: no market-wide search, trade history or analytics. Balance reads cover the tokens you name.
- Trades with approvals, and claims that split before they pay, go to Circle as one atomic batch. That hosted batch path has not yet had a live mainnet acceptance test.
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
