# Install Argus for Agents

Argus for Agents lets your AI agent work with Argus on Arc. It runs on your own computer. It comes as a JSON CLI, an MCP server and an agent skill. All three share one engine and about 20 tools: token launch, trades, creator fee claims, locks and reads.

Argus prepares and checks each call. The Circle CLI signs and sends it with your Circle Agent Wallet. Reads use the public Arc RPC. There is no indexer.

Transactions are real: they spend USDC on Arc mainnet. Start with a small budget.

## Requirements

- Node.js 22.13 or newer on macOS, Windows or Linux. Check with `node --version`.
- Your own wallet. It controls creator fees for new V2 launches and must differ from the Circle wallet. Imported tokens retain their existing onchain recipients and authority.
- To execute: a Circle account with an Agent Wallet on Arc, funded with USDC. Argus installs the pinned Circle CLI for you.

Setup needs your Circle wallet address, so connect Circle first. After setup, reads need no Circle session and sign nothing.

## Install

Install from npm, then set up and check:

```sh
npm install -g @argus-world/agent
argus-agent setup --controller YOUR_WALLET --circle-wallet YOUR_CIRCLE_WALLET --budget AMOUNT
argus-agent doctor
```

- Setup needs your Circle wallet address, so do [Connect Circle](#connect-circle) first.
- `AMOUNT` is your total USDC limit: at most 100. Without `--budget` it is 10.
- `doctor` should show `"status":"ready_for_reads"`. `argus-agent --help` shows the version, `0.1.0`.
- To install exactly this release, run `npm install -g @argus-world/agent@0.1.0`.

## Connect Circle

Run these in your own terminal:

```sh
argus-agent circle-setup
argus-agent circle terms show
argus-agent circle terms accept
argus-agent circle wallet login YOUR_EMAIL --type agent
argus-agent circle wallet list --type agent --chain ARC --output json
```

Accept the terms only after you read them. Type the email code in your terminal. Never give it to an agent. Use the same email later to get the same wallet back. Do not run `wallet create`.

## Set up your workspace

```sh
argus-agent setup --controller YOUR_WALLET --circle-wallet YOUR_CIRCLE_WALLET
```

- `--controller` is your own wallet. It must differ from the Circle wallet.
- `--budget` caps total USDC spend. The default is 10 USDC. The most a workspace allows is 100 USDC.
- A workspace keeps its budget. Workspaces made by an earlier build keep their old limit. To use the 100 USDC limit, set up a new workspace with `--home /absolute/new-folder --budget 100`.
- `--treasury human` (default) keeps opening-buy tokens in your wallet. `--treasury circle` puts them in the Circle wallet.

Setup writes `config.json` and `mcp.json` to `~/.argus-agent`. It starts read-only. It never overwrites a workspace, so use your real Circle wallet address here.

For another folder, run `setup --home /absolute/folder`. Then set `ARGUS_AGENT_CONFIG` to `/absolute/folder/config.json` for every other command, including the MCP server. Setup reads `--home`, not `ARGUS_AGENT_CONFIG`.

## Check readiness

```sh
argus-agent doctor
```

Look for `"status":"ready_for_reads"`. `wallet.ready` turns true after Circle login. Use `doctor --config FILE` to check another workspace.

## Add the MCP server

### Claude Code

macOS and Linux:

```sh
claude mcp add argus --scope user -- argus-agent mcp
```

Windows:

```sh
claude mcp add argus --scope user -- cmd /c argus-agent mcp
```

For a custom workspace, add `-e ARGUS_AGENT_CONFIG=/absolute/folder/config.json` before the `--`. Check it with `claude mcp list`.

### Claude Desktop

Setup wrote `mcp.json` next to your `config.json`. It holds the exact Node path, script path and config path for your machine. Copy its `argus` entry into Claude Desktop's config file:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

It looks like this on Windows:

```json
{
  "mcpServers": {
    "argus": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "C:\\Users\\YOU\\AppData\\Roaming\\npm\\node_modules\\@argus-world\\agent\\scripts\\argus-agent\\entry.mjs",
        "mcp"
      ],
      "env": { "ARGUS_AGENT_CONFIG": "C:\\Users\\YOU\\.argus-agent\\config.json" }
    }
  }
}
```

And like this on macOS:

```json
{
  "mcpServers": {
    "argus": {
      "command": "/usr/local/bin/node",
      "args": ["/usr/local/lib/node_modules/@argus-world/agent/scripts/argus-agent/entry.mjs", "mcp"],
      "env": { "ARGUS_AGENT_CONFIG": "/Users/YOU/.argus-agent/config.json" }
    }
  }
}
```

Use the paths from your own `mcp.json`. Restart Claude Desktop.

## Install the skill

The skill teaches an agent with a terminal to use the CLI. Claude Code loads skills from `~/.claude/skills`.

macOS and Linux:

```sh
mkdir -p ~/.claude/skills
cp -R "$(npm root -g)/@argus-world/agent/skills/argus-agent" ~/.claude/skills/
```

Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force "$HOME\.claude\skills" | Out-Null
Copy-Item -Recurse -Force "$(npm root -g)\@argus-world\agent\skills\argus-agent" "$HOME\.claude\skills\"
```

Other agents can read the same `SKILL.md`. Setup prints its path as `skillPath`. An agent without a terminal should use the MCP server.

## Reads that need no Circle session

These tools work right after setup, before `enable-execution`. They need no active Circle session and sign nothing.

| Tool | Reads |
| --- | --- |
| `argus_get_token_details` | A token's fee roles, branding and role balances |
| `argus_get_claim_details` | Creator fees owed and their recipients |
| `argus_get_wallet_balances` | USDC and up to 20 listed tokens for a wallet |
| `argus_get_lock` | One timed lock by ID |
| `argus_list_locks` | A page of a wallet's timed locks |
| `argus_import_project` | Verifies a launch receipt and saves the project locally |
| `argus_list_projects`, `argus_get_project` | Projects saved in this workspace |
| `argus_search_projects` | Saved projects by name, symbol or address |
| `argus_export_projects` | Portable project references |
| `argus_get_action` | A saved action and its status |

Token reads cover V2 (Portal 8) and existing V1 tokens from the supported Portals 1–7. New launches remain V2 only. V1 trading supports direct ERC20 USDC pairs, and supported fee claims pay the existing immutable recipients. Portal 3–4 claims require the configured Circle wallet to be the fee recipient. Both versions can use the currently supported lock deployments. V1 payout-split edits and controller rotation are unsupported. See the [version and management limits](guide.md#token-versions-and-management) for the different V1 fee models.

```sh
argus-agent tools
argus-agent argus_get_claim_details --json '{"token":"0xTOKEN"}'
```

Windows PowerShell 5.1 strips the inner quotes. Pipe the JSON or use a file:

```powershell
'{"token":"0xTOKEN"}' | argus-agent argus_get_claim_details --input -
argus-agent argus_get_claim_details --input C:\path\request.json
```

## Turn on execution

Preparing and executing need Circle. This covers `argus_prepare_project`, `argus_prepare_trade`, `argus_prepare_lock`, `argus_prepare_management` and `argus_execute_action`. In a read-only workspace, prepare calls return `ARGUS_EXECUTION_DISABLED`.

```sh
argus-agent enable-execution
```

This works once `doctor` shows the Circle wallet ready. Ask your agent to prepare an action, check the terms, then execute it. `argus-agent disable-execution` turns it off. Your wallet, journal and budget stay.

## Safety model

- Your own wallet controls creator fees for new V2 launches. Setup refuses the Circle wallet as controller. Importing an existing token does not change its onchain authority or fee recipients.
- Argus prepares and checks every call. Circle signs and sends it. Argus holds no keys.
- Setup starts read-only. Execution needs a Circle login and `enable-execution`.
- The budget caps total USDC spend. It is app accounting, not a wallet limit.
- Tokens in your own wallet need your signature. Tools return an Argus link for that.
- Never paste an email code, key or session token into an agent.
- If a result is unclear, check `argus_get_action`. Do not send a new request.
- Keep the workspace folder private. On Windows, limit it to your user account.

## Windows notes

- If PowerShell says scripts are disabled, run `argus-agent.cmd`, or run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.
- Node may print an `ExperimentalWarning` about SQLite. It is harmless.
- If `doctor` returns `ARGUS_SETUP_FAILED`, run `setup` first or point `ARGUS_AGENT_CONFIG` at your `config.json`.
