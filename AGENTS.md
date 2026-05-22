# RedemptionArc Agent Rules

RedemptionArc is a new project. It must not use Kimi/DOCTORKIMI wallets, UNDERWHEEL wallets, or historical treasury balances as profit.

Hard boundaries:

- No live transaction unless `ALLOW_LIVE=true`, `DRY_RUN=false`, an exact no-send receipt exists, and Velon explicitly approves the exact transaction plan.
- Never print private keys or keypair JSON.
- Never count HOP/custom/Token-2022 balances as profit until settled into wallet-controlled SOL or USDC.
- Never count self-funded preload, ghost residual, owned-vault drain, or one-time rent close as recurring loop profit.
- Cash proof is only wallet spendable SOL + USDC after all costs.
- Kimi wallets are forbidden inputs. The code must fail fast if any configured wallet equals a forbidden wallet.
- Commit each meaningful project advance before moving to the next module.
- Keep receipts and docs updated with every new gate/planner result.

Forbidden Kimi/legacy wallets:

- `FvkP2XzbCK6PspjhZ44sae5vbQPZQGmVkCv1dUC2pAZ9`
- `FdpruPJgPzyNefSxkU5JqifteeDPqwZPfBzcmNb7NNxY`
- `FVxMBHVbyPqqo6ANaY4RM1h7JBJaRHuPTF9XehwaWztp`
- `7Wg8aXuPijrmH4svDmqArMeMAWF3ZusgrznJ6ymprBAN`

Initial objective:

```text
new wallets
-> deterministic cash source
-> no-send exact transaction receipt
-> spendable SOL/USDC after > before
-> only then live approval
```

Current operating directive:

```text
LEDGER_MODE=treasury
target first aggressive profile: 25 USD/cycle
required crank float: 0.443596051 SOL
no live send until exact TX0/TX2/TX3 simulation receipt exists
```
