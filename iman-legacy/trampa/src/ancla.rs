use pinocchio::{account_info::AccountInfo, program_error::ProgramError};
use crate::error::TrampaError;

// Pyth V1 PriceAccount layout:
//   offset 20:  i32 exponent (header)
//   offset 208: i64 price (agg.price)
//   offset 216: u64 conf  (agg.conf)
//   offset 224: u32 agg.status (NOT exponent)
pub fn read_oracle_price(oracle: &AccountInfo) -> Result<u64, ProgramError> {
    let data = oracle.try_borrow_data()?;
    if data.len() < 228 {
        return Err(TrampaError::InvalidOracle.into());
    }
    let price_raw = i64::from_le_bytes(data[208..216].try_into().unwrap());
    let exponent  = i32::from_le_bytes(data[20..24].try_into().unwrap());
    if price_raw <= 0 {
        return Err(TrampaError::InvalidOracle.into());
    }
    // Scale to 6 decimal places
    let adj_exp = 6i32 + exponent; // e.g. 6 + (-8) = -2
    let scaled: u64 = if adj_exp >= 0 {
        (price_raw as u64)
            .checked_mul(10u64.pow(adj_exp as u32))
            .ok_or(ProgramError::ArithmeticOverflow)?
    } else {
        let divisor = 10u64.pow((-adj_exp) as u32);
        (price_raw as u64) / divisor
    };
    Ok(scaled)
}

pub fn compute_twap(price_history: &[u64; 64]) -> u64 {
    let sum: u64 = price_history.iter().sum();
    sum / 64
}

/// Pool price in 6-dec units: (reserve_b / 10^mintB) / (reserve_a / 10^mintA) × 1e6
/// = reserve_b × 10^(mintA + 6 - mintB) / reserve_a
/// mint_a_decimals=0 → legacy 9 dec; mint_b_decimals=0 → legacy 6 dec
pub fn compute_pool_price(reserve_a: u64, reserve_b: u64, mint_a_decimals: u8, mint_b_decimals: u8) -> u64 {
    if reserve_a == 0 { return 0; }
    let exp_a  = if mint_a_decimals == 0 { 9i32 } else { mint_a_decimals as i32 };
    let exp_b  = if mint_b_decimals == 0 { 6i32 } else { mint_b_decimals as i32 };
    let net    = exp_a + 6 - exp_b;
    if net >= 0 {
        reserve_b.saturating_mul(10u64.pow(net as u32)) / reserve_a
    } else {
        reserve_b / (10u64.pow((-net) as u32).saturating_mul(reserve_a))
    }
}

/// Divergence in bps between two prices (absolute)
pub fn compute_divergence_bps(price_a: u64, price_b: u64) -> u64 {
    divergence_bps(price_a, price_b)
}
pub fn divergence_bps(price_a: u64, price_b: u64) -> u64 {
    if price_b == 0 { return 10_000; }
    let diff = if price_a > price_b { price_a - price_b } else { price_b - price_a };
    diff.saturating_mul(10_000) / price_b
}

/// PROPINA: fee = max(spot_div, twap_div) * propina_pct / 10000
/// propina_pct=7500 means 75%
pub fn compute_propina_fee(
    oracle_price: u64,
    pool_price: u64,
    twap_price: u64,
    trade_amount: u64,
    propina_pct: u16,
) -> u64 {
    let spot_div = divergence_bps(oracle_price, pool_price);
    let twap_div = divergence_bps(oracle_price, twap_price);
    let effective_div = spot_div.max(twap_div);
    // fee_bps = effective_div * propina_pct / 10000
    let fee_bps = effective_div
        .saturating_mul(propina_pct as u64)
        / 10_000;
    trade_amount.saturating_mul(fee_bps) / 10_000
}

/// LATIDO: true if we are in a zero-fee rebalancing window
pub fn is_latido_window(
    current_slot: u64,
    last_latido_slot: u64,
    unix_timestamp: i64,
    interval_min: u64,
    interval_max: u64,
    window: u64,
) -> bool {
    if interval_max <= interval_min { return false; }
    let range = interval_max - interval_min;
    let entropy = (unix_timestamp as u64).wrapping_rem(range);
    let interval = interval_min.saturating_add(entropy);
    let slots_since = current_slot.saturating_sub(last_latido_slot);
    slots_since > interval && slots_since <= interval.saturating_add(window)
}

/// Constant product AMM: compute amount_out given amount_in
/// k = reserve_a * reserve_b
pub fn cpamm_out(reserve_in: u64, reserve_out: u64, amount_in: u64) -> Result<u64, ProgramError> {
    let new_reserve_in = reserve_in
        .checked_add(amount_in)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    // amount_out = reserve_out - k / new_reserve_in
    let k = (reserve_in as u128)
        .checked_mul(reserve_out as u128)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    let new_reserve_out = k
        .checked_div(new_reserve_in as u128)
        .ok_or(ProgramError::from(TrampaError::InsufficientLiquidity))?;
    let amount_out = (reserve_out as u128)
        .checked_sub(new_reserve_out)
        .ok_or(ProgramError::from(TrampaError::InsufficientLiquidity))?;
    Ok(amount_out as u64)
}
