# v4.3 Precision Fixes

This build preserves the v4.2 customer-facing UI and applies only targeted fixes.

## Fixed

- EIP-712 ballot signatures now include the `choices` array directly in the signed message.
- Solidity now hashes the `uint8[] choices` array using EIP-712-compatible array encoding before signature recovery.
- Relayer build/relay ballot routes now validate the signed `choices` array directly.
- Wallet signing now checks the active wallet account before requesting `eth_signTypedData_v4`.
- MetaMask `wallet_watchAsset` prompt is now throttled per wallet/token/session and no longer appears on every refresh.
- Role pages auto-lock when navigating away and use a fresh session key namespace.
- Protected role portals now show a subtle privileged badge and protected-button indicator that is not present in the investor portal.
- Ballot progress bar is sticky inside the proposal scroll area.
- Broadridge white logo asset is included under `frontend/public/broadridge-logo-white.png`.
- ProxyVoting deployment avoids nested dynamic proposal arrays in the constructor. Proposals are now added after deployment, reducing Hardhat deployment stack issues.

## Still Preserved

- Reown AppKit wallet connection.
- Existing Broadridge visual theme and sidebar structure.
- Separate role portals.
- Actual ERC20 company token distribution at record-date finalization.
- Delegation.
- Gasless voting.
