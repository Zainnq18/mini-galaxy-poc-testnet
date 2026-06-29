# Mini Galaxy POC Testnet Migration Guide

This guide migrates the existing local two-terminal setup to a live testnet setup without changing the visible web app flow.

## Final target

Current local setup:

```text
Terminal 1: npm run chain
Terminal 2: npm run frontend
```

Live setup:

```text
Polygon Amoy testnet replaces Terminal 1.
Render hosted relayer replaces the local relayer terminal.
Vercel hosted frontend replaces the local browser dev server.
```

Your laptop is not needed after deployment.

## What was added

No UI files were redesigned. The app screens, buttons, routes, and workflows remain the same.

Added under-the-hood pieces:

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

Changed under-the-hood files:

```text
hardhat.config.js
shared/networkConfig.js
relayer/server.js
frontend/src/services/wallet.js
frontend/src/reownConfig.js
package.json
.gitignore
```

## Why DeploymentRegistry was added

The hosted relayer needs to remember which voting contracts are live. The current local version writes contract addresses into JSON files. That works locally, but Render's free service filesystem is temporary. If the backend sleeps, restarts, or redeploys, runtime file changes can disappear.

The new `DeploymentRegistry` contract stores the latest live contract addresses on Polygon Amoy itself. That means:

```text
Admin deploys voting event from same UI
        ↓
Relayer deploys AccessList, CompanyToken, ProxyVoting
        ↓
Relayer writes latest addresses into DeploymentRegistry on Amoy
        ↓
If Render restarts, relayer reloads addresses from DeploymentRegistry
```

This avoids paid databases and avoids paid persistent disks.

---

# Phase 1 — Prepare the project folder

## 1.1 Unzip the project

Create a folder on your machine, for example:

```text
Desktop/mini-galaxy-poc-testnet
```

Extract this ZIP there.

## 1.2 Confirm these files exist

At the root of the folder, confirm you can see:

```text
package.json
hardhat.config.js
contracts/
frontend/
relayer/
scripts/
TESTNET_MIGRATION_GUIDE.md
.env.amoy.example
.env.render.example
.env.vercel.example
```

## 1.3 Do not add these files to GitHub

Never upload these:

```text
.env
.env.* with real secrets
node_modules/
artifacts/
cache/
dist/
```

The `.gitignore` already blocks them.

---

# Phase 2 — Create the testnet relayer/deployer wallet

Use one fresh wallet for this POC.

For this specific app, the deployer wallet must also be the relayer wallet because the contracts use owner-only admin actions. If you use different wallets, deployment may work but admin actions like import register, finalize record date, and close voting can fail.

## 2.1 Create a fresh MetaMask wallet/account

1. Open MetaMask.
2. Create a new account.
3. Name it:

```text
Mini Galaxy Testnet Relayer
```

4. Export its private key.
5. Save the private key temporarily in a secure note only for setup.
6. Do not use this wallet for real money.
7. Do not use your personal wallet.
8. Do not use any Broadridge production wallet.

## 2.2 Add Polygon Amoy network to MetaMask

Use these details:

```text
Network name: Polygon Amoy
RPC URL: https://polygon-amoy.drpc.org
Chain ID: 80002
Currency symbol: POL
Block explorer: https://amoy.polygonscan.com
```

## 2.3 Fund the relayer wallet with free Amoy POL

The relayer wallet needs test POL to pay gas for:

```text
1. DeploymentRegistry deployment
2. Admin event deployment
3. Import register
4. Finalize record date
5. Gasless vote relays
6. Delegation relays
7. Closing voting
```

Use the Polygon faucet first:

```text
https://faucet.polygon.technology
```

If that does not work, use another Amoy faucet your company allows. You only need testnet POL, not real POL.

Minimum recommended test balance for smooth demo:

```text
0.5 Amoy POL or more
```

More is better for repeated deployments.

---

# Phase 3 — Push code to GitHub

Vercel and Render both work best by connecting to a GitHub repository.

## 3.1 Create a GitHub repository

1. Open GitHub.
2. Click `New repository`.
3. Repository name:

```text
mini-galaxy-poc-testnet
```

4. Set visibility to `Private` if this is company/demo code.
5. Do not initialize with README because this project already has files.
6. Click `Create repository`.

## 3.2 Upload/push the code

Use whichever method you are comfortable with.

### Option A — GitHub Desktop

