# v4.2 Patch Notes

- Restored customer-facing portal layout with rotating headline.
- Removed operational role links from customer sidebar/homepage.
- Password protection fixed by moving role tokens to sessionStorage under v4.2 keys.
- Added default five-wallet demo shareholder register at deployment.
- Removed the Transfer Agent "Distribute tokens" action.
- Added atomic record-date finalization: mint entitlements + snapshot.
- Added EIP-712 delegation: shareholders can delegate voting rights to another wallet before voting.
- Vote eligibility uses effective voting power: own snapshot power + delegated power, unless rights were delegated out.
- Added improved results visuals and summary metrics.
- Reown AppKit remains active for wallet connection/signing.
