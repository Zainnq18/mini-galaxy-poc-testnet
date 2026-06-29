# Team Tester One-Pager

Use this document for people who only need to test the live portal.

## What you need

```text
1. Portal link from the project owner
2. MetaMask browser extension
3. One demo wallet/private key OR your own wallet address added by the Transfer Agent
```

You do not need gas. The relayer pays gas for voting.

## Step 1 — Open the portal

Open the live Vercel URL shared by the project owner.

Example:

```text
https://mini-galaxy-poc-testnet.vercel.app
```

## Step 2 — Install MetaMask if needed

Install the MetaMask browser extension.

## Step 3 — Add Polygon Amoy when prompted

If the portal or MetaMask asks to switch network, approve it.

Manual network details:

```text
Network name: Polygon Amoy
RPC URL: https://polygon-amoy.drpc.org
Chain ID: 80002
Currency symbol: POL
Block explorer: https://amoy.polygonscan.com
```

## Step 4 — Connect wallet

Click:

```text
Connect wallet
```

Select MetaMask.

## Step 5 — Vote

When the ballot opens:

```text
1. Select choices.
2. Click vote/submit.
3. MetaMask will ask for a signature.
4. Sign the message.
5. Wait for confirmation.
```

This is gasless for you. You sign the ballot, and the relayer submits it.

## Step 6 — Common issues

### It says wrong wallet

Switch MetaMask to the wallet address assigned to you.

### It says view-only

Your wallet may not be in the shareholder register, or record date may not be finalized yet.

### It loads slowly

The free backend may be waking up. Wait and refresh once.

### It asks to add a token

Approve it if you want the demo voting token visible in MetaMask. This is optional for voting.