1. Open GitHub Desktop.
2. Click `File > Add Local Repository`.
3. Select the extracted `mini-galaxy-poc-testnet` folder.
4. If asked to create a repository from this folder, accept.
5. Commit all files.
6. Publish repository.

### Option B — Command line

From inside the project folder:

```bash
git init
git add .
git commit -m "Add Polygon Amoy hosted testnet migration"
git branch -M main
git remote add origin https://github.com/YOUR_ORG_OR_USER/mini-galaxy-poc-testnet.git
git push -u origin main
```

Before pushing, confirm this command does not show `.env`:

```bash
git status
```

---

# Phase 4 — Deploy the on-chain registry

This is a one-time setup step. It creates the small contract that remembers the latest voting-event deployment.

There are two ways. Use Option A if your laptop can access the Amoy RPC. Use Option B if company network blocks RPC access.

## Option A — Deploy registry from your laptop

### 4A.1 Install dependencies

From the project root:

```bash
npm install
```

### 4A.2 Create local `.env`

Copy:

```text
.env.amoy.example
```

Rename the copy to:

```text
.env
```

Fill these values:

```env
RPC_URL=https://polygon-amoy.drpc.org
POLYGON_AMOY_RPC_URL=https://polygon-amoy.drpc.org
DEPLOYER_PRIVATE_KEY=your_fresh_testnet_private_key
RELAYER_PRIVATE_KEY=your_same_fresh_testnet_private_key
```

Set strong passwords too:

```env
SESSION_SECRET=some_long_random_sentence
ADMIN_PASSWORD=your_admin_password
ISSUER_PASSWORD=your_issuer_password
TRANSFER_AGENT_PASSWORD=your_transfer_agent_password
INSPECTOR_PASSWORD=your_inspector_password
SOLICITOR_PASSWORD=your_solicitor_password
```

Leave this blank for now:

```env
DEPLOYMENT_REGISTRY_ADDRESS=replace_after_registry_deploy
```

### 4A.3 Check config

Run:

```bash
npm run check:testnet
```

Expected output should include:

```text
Configured network: Polygon Amoy (80002)
RPC chain ID: 80002
Relayer wallet: 0x...
Relayer balance: ... POL
```

If balance is `0`, fund the wallet before continuing.

### 4A.4 Deploy registry

Run:

```bash
npm run deploy:registry:amoy
```

Expected output ends with:

```text
DEPLOYMENT_REGISTRY_ADDRESS=0x...
```

Copy that `0x...` address.

### 4A.5 Put registry address into `.env`

Open `.env` and replace:

```env
DEPLOYMENT_REGISTRY_ADDRESS=replace_after_registry_deploy
```

with:

```env
DEPLOYMENT_REGISTRY_ADDRESS=0xYourRegistryAddress
```

## Option B — Deploy registry using GitHub Actions

Use this if your company network blocks the RPC.

### 4B.1 Add GitHub secrets

In your GitHub repository:

1. Go to `Settings`.
2. Go to `Secrets and variables`.
3. Click `Actions`.
4. Click `New repository secret`.
5. Add this secret:

```text
Name: POLYGON_AMOY_RPC_URL
Value: https://polygon-amoy.drpc.org
```

6. Click `New repository secret` again.
7. Add this secret:

```text
Name: DEPLOYER_PRIVATE_KEY
Value: your_fresh_testnet_private_key
```

Do not add the private key as a normal variable. It must be a secret.

### 4B.2 Run the workflow

1. Go to the `Actions` tab.
2. Click `Deploy Polygon Amoy Deployment Registry`.
3. Click `Run workflow`.
4. Select branch `main`.
5. Click the green `Run workflow` button.

### 4B.3 Copy the registry address

1. Open the completed workflow run.
2. Open the `Deploy registry to Polygon Amoy` step.
3. Find:

```text
DEPLOYMENT_REGISTRY_ADDRESS=0x...
```

4. Copy the `0x...` address.

---

# Phase 5 — Deploy the backend relayer on Render

This replaces your local `relayer/server.js` terminal.

## 5.1 Create the Render service

1. Open Render.
2. Click `New +`.
3. Click `Web Service`.
4. Connect your GitHub account if Render asks.
5. Select your `mini-galaxy-poc-testnet` repository.
6. Use these settings:

```text
Name: mini-galaxy-relayer
Runtime: Node
Branch: main
Root Directory: leave blank
Build Command: npm install && npm run compile
Start Command: npm run relayer
Instance Type: Free
```

Do not choose Static Site for the backend. This must be a Web Service.

