# Changelog

## 0.2.0 - 2026-10-17

Older Argus tokens, Portals 1 to 7, work for reads, trades, creator-fee claims and locks. Launching stays on Portal 8.

- One lookup finds the Portal that launched a token from the Portals' own records, and reports its line (v5, hooked, legacy) and generation.
- Reads, imports, position recovery and wallet balances accept any Argus token, ARGUS and ARCASH included.
- Trades use the launch's own pool, as argus.world does: the Universal Router for Portals 3 to 7, SwapRouter02 for Portals 1 and 2. The minimum output accounts for the live launch tax. USDC pairs only. A Portal 1 or 2 sell also reserves the sell tax its token takes from the remaining balance.
- Creator-fee claims send only calls anyone may send, and each pays the launch's own creator address. Every claim is simulated when prepared and again before it is sent; one another caller delivered first settles at zero. A share only the creator wallet can collect, and a Portal 7 share queued for conversion, are refused with a clear code.
- A buy on any Portal, Portal 8 included, must leave 0.25 USDC for gas, since Arc pays gas from the same balance. A buy that would not is refused when prepared, rather than saved as an action that cannot pass the reserve check at execution.
- Timed and permanent locks accept any Argus token.
- Portals 1 to 7 have no payout split or controller rotation, so those management actions are refused.
- `argus_get_claim_details` reports what one claim would deliver now, or why it cannot.

## 0.1.0 - 2026-10-16

First public release, MIT licensed.

- One engine behind an MCP server over stdio, a JSON CLI and an agent skill: 19 core tools, plus 2 for the optional shared bookmark and image service.
- Reads without a Circle session: token details, creator fee claims, wallet balances, timed locks and saved-project search. Bounded RPC reads, no indexer.
- Project launch preparation, trades, creator fee management, timed and permanent locks, project import and export, and position recovery.
- Execution through Circle Agent Wallets on Arc mainnet. Setup starts read-only; `enable-execution` turns execution on.
- A cumulative USDC budget per workspace: 10 USDC by default, 100 USDC at most.
- Token reads and actions cover Argus Portal 8 launches. Older tokens, including ARGUS, answer `UNSUPPORTED`.
