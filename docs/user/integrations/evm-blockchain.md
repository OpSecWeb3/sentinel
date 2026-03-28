# EVM blockchain integration

This guide explains how to connect Sentinel to an EVM-compatible blockchain network and configure contract monitoring. After completing this setup, Sentinel can detect smart contract events, function calls, balance changes, and contract storage mutations in real time.

## What Sentinel monitors on EVM chains

Sentinel's chain module supports the following detection types:

- **Event match** (`chain.event_match`): Alerts when a smart contract emits a log matching an ABI event signature and optional field conditions.
- **Function call match** (`chain.function_call_match`): Alerts when a transaction calls a specific function on a monitored contract, with optional conditions on decoded arguments.
- **Windowed count** (`chain.windowed_count`): Alerts when a specific event occurs more than a threshold number of times within a rolling time window.
- **Windowed spike** (`chain.windowed_spike`): Alerts when an event's rate spikes significantly above a historical baseline.
- **Windowed sum** (`chain.windowed_sum`): Alerts when the sum of a numeric event argument exceeds a threshold within a rolling time window.
- **Balance tracking** (`chain.balance_track`): Alerts when a contract or wallet balance crosses a threshold, drops or rises by a percentage, or changes within a time window. Supports both native ETH and ERC-20 token balances.
- **State polling** (`chain.state_poll`): Alerts when a contract storage slot value changes, crosses a threshold, or deviates from a rolling average.
- **View call** (`chain.view_call`): Monitors the return value of a read-only contract function at each poll interval. Supports dynamic argument tokens (`$NOW`, `$BLOCK_NUMBER`, `$BLOCK_TIMESTAMP`) and automatic UDVT (User-Defined Value Type) signature normalization.

## Prerequisites

- An RPC endpoint URL for the EVM network you want to monitor. This can be a self-hosted node or a hosted provider such as Infura, Alchemy, or QuickNode. HTTPS is required; HTTP is accepted but logged as a warning.
- An Etherscan (or compatible block explorer) API key if you want Sentinel to automatically fetch contract ABIs by address.
- The **admin** role in your Sentinel organization.

> **Note:** RPC providers impose rate limits. Sentinel batches block polling and processes events efficiently, but you should use a paid RPC plan for production monitoring of high-throughput networks.

## Step 1: Add a blockchain network

1. In Sentinel, navigate to **Settings** and select **Chain Networks**.
2. Click **Add Network**.
3. Enter the following details:
   - **Network name**: A human-readable label, for example `Ethereum Mainnet` or `Polygon Mainnet`.
   - **Network slug**: A URL-safe identifier, for example `ethereum-mainnet`. This is used internally to reference the network.
   - **Chain ID**: The EVM chain ID integer. Common values: Ethereum Mainnet `1`, Goerli `5`, Polygon `137`, Arbitrum One `42161`, Base `8453`.
   - **RPC URLs**: One or more HTTPS endpoint URLs. Sentinel supports multiple RPC URLs for automatic failover -- if the primary URL fails, requests are retried against the next URL in the list.
   - **Block explorer API key** (optional): An Etherscan-compatible API key for automatic ABI lookups.
4. Click **Save**. Sentinel begins polling the latest block number to verify connectivity.

### RPC URL security

Sentinel validates all RPC URLs before use:

- URLs must use the HTTPS protocol. HTTP is accepted but generates a security warning.
- URLs targeting private or internal IP addresses (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, link-local, and reserved ranges) are rejected.
- URLs targeting `localhost`, `.internal`, `.local`, `.lan`, `.corp`, `.home`, `.intranet`, and the cloud metadata endpoint (`169.254.169.254`) are rejected.

> **Warning:** Sentinel performs hostname-level SSRF validation but cannot prevent DNS rebinding attacks where a public hostname resolves to a private IP at connection time. Your infrastructure team should configure egress firewall rules to block outbound connections to RFC-1918 and link-local CIDR ranges.

