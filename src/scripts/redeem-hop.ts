/**
 * Execute HOP→USDC redemption via Whirlpool fork settlement.
 * Harvests withheld HOP from ring ATAs → withdraws to crank ataA → swaps HOP→USDC.
 * Run after HOP-REDEEM-PROOF.json confirms simErr=null.
 */
export {};
