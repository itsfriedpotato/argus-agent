# Changelog

## 0.1.0 - 2026-10-16

First public release, MIT licensed.

- One engine behind an MCP server over stdio, a JSON CLI and an agent skill: 19 core tools, plus 2 for the optional shared bookmark and image service.
- Reads without a Circle session: token details, creator fee claims, wallet balances, timed locks and saved-project search. Bounded RPC reads, no indexer.
- Project launch preparation, trades, creator fee management, timed and permanent locks, project import and export, and position recovery.
- Execution through Circle Agent Wallets on Arc mainnet. Setup starts read-only; `enable-execution` turns execution on.
- A cumulative USDC budget per workspace: 10 USDC by default, 100 USDC at most.
- Token reads and actions cover Argus Portal 8 launches. Older tokens, including ARGUS, answer `UNSUPPORTED`.
