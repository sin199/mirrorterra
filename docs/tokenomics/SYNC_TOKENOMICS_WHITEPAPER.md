# SYNC Tokenomics Whitepaper v1.0

## Status and scope

This document fixes the monetary rules for the first SYNC genesis on Arc Mainnet (chain ID 5042). The monetary contracts are non-upgradeable. No Creator, resident, issuer, operator, proxy admin, or private key may change these rules after deployment.

The external settlement asset is the project's verified Arc Mainnet USDC contract (`0x3600000000000000000000000000000000000000`, 6 decimals). The genesis deployer does not accept an arbitrary USDC address.

Infrastructure cost recovery is a separate operating concern. AI inference, servers, storage, settlement, hosting, and similar costs may later be charged at actual cost through an independent Infrastructure Treasury. Those charges do not change SYNC supply, reserve releases, epoch quotas, or the market curve.

## Immutable ledger settlement executor

The Genesis deployment atomically creates a non-upgradeable settlement executor. The Operating Pool's only payout caller is that executor. The executor permanently binds one dedicated Turnkey infrastructure ledger signer, the SYNC asset and the Operating Pool. It has no setter, arbitrary call, approval, withdrawal, proxy, upgrade or Creator override. Its EIP-712 authorization binds chain ID, executor contract, payout ID, recipient, amount and asset; each payout ID executes only once. The signer adapter signs only existing committed authoritative economic actions backed by an Operating Pool debit and an equal Agent credit, and rechecks the current registered recipient wallet. The signer is a ledger execution attestor; the chain verifies its signature and cannot independently query PostgreSQL.

This identity is separate from the Creator and all Agents, receives zero Genesis allocation, and is not an issuer or distribution recipient. Neither the signer nor executor can directly release Genesis Reserve or control Protocol Market Pool liquidity. Reserve custody only accepts its immutable Genesis policy contract. Operating Pool refill is permissionless but constrained by the fixed trigger, target and economy epoch quota; no signature can bypass those rules. Ledger authorization does not grant any monetary administration power.

## Genesis supply and allocation

- Fixed total supply: **1,000,000,000 SYNC**.
- Decimals: **6**.
- World Operating Pool at genesis: **10,000,000 SYNC**.
- Genesis Reserve at genesis: **990,000,000 SYNC**.
- Creator initial allocation: **0 SYNC**.
- Genesis Agent initial allocation: **0 SYNC**.
- Initial distribution to Agents and Creator: **empty**.

The invariant is:

```text
10,000,000 Operating Pool
+ 990,000,000 Genesis Reserve
+ 0 Agent/Creator initial distribution
= 1,000,000,000 SYNC
```

No additional SYNC can be minted after genesis. Total supply remains 1,000,000,000 SYNC forever.

## Reserve release epochs

Monetary epochs last 30 days. At the start of each epoch, the protocol snapshots the then-current Genesis Reserve balance. The total gross release ceiling for that epoch is:

```text
EpochReleaseCap = min(10,000,000 SYNC,
                      floor(1% * reserve balance at epoch start))
```

The cap is divided into a 70% economy quota and a 30% external-market quota. Integer rounding is deterministic: economy receives `floor(cap * 70 / 100)` and the market receives the remainder. Unused quota expires at the end of the epoch and never carries forward. Quotas are based on gross reserve releases. SYNC returned to Reserve does not restore quota already used in that epoch.

## World Operating Pool

The Operating Pool target is 10,000,000 SYNC. A refill becomes eligible only when its balance is below 2,500,000 SYNC. A refill moves the balance toward the target, limited by the remaining economy quota for the current epoch and the Reserve balance. No other Reserve-to-Pool path exists.

Operating Pool payouts must originate from the authoritative MirrorTerra economic ledger. Ledger transfers use balanced double-entry postings. Each committed payout has a unique, idempotent outbox record; a settlement worker executes only that committed outbox. No Creator/manual payout path exists. A resident credit must have a corresponding pool debit, counterparty debit, or other conserved source. SYNC is never minted to fund a payout.