### RPC URL rotation

When you configure multiple RPC URLs, Sentinel uses round-robin rotation based on the current hour. The rotation window is configurable via the `RPC_ROTATION_HOURS` environment variable. If the primary URL fails a request, Sentinel automatically fails over to the next URL.

### RPC client configuration

The RPC client supports the following options:

| Option | Default | Description |
|---|---|---|
| Max retries | 3 | Maximum number of retry attempts per RPC call |
| Retry delay | 1000 ms | Base delay for exponential backoff between retries |
| Request timeout | 15000 ms | Timeout per individual RPC request |
| Rotation window | Configurable | Hours between primary URL rotation |

## Step 2: Add a contract to monitor

Before you can create event-match or function-call detections, add the contract to Sentinel's monitoring list.

1. Navigate to the chain module's contract management page.
2. Click **Add Contract**.
3. Enter the following:
   - **Network**: Select the network you added in Step 1.
   - **Contract address**: The checksummed or lowercase hex address, for example `0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045`.
   - **Label** (optional): A human-readable name, for example `Gnosis Safe - Treasury`.
   - **ABI**: If you provided an Etherscan API key and the contract is verified, Sentinel fetches the ABI automatically. Otherwise, paste the contract ABI JSON.
4. Click **Save**.

> **Note:** Sentinel does not backfill historical blocks by default. Monitoring starts from the block at which you add the contract.

### Contract verification via Etherscan

When you add a contract address and an Etherscan API key is configured for the network, Sentinel:

1. Queries the Etherscan API for the verified contract ABI.
2. Stores the ABI for decoding event logs and function call data.
3. Detects contract traits (proxy patterns, multisig patterns, token interfaces) from the ABI to suggest relevant detection templates.

If the contract is not verified on Etherscan, you must paste the ABI manually.

## Step 3: How block polling works

Sentinel uses a poll-based architecture for blockchain monitoring:

1. A **block poll** job runs on a scheduled interval for each monitored network. It fetches the latest block number from the RPC endpoint and compares it to the stored cursor position.
2. For each new block, Sentinel fetches logs (event emissions) and optionally full transaction data.
3. Each block's data is enqueued as a **block process** job.
4. The block cursor is advanced only after all block data jobs are successfully enqueued, preventing data loss on failure.
5. Block process jobs match logs against active detection rules, decode event arguments using the stored ABI, and create platform events for matched conditions.

## Available detection types

### Event match

Alerts immediately when a contract emits a log matching the specified event signature. You can add field-level conditions on decoded event arguments using the operators `eq`, `neq`, `gt`, `lt`, `gte`, `lte`, `contains`, and `not_contains`.

| Field | Description |
|---|---|
| Network | The blockchain network to monitor |
| Contract | The contract address to filter events by (leave blank for all contracts) |
| Event signature | ABI event signature, for example `Transfer(address,address,uint256)` |
| Conditions | Optional field conditions on decoded event arguments |

### Function call match

Alerts when a transaction calls a specific function on a monitored contract. The contract address is required.

| Field | Description |
|---|---|
| Network | The blockchain network to monitor |
| Contract | Required: the contract address receiving the function call |
| Function signature | ABI function signature, for example `transfer(address,uint256)` |
| Conditions | Optional field conditions on decoded function arguments |

### Windowed count

Alerts when the specified event occurs at or above a threshold within a rolling time window.

| Field | Description |
|---|---|
| Event signature | ABI event signature to count |
| Time window (ms) | Rolling window duration |
| Alert threshold | Alert when count reaches this value |
| Group by field | Optional: count separately per value of a decoded argument |

### Windowed spike

Alerts when the event rate in the observation window significantly exceeds the historical baseline rate.

| Field | Description |
|---|---|
| Event signature | ABI event signature to track |
| Observation window (ms) | Recent window to compare against baseline |
| Baseline window (ms) | Historical window to establish normal rate |
| Rate increase % | Percentage increase required to trigger |
| Minimum baseline count | Skip alert if baseline has fewer events |

