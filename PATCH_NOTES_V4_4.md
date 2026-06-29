# Mini Galaxy POC Enterprise v4.4 — Ballot Signature and Protected Portal Fixes

## Targeted fixes

- Reworked the ballot signature payload to avoid EIP-712 dynamic numeric array mismatch issues.
- Wallet-signed ballot now contains a visible `choices` field such as `[0,1,2]` and a `choicesHash` integrity field.
- Voting contract verifies the packed choices bytes against `choicesHash` and recovers the signer from the typed ballot.
- Reduced dynamic array usage in the voting contract receipt/event path to avoid Hardhat stack-overflow behavior seen during vote simulation.
- Added privileged role links to the sidebar with a muted/blurred access marker.
- Kept non-investor portals password protected and auto-locked on route change through session-scoped role keys.
- Preloaded the Transfer Agent register text area with the five standard Hardhat holder wallets.
- Kept Reown AppKit wallet connection and visible disconnect button.
- Persisted token-add prompts per wallet/token so refresh does not repeatedly trigger MetaMask `wallet_watchAsset`.
- Preserved the existing Broadridge UI and styling; only small targeted CSS rules were appended.

## Fresh deployment required

The voting contract ABI changed. Stop the old Hardhat chain, delete old deployment JSON if present, run `npm run compile`, and deploy a fresh event from the Admin GUI.
