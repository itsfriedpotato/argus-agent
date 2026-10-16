# Security

## What you are running

- **Real funds.** Every executed transaction spends real USDC on Arc mainnet (chain 5042). On Arc, USDC is also the gas token.
- **Spend cap.** Each workspace has a cumulative USDC budget, 10 USDC by default and 100 USDC at most, set once at `setup --budget`. The cap is accounting inside this app. It is not a limit your Circle wallet enforces, and sale proceeds do not refill it.
- **Who signs.** Argus prepares and checks each call. The Circle CLI signs and sends it with your Circle Agent Wallet. Argus never sees a private key, and the package ships no credentials.
- **Who controls fees.** Your own wallet controls creator fees. Setup refuses to make the Circle wallet the controller.

## Keep your setup safe

- Never paste an email code, private key or session token into an agent prompt or a tool input.
- Keep the workspace folder (`~/.argus-agent` by default) private. On Windows, limit it to your user account.
- Execution stays off until you run `argus-agent enable-execution`. Turn it off again with `argus-agent disable-execution`.
- If an outcome is unclear, read `argus_get_action`. Do not send a replacement request.

## Supported versions

Security fixes go into the latest release on npm. Upgrade with `npm install -g @argus-world/agent`.

## Report a vulnerability

Please report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** (https://github.com/itsfriedpotato/argus-agent/security/advisories/new). Do not open a public issue.

Include the package version, your OS and Node.js version, the steps to reproduce and the impact you see. Never include credentials, email codes or a full private configuration. Do not test against wallets or funds that are not yours.
