# Redemption Pinocchio Arc

Low-CU callback target for RedemptionArc.

## V0 Goal

V0 is deliberately tiny:

```text
ping / read-only callback
-> compile SBF
-> deploy only after explicit approval
-> measure CU baseline
```

Only after the CU baseline is proven do we move route instructions here:

```text
Marginfi flash begin
-> Pinocchio callback
-> Token-2022 hop transfer/settlement CPI
-> cash sweep
-> Marginfi flash end
```

## Why Pinocchio

Pinocchio replaces the heavier Solana/Anchor program stack with a `no_std`
entrypoint and zero-allocation parsing. This matters only if the remaining edge
is compute/packing. It does not replace the need for a positive cash source.

## Local Toolchain Blocker

This machine currently has Solana CLI but no `rustc`, `cargo`, `rustup`, or
`anchor`. The source is scaffolded so the next environment step is explicit:

```bash
rustup toolchain install stable
cargo build-sbf --manifest-path programs/pinocchio-arc/Cargo.toml
```

