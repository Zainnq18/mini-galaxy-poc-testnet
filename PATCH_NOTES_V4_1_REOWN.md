# Patch Notes v4.1 — Reown AppKit Restored

- Restored Reown AppKit wallet modal connection.
- Preserved the existing Broadridge UI and `styles.css`.
- Added `frontend/src/reownConfig.js`.
- Updated `frontend/src/main.jsx` to initialize AppKit.
- Updated `frontend/src/services/wallet.js` so signing, chain switching, and ERC20 token display use the Reown-connected EVM provider.
- Updated `frontend/src/App.jsx` only where necessary to use `useAppKit`, `useAppKitAccount`, and `useAppKitProvider`.
- Voting, role portals, GUI deployment, ERC20 distribution, snapshotting, and result workflows remain unchanged.
