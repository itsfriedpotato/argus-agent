# Changelog

## Unreleased

- Read, import and recover existing V1 tokens from the supported Argus Portals 1–7 through the shared MCP, CLI and skill engine. New launches remain V2 (Portal 8) only.
- Support direct ERC20 USDC trades and current-deployment locks for existing V1 tokens.
- Read V1 fee recipients and precise per-asset fee units. Claim parked processor payments on Portals 1–2 and credited splitter fees on Portals 3–7, including Portal 7's separate converted-USDC balance. Portal 3–4 claims require the configured Circle wallet to be the recorded fee recipient. Reject V1 payout-split changes and controller rotation because recipients are immutable.

## 0.1.0 - 2026-10-16

First public release, MIT licensed.

- One engine behind an MCP server over stdio, a JSON CLI and an agent skill: 19 core tools, plus 2 for the optional shared bookmark and image service.
- Reads without a Circle session: token details, creator fee claims, wallet balances, timed locks and saved-project search. Bounded RPC reads, no indexer.
- Project launch preparation, trades, creator fee management, timed and permanent locks, project import and export, and position recovery.
- Execution through Circle Agent Wallets on Arc mainnet. Setup starts read-only; `enable-execution` turns execution on.
- A cumulative USDC budget per workspace: 10 USDC by default, 100 USDC at most.
- Token reads and actions cover Argus Portal 8 launches. Older tokens, including ARGUS, answer `UNSUPPORTED`.