## 5.2 Add Render environment variables

In the Render service creation screen, add these exactly.

```env
NODE_VERSION=20
NETWORK_NAME=Polygon Amoy
CHAIN_ID=80002
CURRENCY_SYMBOL=POL
BLOCK_EXPLORER_URL=https://amoy.polygonscan.com
RPC_URL=https://polygon-amoy.drpc.org
POLYGON_AMOY_RPC_URL=https://polygon-amoy.drpc.org
HARDHAT_DEPLOY_NETWORK=polygonAmoy
DEPLOYER_PRIVATE_KEY=your_fresh_testnet_private_key
RELAYER_PRIVATE_KEY=your_same_fresh_testnet_private_key
DEPLOYMENT_REGISTRY_ADDRESS=your_registry_contract_address
SESSION_SECRET=your_long_random_session_secret
ADMIN_PASSWORD=your_admin_password
ISSUER_PASSWORD=your_issuer_password
TRANSFER_AGENT_PASSWORD=your_transfer_agent_password
INSPECTOR_PASSWORD=your_inspector_password
SOLICITOR_PASSWORD=your_solicitor_password
```

Important:

```text
Do not add VITE_ variables to Render.
Do not put private keys in Vercel.
Only Render gets private keys.
```

## 5.3 Deploy backend

1. Click `Create Web Service`.
2. Wait for build to complete.
3. At the end, Render should show `Live`.

## 5.4 Copy backend URL

It will look like:

```text
https://mini-galaxy-relayer.onrender.com
```

Copy it.

## 5.5 Test backend health

Open this in your browser:

```text
https://YOUR_RENDER_BACKEND.onrender.com/api/health
```

Expected JSON:

```json
{
  "ok": true,
  "relayer": "0x...",
  "network": {
    "name": "Polygon Amoy",
    "chainId": 80002
  },
  "deployNetworkName": "polygonAmoy",
  "deploymentRegistry": "0x...",
  "block": 123456
}
```

If the first request is slow, that is normal on Render free services. Wait for it to wake up.

---

# Phase 6 — Deploy the frontend on Vercel

This replaces your local Vite browser server.

## 6.1 Create Vercel project

1. Open Vercel.
2. Click `Add New`.
3. Click `Project`.
4. Import your GitHub repository.
5. Use these settings:

```text
Framework Preset: Vite
Root Directory: leave blank
Build Command: npm run build
Output Directory: dist
Install Command: npm install
```

## 6.2 Add Vercel environment variables

Add these exactly:

```env
VITE_RELAYER_URL=https://YOUR_RENDER_BACKEND.onrender.com
VITE_CHAIN_ID=80002
VITE_CHAIN_ID_HEX=0x13882
VITE_CHAIN_NAME=Polygon Amoy
VITE_RPC_URL=https://polygon-amoy.drpc.org
VITE_NATIVE_CURRENCY_NAME=POL
VITE_NATIVE_CURRENCY_SYMBOL=POL
VITE_BLOCK_EXPLORER_URL=https://amoy.polygonscan.com
VITE_REOWN_PROJECT_ID=b56e18d47c72ab683b10814fe9495694
```

Important:

```text
Never add RELAYER_PRIVATE_KEY to Vercel.
Never add DEPLOYER_PRIVATE_KEY to Vercel.
Vercel is frontend only.
```

## 6.3 Deploy frontend

1. Click `Deploy`.
2. Wait until Vercel says deployment completed.
3. Copy the Vercel URL.

It will look like:

```text
https://mini-galaxy-poc-testnet.vercel.app
```

---

# Phase 7 — First live event deployment

Now use the live frontend. Do not run `npm run chain`. Do not run `npm run frontend`.

## 7.1 Open frontend

Open:

```text
https://YOUR_VERCEL_FRONTEND.vercel.app
```

## 7.2 Open admin route

Go to:

```text
https://YOUR_VERCEL_FRONTEND.vercel.app/admin
```

## 7.3 Login as admin

Use the `ADMIN_PASSWORD` you set in Render.

## 7.4 Deploy event

Use the same form as before:

```text
Issuer
Event title
Event code
Token name
Token symbol
Quorum bps
Voting opens
Voting closes
Proposal(s)
```

Click:

```text
Deploy event
```

Expected behavior:

```text
1. Render backend compiles if needed.
2. Render backend deploys AccessList, CompanyToken, ProxyVoting to Polygon Amoy.
3. Render backend saves latest addresses to DeploymentRegistry.
4. UI shows deployed status.
```

