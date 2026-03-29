# EVM Blockchain Integration

This guide explains how to connect Sentinel to EVM-compatible blockchain
networks so that Sentinel can monitor on-chain events, state changes, and
contract activity in real time.

## Architecture overview

Sentinel connects to blockchain networks through JSON-RPC endpoints. It polls
for new blocks, decodes contract events, reads storage slots, and tracks
balances. All on-chain data is processed through Sentinel's detection engine
to generate alerts.

## Prerequisites

- A Sentinel account with the **Admin** role in your organization.
- An RPC endpoint for each blockchain network you want to monitor (public or
  dedicated).
- The contract addresses you want to track.

## Adding blockchain networks

Sentinel ships with preconfigured support for common EVM networks. Your
administrator may have already enabled the networks relevant to your
organization.

### Viewing available networks

1. Navigate to **Chain > Networks**.
2. The table shows each network's name, chain ID, current block number,
   polling status, and last polled timestamp.

### Adding a new network (admin only)

1. Navigate to **Chain > Networks**.
2. Click **Add Network**.
3. Fill in:
   - **Name** -- a human-readable name (for example, "Ethereum Mainnet").
   - **Chain ID** -- the EVM chain ID (for example, 1 for Ethereum, 137 for
     Polygon).
   - **Block time (ms)** -- approximate block time in milliseconds (default:
     12,000 for Ethereum).
   - **RPC URL** (optional) -- a default RPC endpoint for the network.
   - **Explorer URL** (optional) -- a block explorer URL (for example,
     `https://etherscan.io`).
4. Click **Create**.

### Configuring custom RPC endpoints

Each organization can override the default RPC endpoint for any network:

1. Navigate to **Chain > RPC**.
2. Click **Add RPC Config**.
3. Select the **Network**.
4. Enter the **RPC URL** (for example,
   `https://eth-mainnet.g.alchemy.com/v2/YOUR-KEY`).
5. Click **Save**.

Custom RPC endpoints are used only by your organization. Other organizations
on the same Sentinel instance use the default or their own custom endpoints.

## Registering contracts for monitoring

### Adding a contract

1. Navigate to **Chain > Contracts**.
2. Click **Add Contract**.
3. Fill in:
   - **Network** -- select the blockchain network.
   - **Address** -- the contract address (for example,
     `0x1234...abcd`). Must be a valid 40-character hex address with `0x`
     prefix.
   - **Label** -- a human-readable name (for example, "USDC Token").
   - **Tags** (optional) -- categorization tags (for example, "defi",
     "treasury").
   - **Notes** (optional) -- free-text notes about the contract.
4. Click **Add**.

Sentinel normalizes the address to lowercase and creates a global contract
record. If the same address is already tracked on the same network (by any
organization), Sentinel reuses the existing record.

### ABI management

Sentinel uses a contract's ABI (Application Binary Interface) to decode
on-chain events and function calls. Without an ABI, event monitoring is
limited to raw log data.

**Automatic ABI fetching:** When you add a contract, Sentinel can
automatically fetch the ABI from the network's block explorer (for example,
Etherscan). Toggle **Fetch ABI** to enable this during contract creation.

**Manual ABI upload:** If the contract is not verified on the block explorer,
you can paste the ABI JSON directly when creating the contract.

**ABI status indicators:**

| Status | Meaning |
|---|---|
| `loaded` | ABI is available; events and functions are decoded. |
| `pending` | ABI fetch is in progress. |
| `missing` | ABI fetch completed but no ABI was found (contract may not be verified). |
| `error` | ABI fetch failed. Try again or upload manually. |

To retry ABI fetching, navigate to the contract detail page and click
**Fetch ABI**.

### Contract detail page

Navigate to **Chain > Contracts** and click a contract to see:

- **ABI Events** -- decoded event signatures (for example,
  `Transfer(address,address,uint256)`).
- **ABI Functions** -- decoded function signatures with state mutability.
- **Linked Detections** -- active detections that reference this contract.
- **Proxy information** -- whether the contract is a proxy and its
  implementation address.
- **Storage layout** -- if available, the contract's storage layout for
  state monitoring.

## What blockchain events Sentinel tracks

Sentinel monitors the following categories of on-chain activity:

### Log events

Sentinel decodes EVM log events emitted by monitored contracts. Common events
include:

- `Transfer(address,address,uint256)` -- token transfers (ERC-20, ERC-721).
- `Approval(address,address,uint256)` -- token approvals.
- `OwnershipTransferred(address,address)` -- ownership changes.
- `Upgraded(address)` -- proxy implementation changes.
- `Paused(address)` / `Unpaused(address)` -- emergency circuit breakers.
- `RoleGranted(bytes32,address,address)` / `RoleRevoked(bytes32,address,address)` -- access control changes.
- `AddedOwner(address)` / `RemovedOwner(address)` -- multisig signer changes.

### State changes

Sentinel polls EVM storage slots and view functions at configurable intervals
to detect state changes that do not emit events:

- Storage slot monitoring (for example, proxy implementation slot changes).
- Balance tracking (native and ERC-20 token balances).
- View function return value monitoring.

### Transaction-level monitoring

- Contract creation by monitored addresses.
- Function call matching by 4-byte selector.

## Available detection templates

Navigate to **Chain > Templates** to see the full list. Sentinel ships with
the following built-in templates:

### Token activity

