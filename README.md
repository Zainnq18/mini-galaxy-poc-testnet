# Broadridge Proxy Voting Portal — v4.2

Production-style local proof of concept for tokenised proxy voting.


## Live testnet migration

This package now includes a Polygon Amoy + hosted frontend/backend migration path. The original local UI and flow are preserved. For the live no-laptop version, follow:

```text
TESTNET_MIGRATION_GUIDE.md
```

The live architecture is:

```text
Vercel frontend -> Render relayer/backend -> Polygon Amoy contracts
```

The hosted relayer uses `DeploymentRegistry.sol` to remember the latest voting deployment on-chain, avoiding paid storage.

## What changed

- Reown AppKit wallet connection retained.
- Customer-facing sidebar keeps Portal, Vote, and Results prominent; protected operation links are shown with a subdued locked treatment.
- Operations pages are password protected.
- Legacy localStorage role tokens are ignored; roles use session-scoped v4.2 keys.
- Five deterministic Hardhat shareholder wallets are imported into the shareholder register during GUI deployment.
- The separate "Distribute tokens" UI is removed.
- Transfer Agent uses **Finalize record date**, which mints registered ERC20 company-token entitlements and snapshots balances in one record-date operation.
- Investor wallets are prompted to add the ERC20 company token when connected.
- Delegation is supported with EIP-712 signatures and gasless relay submission.
- Results have improved weighted-result graphics.
- No issuer / transfer-agent / broker cards appear on the customer homepage.

## Default role passwords

```text
Admin:              broadridge-admin
Issuer:             broadridge-issuer
Transfer Agent:     broadridge-ta
Inspector:          broadridge-inspector
Proxy Solicitor:    broadridge-solicitor
```

## Install

Use Command Prompt, not PowerShell.

```bat
cd /d "%USERPROFILE%\Desktop\mini-galaxy-poc-ent"
if exist node_modules rmdir /s /q node_modules
if exist package-lock.json del package-lock.json
npm cache verify
npm install
npm install @openzeppelin/contracts@5.0.2 --save-exact
npm install @nomicfoundation/hardhat-toolbox --save-dev
npm run compile
```

## Run

Terminal 1:

```bat
cd /d "%USERPROFILE%\Desktop\mini-galaxy-poc-ent"
npm run chain
```

Terminal 2:

```bat
cd /d "%USERPROFILE%\Desktop\mini-galaxy-poc-ent"
copy .env.example .env
npm run frontend
```

Open:

```text
http://localhost:5173
```

## GUI flow

1. Go to `/admin` and unlock with `broadridge-admin`.
2. Create and deploy a new voting event.
3. Go to `/transfer-agent` and unlock with `broadridge-ta`.
4. Review/import the shareholder register as needed.
5. Click **Finalize record date**. This mints ERC20 company-token entitlements to registered wallets and snapshots record-date balances.
6. Connect an investor wallet from the customer portal.
7. Add the ERC20 token to MetaMask when prompted.
8. Vote or delegate voting rights.
9. Close voting from `/issuer`.
10. View final weighted results from `/results`.

## Default shareholder register

GUI deployment imports these five deterministic Hardhat wallets by default:

```text
0x70997970C51812dc3A010C7d01b50e0d17dc79C8 — 40
0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC — 25
0x90F79bf6EB2c4f870365E785982E1f101E93b906 — 15
0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65 — 12
0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc — 8
```

## Operations URLs

```text
/admin
/issuer
/transfer-agent
/inspector
/proxy-solicitor
```

The public customer navigation does not expose these links.

## v4.3 Notes

This build fixes ballot signing by putting the `choices` array directly into the EIP-712 ballot message. It also prevents repeated MetaMask token-add prompts, locks privileged portals when users navigate away, keeps the ballot progress bar sticky while scrolling, and includes the white Broadridge logo in `frontend/public`.

## v4.4 hotfix notes

This build signs ballots using a canonical EIP-712 `choices` string and `choicesHash`. The API payload also includes `choicesArray` for relay validation and audit readability. The voting contract receives packed ballot choices, verifies the hash, and then tallies each selected option. This avoids the dynamic-array signature mismatch seen in previous builds.

GUI deployment now supplies explicit gas limits during contract deployment and proposal setup, avoiding the Hardhat `Contract deployment StackOverflow` gas-estimation issue.

Protected operational links are shown in the sidebar with a subdued privileged treatment. They remain password-gated and lock again when the user leaves the role page or refreshes.

The Transfer Agent register box is preloaded with the five default Hardhat demo shareholders, so the demo operator can click **Import register** directly after deploying the event.

## v4.4 important note

This build changes the gasless ballot signature format. Use a fresh Hardhat chain and deploy a new event from the Admin GUI before testing voting. The signed ballot now displays a `choices` value like `[0,1,2]` and the contract verifies a deterministic `choicesHash` for on-chain integrity.
