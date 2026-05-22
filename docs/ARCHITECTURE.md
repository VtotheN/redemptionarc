# RedemptionArc Architecture

## Lanes

### Lane A: Measurement

Reads only. Builds treasury snapshots and verifies forbidden wallet isolation.

### Lane B: Source Discovery

Finds protocol-paid or authority-owned cash sources:

- Token-2022 withheld fees with a concrete SOL/USDC settlement route.
- LP position fees and rewards controlled by RedemptionArc.
- Referral/integrator fees paid by external orderflow.
- Keeper rewards or protocol incentives.
- One-time salvage, clearly separated from recurring profit.

### Lane C: Cycle Builder

Only after Lane B finds a ready source:

```text
TX0 optional cushion
TX2 source production / claim / settlement
TX3 sweep to treasury
```

Current blocker:

```text
HOP withheld fees exist as non-cash.
Jupiter settlement route: TOKEN_NOT_TRADABLE.
Owned HOP/USDC pool would only move our own USDC unless external orderflow or
protocol-paid rewards fund the USDC side.
```

Therefore `cycle-plan` must stay blocked until one of these is true:

- HOP becomes externally tradable to USDC/SOL with executable route.
- RedemptionArc owns a venue that earns fees in USDC directly from non-self-funded flow.
- A separate protocol-paid source produces USDC/SOL in the same cycle.
- The design changes to a different cash-settled primitive.

See [OWNED-VENUE-SPEC.md](OWNED-VENUE-SPEC.md) for the valid venue design and
the rejected self-funded pool variant.

### Lane D: Keeper

Disabled until:

- preflight passes,
- current-price no-send receipt is positive,
- treasury and crank are RedemptionArc wallets,
- Velon approves exact live plan.