This can take longer than local Hardhat. Do not click repeatedly.

## 7.5 Confirm backend sees deployment

Open:

```text
https://YOUR_RENDER_BACKEND.onrender.com/api/config
```

Expected:

```json
{
  "deployed": true,
  "network": {
    "name": "Polygon Amoy",
    "chainId": 80002
  },
  "contracts": {
    "accessList": "0x...",
    "zynToken": "0x...",
    "voting": "0x..."
  }
}
```

---

# Phase 8 — Finalize record date

## 8.1 Open transfer agent route

Go to:

```text
https://YOUR_VERCEL_FRONTEND.vercel.app/transfer-agent
```

## 8.2 Login

Use the `TRANSFER_AGENT_PASSWORD` you set in Render.

## 8.3 Import register if needed

The default register uses the same five demo wallets as the local version.

If you want your team members to use their own MetaMask wallets instead, replace the CSV rows with their wallet addresses before clicking `Import register`.

## 8.4 Finalize record date

Click:

```text
Finalize record date
```

Expected:

```text
1. Relayer pays gas.
2. Token entitlements are minted.
3. Record-date snapshot is created.
4. Investors can vote if voting window is open.
```

---

# Phase 9 — Team testing

Give testers only these things:

```text
1. Frontend URL
2. Which demo wallet to import, or their own wallet instructions
3. Basic MetaMask setup steps
4. Their role password only if they are testing an operations role
```

Do not give testers:

```text
Relayer private key
GitHub secrets
Render password
Vercel password
Deployment registry owner wallet
```

Use:

```text
docs/TEAM_TESTER_ONE_PAGER.md
```

for non-technical tester instructions.

---

# Phase 10 — Recovery guide

## Problem: Frontend shows fetch/network error

Likely cause:

```text
Render backend is asleep or VITE_RELAYER_URL is wrong.
```

Fix:

```text
1. Open https://YOUR_RENDER_BACKEND.onrender.com/api/health
2. Wait for it to wake up.
3. Refresh frontend.
4. If still failing, check Vercel environment variable VITE_RELAYER_URL.
```

## Problem: Backend says RELAYER_PRIVATE_KEY missing

Fix in Render:

```text
1. Open Render service.
2. Go to Environment.
3. Add RELAYER_PRIVATE_KEY.
4. Save and deploy.
```

## Problem: Admin deploy fails with insufficient funds

Cause:

```text
Relayer/deployer wallet has no Amoy POL.
```

Fix:

```text
1. Copy relayer address from /api/health.
2. Fund it with Amoy POL.
3. Retry deployment.
```

## Problem: Admin deploy succeeds but later app says no deployed event

Cause:

```text
DEPLOYMENT_REGISTRY_ADDRESS is wrong or registry save failed.
```

Fix:

```text
1. Check Render env DEPLOYMENT_REGISTRY_ADDRESS.
2. Check it is the registry address printed by deployRegistry.
3. Check the registry was deployed by the same wallet as RELAYER_PRIVATE_KEY.
4. Redeploy backend.
5. If needed, deploy a fresh event from /admin.
```

## Problem: User cannot vote; says selected wallet does not match

Cause:

```text
The connected MetaMask account is not the same wallet in the shareholder register.
```

Fix:

```text
1. Switch MetaMask to the correct demo wallet.
2. Reconnect wallet in the portal.
3. Retry.
```

## Problem: User sees wrong network prompt

Fix:

```text
1. Accept the app's network switch request.
2. Or manually add Polygon Amoy in MetaMask.
3. Refresh the page.
```

## Problem: Render backend sleeps

This is expected on Render Free.

Fix:

```text
1. Open /api/health.
2. Wait for Render to wake up.
3. Refresh frontend.
```

No data should be lost because the important deployment addresses are stored in DeploymentRegistry on-chain.

---

# Phase 11 — Rollback

Your old local app remains safe.

To run locally again:

```bash
npm run chain
npm run frontend
```

To use this POC locally against Amoy:

```bash
copy .env.amoy.example .env
npm install
npm run check:testnet
npm run frontend
```

On Mac/Linux, use:

```bash
cp .env.amoy.example .env
```

---

# Golden rules

```text
Never put private keys in frontend code.
Never put private keys in Vercel.
Never commit .env.
Use one fresh testnet relayer/deployer wallet for this POC.
Keep the current UI untouched.
Use Polygon Amoy only for this free live testnet version.
```