| Template | Severity | Description |
|---|---|---|
| Large Transfer Monitor | High | Alerts when an ERC-20 transfer exceeds a threshold amount. |
| Repeated Transfer Detector | High | Alerts when the same recipient receives more than N transfers within a time window. |
| Transfer Volume Monitor | High | Alerts when total transferred volume exceeds a threshold within a rolling window. |

### Balance monitoring

| Template | Severity | Description |
|---|---|---|
| Fund Drainage Detection | Critical | Alerts when a contract's balance drops by a percentage within a time window. |
| Balance Low Alert | Medium | Alerts when an address balance falls below a minimum threshold. |
| Balance Tracker | Medium | Alerts on balance changes by percentage, minimum, or maximum threshold. |
| Native Balance Anomaly | High | Alerts when native balance drops by a percentage within a time window. |

### Governance and access control

| Template | Severity | Description |
|---|---|---|
| Contract Ownership Monitor | Critical | Alerts on ownership transfers (Ownable and Ownable2Step). |
| Access-Control Role Change | High | Alerts when AccessControl roles are granted or revoked. |
| Proxy Upgrade Monitor | Critical | Alerts on ERC-1967 Upgraded events. |
| Proxy Upgrade Slot Watcher | Critical | Polls the ERC-1967 implementation storage slot for changes. |
| Multisig Signer Change | High | Alerts when Safe (Gnosis Safe) owners are added or removed. |
| Pause State Monitor | High | Alerts when a contract is paused or unpaused. |

### State monitoring

| Template | Severity | Description |
|---|---|---|
| Storage Anomaly Detector | High | Monitors an EVM storage slot for unexpected changes or threshold crossings. |
| Custom Storage Slot Monitor | Medium | Polls an arbitrary storage slot and alerts on user-defined conditions. |
| Custom View Function Monitor | Medium | Calls a read-only function on a schedule and alerts on return value conditions. |

### Custom

| Template | Severity | Description |
|---|---|---|
| Custom Event Monitor | Medium | Watches for any on-chain event by Solidity signature with optional parameter filters. |
| Custom Function Call Monitor | High | Alerts when a specific function is called by matching the 4-byte selector. |
| Custom Windowed Event Count | Medium | Counts event occurrences within a sliding window and alerts when threshold is exceeded. |
| Activity Spike Detector | High | Alerts when event firing rate increases dramatically compared to a baseline period. |
| Contract Creation Watcher | High | Alerts when a monitored address deploys a new contract. |

### Activating a template

1. Navigate to **Chain > Templates**.
2. Click the template you want to enable.
3. Select the **Network** and **Contract** for monitoring.
4. Configure template-specific inputs (thresholds, time windows, event
   signatures).
5. Optionally assign a notification channel.
6. Click **Create Detection**.

## RPC usage monitoring

Sentinel tracks RPC call volume and error rates per network.

1. Navigate to **Chain > RPC**.
2. The RPC usage dashboard shows:
   - **Total calls** -- aggregate call count over the selected time range.
   - **Error rate** -- percentage of calls that returned errors.
   - **Per-network breakdown** -- call counts and latency per network.

Use the time range filters and network selector to narrow the view. RPC usage
data is aggregated hourly and retained for analysis.

## State polling configuration

For detection templates that poll on-chain state (storage slots, balances,
view functions), you can configure:

- **Poll interval** -- how frequently Sentinel reads the value (minimum:
  10,000 ms). Shorter intervals detect changes faster but consume more RPC
  calls.
- **Alert condition** -- when to fire an alert:
  - **Any change** -- alert on any value change.
  - **Equals value** -- alert when the value equals a specific amount.
  - **Greater than / Less than** -- alert on threshold crossings.
  - **Changes by %** -- alert when the value changes by a percentage.

State polling results are visible on the **Chain > State Changes** page. You
can filter by rule, contract address, snapshot type (balance, storage, or
view-call), and whether the snapshot triggered an alert.

## Troubleshooting

### Contract shows "ABI: pending" indefinitely

The ABI fetch job may be queued behind other work. Try:

1. Navigate to the contract detail page.
2. Click **Fetch ABI** to re-queue the job.
3. If the contract is not verified on the block explorer, upload the ABI
   manually.

### No events appearing for a monitored contract

1. Verify the contract address is correct (check the block explorer).
2. Verify the contract emits the events you expect. Some contracts use
   non-standard event signatures.
3. Confirm the network is actively polling. Navigate to **Chain > Networks**
   and check that **Polling Active** is true and **Current Block** is
   advancing.
4. Check the RPC endpoint health on **Chain > RPC**. High error rates may
   indicate a failing endpoint.

### RPC errors or high latency

1. Verify your RPC endpoint is operational (test with `curl` or an Ethereum
   client).
2. If using a rate-limited public endpoint, switch to a dedicated provider
   (Alchemy, Infura, QuickNode).
3. Update the RPC URL under **Chain > RPC** and Sentinel will use it
   immediately.

### Detection fires too frequently

Adjust the template parameters:

- Increase the **threshold** for transfer amount or event count monitors.
- Increase the **time window** for windowed detections.
- Increase the **poll interval** for state polling detections.
- Add parameter filters to narrow the events that match (for example, filter
  by `from` or `to` address).

### "Unknown network" error when adding a contract

The specified network ID does not exist in Sentinel. Navigate to **Chain >
Networks** and verify the network is registered and active. If it is missing,
ask your Sentinel administrator to add it.