An economic action may carry an explicit raw SYNC payout amount. The payout path never derives SYNC from its USDC amount or assumes an exchange rate. Without that explicit field and a verified SYNC deployment, no payout outbox is created.

## Genesis Dutch Auction

The first auction batch is 100,000 SYNC, released from Reserve only as SYNC is sold. Its initial price is a technical ceiling of 0.01 USDC per SYNC and declines as:

```text
price(t) = 0.01 * 2 ^ (-elapsed_seconds / 43,200)
```

The auction ends when the batch sells out or after seven days, whichever happens first. Unsold SYNC stays in Genesis Reserve. The gross amount sold counts against that epoch's 30% market quota. There is no administrator price control.

After the auction, the Protocol Market Pool activates only if at least one SYNC was sold. With no sale (`q0 = 0`), the market remains inactive and its price remains undefined. For a completed auction, `P0` is realized VWAP and `q0` is total SYNC sold.

## Protocol Market Pool

After price discovery, the immutable market curve uses `K = 10,000,000 SYNC`:

```text
P(q) = P0 * (1 + (q - q0) / K)
```

Here `q` is the outstanding market quantity, initialized to `q0`; buys increase it and sells decrease it. `q` can never become negative. Buy and sell settlement use the exact integral of the same curve, with only the required integer rounding for USDC's and SYNC's six-decimal units. A buy may draw SYNC from Genesis Reserve only within the current epoch's remaining market quota. Sold quota is gross and is not restored by later sells.

After the Genesis Dutch Auction, Protocol Market Pool trades charge an immutable **0.5% buy fee** and **0.5% sell fee**. On a buy, the fee is 50 basis points of gross USDC input, rounded down to one USDC base unit; only the remaining net USDC is the bonding-curve input. On a sell, the curve first determines gross USDC output, then the 50-basis-point fee is deducted and the seller receives net USDC. The auction itself is not subject to these fees. No fee is charged on Agent wages, goods or services, business income, internal Agent investment or settlement, Operating Pool payouts, or Creator infrastructure charges.

**SYNC external-market trading fees are protocol-owned liquidity, not operator revenue.** **100% of buy and sell fees remain permanently inside the Protocol Market Pool.** They are neither burned nor distributed, and cannot be withdrawn or redirected to the Creator, issuer, any Agent, Infrastructure Treasury, Operating Pool, Genesis Reserve, or another wallet. The fee rate and fee destination are immutable after Genesis deployment. The contract separately tracks curve-pricing liquidity and accumulated buy/sell fees; both remain protocol-owned and non-withdrawable USDC liquidity in the same pool. There is no hidden spread or administrator-controlled pricing. With no intervening trades, a buy followed by a full sell follows the same mathematical curve; the user's only loss is the two immutable fees and required integer rounding.

MirrorTerra infrastructure charges are separate from SYNC monetary policy. Actual-cost charges for AI inference, servers, storage, hosting, settlement, and similar infrastructure may be set independently in the future and paid into an independent Infrastructure Treasury. They cannot change SYNC release rules or market fees, or draw from Genesis Reserve or Protocol Market Pool.

Before the Genesis Auction has sales and the Protocol Market Pool activates, SYNC market price and market capitalization are undefined. No indicative or fabricated price is exposed.

## Immutable policy boundary

The v1 deployment contains a fixed-supply ERC-20, Genesis Reserve, World Operating Pool, Genesis Dutch Auction, and Protocol Market Pool. These contracts are direct, non-proxy deployments. They have no owner or upgrade route, no post-genesis mint, no admin reserve transfer, no administrator-settable release rate, epoch parameter, pool target, auction price, curve, fee, fee destination, fee exemption, blacklist, whitelist, or Creator-controlled monetary pause. Reserve can be released only by the rules in this document: an eligible Operating Pool refill or a qualifying external-market sale.

The machine-readable immutable parameters are in [`config/sync-genesis-tokenomics.json`](../../config/sync-genesis-tokenomics.json). The canonical manifest hash is computed as Keccak-256 of UTF-8 `JSON.stringify(JSON.parse(manifestFile))`, with no trailing whitespace included. Runtime and deployment artifacts must use that same hash.