### Balance tracking

Alerts when a wallet or contract balance meets a condition. Supports native ETH balances and ERC-20 token balances via the `tokenAddress` configuration field.

| Field | Description |
|---|---|
| Address | The address to track |
| Token address | Optional: ERC-20 token contract address. Leave blank for native balance. |
| Condition type | `percent_change`, `threshold_above`, or `threshold_below` |
| Threshold / percent | Amount in wei, or a percentage value |
| Window (ms) | Look-back window for `percent_change` |
| Bidirectional | For `percent_change`: also alert on rises, not only drops |

### State polling

Alerts when a contract storage slot value meets a condition. Snapshots are retained per rule, up to a maximum of 500, to support rolling-window calculations.

| Field | Description |
|---|---|
| Contract | The contract address to poll |
| Storage slot | The hex-encoded storage slot to monitor |
| Condition type | `changed`, `threshold_above`, `threshold_below`, or `windowed_percent_change` |
| Percent threshold | Required for `windowed_percent_change` |
| Window size | Number of historical snapshots for rolling mean. Max: 500 |

### View call

Monitors the return value of a read-only contract function. Supports dynamic argument tokens:

| Token | Resolved to |
|---|---|
| `$NOW` | Current Unix timestamp (seconds) |
| `$BLOCK_NUMBER` | Latest block number |
| `$BLOCK_TIMESTAMP` | Timestamp of the latest block |

## Understanding blockchain event types

Sentinel generates the following platform event types from blockchain data:

| Event type | Trigger |
|---|---|
| `chain.event.matched` | A log matched an event-match rule |
| `chain.function_call.matched` | A transaction matched a function-call rule |
| `chain.state.changed` | A storage slot or balance value triggered an alert condition |
| `chain.block.processed` | Summary event after processing a block (for windowed aggregation) |

## Example: Monitoring a Gnosis Safe for owner changes

1. **Add the network**: Add Ethereum Mainnet (chain ID `1`) with your Infura or Alchemy RPC URL.
2. **Add the contract**: Add the Gnosis Safe address. Sentinel fetches the ABI from Etherscan if an API key is configured.
3. **Create event match detections** for the following signatures:
   - `AddedOwner(address)` -- severity: Critical
   - `RemovedOwner(address)` -- severity: Critical
   - `ChangedThreshold(uint256)` -- severity: High

## Rate limits and RPC usage

Sentinel tracks RPC call metrics internally. Be aware of the following when configuring your integration:

| Provider | Free tier limit | Recommended plan |
|---|---|---|
| Infura | 100,000 requests/day | Growth or Team |
| Alchemy | 300 million CU/month | Growth |
| QuickNode | 10 million credits/month | Build or Scale |

Sentinel makes one `eth_blockNumber` call per poll interval plus `eth_getLogs` calls per monitored address range per block. Balance tracking and state polling rules add `eth_getBalance`, `eth_getStorageAt`, and `eth_call` requests.

The Etherscan free tier allows 5 calls per second. Sentinel queries Etherscan only during contract ABI lookups, not during ongoing monitoring.

## Troubleshooting

### RPC connection fails

- Verify the RPC URL is correct and uses HTTPS.
- Confirm the URL is not blocked by your network's egress firewall.
- Test the endpoint directly with a `curl` command: `curl -X POST -H "Content-Type: application/json" --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' <your-rpc-url>`.

### Sentinel falls behind on blocks

- Your RPC provider's rate limit may be too low. Upgrade to a higher-tier plan.
- Add a second RPC URL for failover to distribute load.
- Reduce the number of monitored contracts if possible.

### No events are matched despite active rules

- Confirm the event signature in the rule matches the contract's ABI exactly.
- Verify the contract address is correct and lowercase.
- Check whether the contract has emitted the target event recently using a block explorer.
