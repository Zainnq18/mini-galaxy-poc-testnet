# Migration Patch Summary

## UI status

The visible UI files were not changed:

```text
frontend/src/App.jsx      unchanged
frontend/src/styles.css   unchanged
```

The changes are infrastructure/configuration/backend changes only.

## Main additions

```text
contracts/DeploymentRegistry.sol
scripts/deployRegistry.js
scripts/checkTestnetConfig.js
.github/workflows/deploy-registry-amoy.yml
.env.amoy.example
.env.render.example
.env.vercel.example
render.yaml
vercel.json
TESTNET_MIGRATION_GUIDE.md
docs/TEAM_TESTER_ONE_PAGER.md
docs/DEMO_WALLETS.md
```

## Main behavior change

Local mode still exists. Testnet mode adds:

```text
Polygon Amoy chain ID: 80002
Hosted Render relayer support
Hosted Vercel frontend support
Configurable frontend wallet network
On-chain deployment persistence through DeploymentRegistry
```

## Important implementation detail

The relayer currently owns/administers the deployed contracts. For this POC, use the same fresh testnet private key for:

```text
DEPLOYER_PRIVATE_KEY
RELAYER_PRIVATE_KEY
```

Using separate keys can break owner-only operations unless ownership transfer logic is added later.
