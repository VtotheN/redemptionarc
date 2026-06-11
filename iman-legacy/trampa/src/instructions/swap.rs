use pinocchio::{
    account_info::AccountInfo,
    instruction::Signer,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};
use pinocchio_token::instructions::Transfer;

use crate::{
    ancla,
    error::TrampaError,
    state::{TrampaPool, TRAMPA_POOL_DISCRIMINATOR},
    PYTH_PROGRAM_ID,
};

/// Instruction data layout (after discriminator byte):
///   [0..8]  amount_in:      u64
///   [8..16] min_amount_out: u64
///   [16]    a_to_b:         u8  (1 = A→B, 0 = B→A)
///
/// Accounts:
///   [0] user           (signer)
///   [1] pool           (writable, PDA)
///   [2] user_token_in  (writable)
///   [3] user_token_out (writable)
///   [4] token_a_vault  (writable)
///   [5] token_b_vault  (writable)
///   [6] oracle         (read, Pyth price account)
///   [7] fee_vault      (writable)
///   [8] token_program  (read)
///   [9] clock_sysvar   (read)
pub fn process(
    _program_id: &Pubkey,
    accounts:    &[AccountInfo],
    data:        &[u8],
) -> ProgramResult {
    if accounts.len() < 10 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() < 17 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let user         = &accounts[0];
    let pool_account = &accounts[1];
    let user_in      = &accounts[2];
    let user_out     = &accounts[3];
    let vault_a      = &accounts[4];
    let vault_b      = &accounts[5];
    let oracle       = &accounts[6];
    let fee_vault    = &accounts[7];
    // accounts[8] = token_program (used implicitly by pinocchio_token CPI)
    let clock_sysvar = &accounts[9];

    // --- Parse instruction data ---
    let amount_in      = u64::from_le_bytes(data[0..8].try_into().unwrap());
    let min_amount_out = u64::from_le_bytes(data[8..16].try_into().unwrap());
    let a_to_b         = data[16] != 0;

    // --- ESCUDO: signer ---
    if !user.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // --- ESCUDO: amount_in > 0 ---
    if amount_in == 0 {
        return Err(TrampaError::ZeroAmount.into());
    }

    // --- Load & validate pool ---
    let pool_data = pool_account.try_borrow_data()?;
    if pool_data.len() < crate::state::TRAMPA_POOL_SIZE {
        return Err(ProgramError::AccountDataTooSmall);
    }
    if &pool_data[0..8] != TRAMPA_POOL_DISCRIMINATOR {
        return Err(TrampaError::InvalidAccountData.into());
    }
    let pool: &TrampaPool =
        bytemuck::from_bytes(&pool_data[8..8 + core::mem::size_of::<TrampaPool>()]);

    // --- ESCUDO: pool active ---
    if pool.is_active == 0 {
        return Err(TrampaError::PoolClosed.into());
    }

    // --- ESCUDO: oracle key ---
    if oracle.key() != &pool.oracle_pubkey {
        return Err(TrampaError::InvalidOracle.into());
    }
    // oracle must be owned by Pyth program OR TRAMPA (synthetic oracle PDA)
    // SAFETY: account_info is a valid pointer provided by the runtime
    {
        let owner = unsafe { oracle.owner() };
        if owner != &PYTH_PROGRAM_ID && owner != _program_id {
            return Err(TrampaError::InvalidOracle.into());
        }
    }

    // --- ESCUDO: vaults match pool state ---
    if vault_a.key() != &pool.token_a_vault {
        return Err(TrampaError::InvalidVault.into());
    }
    if vault_b.key() != &pool.token_b_vault {
        return Err(TrampaError::InvalidVault.into());
    }

    // --- ESCUDO: fee_vault matches ---
    if fee_vault.key() != &pool.fee_vault {
        return Err(TrampaError::InvalidVault.into());
    }

    // Snapshot all needed fields before dropping immutable borrow
    let reserve_a_snap         = pool.reserve_a;
    let reserve_b_snap         = pool.reserve_b;
    let concentrador_range_bps = pool.concentrador_range_bps;
    let propina_pct            = pool.propina_pct;
    let latido_interval_min    = pool.latido_interval_min;
    let latido_interval_max    = pool.latido_interval_max;
    let latido_window          = pool.latido_window;
    let last_latido_slot       = pool.last_latido_slot;
    let price_history_snap     = pool.price_history;
    let price_history_idx_snap = pool.price_history_idx;
    let total_fees_snap        = pool.total_fees_collected;
    let pool_bump              = pool.bump;
    let token_a_mint_key       = pool.token_a_mint;
    let token_b_mint_key       = pool.token_b_mint;
    let mint_a_decimals        = pool.mint_a_decimals;
    let mint_b_decimals        = pool.mint_b_decimals;
    drop(pool_data);

    // --- ANCLA: read oracle price (Pyth PriceFeed v2) ---
    let oracle_price = ancla::read_oracle_price(oracle)?;

    // --- Pool price ---
    let pool_price = ancla::compute_pool_price(reserve_a_snap, reserve_b_snap, mint_a_decimals, mint_b_decimals);

    // --- CONCENTRADOR: reject if diverged beyond range ---
    let divergence = ancla::divergence_bps(oracle_price, pool_price);
    if divergence > concentrador_range_bps as u64 {
        return Err(TrampaError::OutOfConcentratorRange.into());
    }

    // --- Read clock from sysvar account bytes (no syscall, no std) ---
    // Clock layout:
    //   offset  0: slot              (u64)
    //   offset  8: epoch_start_timestamp (i64)
    //   offset 16: epoch             (u64)
    //   offset 24: leader_schedule_epoch (u64)
    //   offset 32: unix_timestamp    (i64)
    let (current_slot, unix_timestamp) = {
        let clock_data = clock_sysvar.try_borrow_data()?;
        if clock_data.len() < 40 {
            return Err(ProgramError::InvalidAccountData);
        }
        let slot      = u64::from_le_bytes(clock_data[0..8].try_into().unwrap());
        let unix_ts   = i64::from_le_bytes(clock_data[32..40].try_into().unwrap());
        (slot, unix_ts)
    };

    // --- LATIDO: check for zero-fee window ---
    let in_latido = ancla::is_latido_window(
        current_slot,
        last_latido_slot,
        unix_timestamp,
        latido_interval_min,
        latido_interval_max,
        latido_window,
    );

    // --- Update price history ring-buffer (using pre-swap pool price) ---
    let mut new_history = price_history_snap;
    let idx             = price_history_idx_snap as usize % 64;
    new_history[idx]    = pool_price;
    let new_idx         = ((price_history_idx_snap as usize + 1) % 64) as u8;

    // --- TWAP ---
    let twap = ancla::compute_twap(&new_history);

    // --- PROPINA fee computation ---
    let fee_tokens: u64 = if in_latido {
        0
    } else {
        ancla::compute_propina_fee(oracle_price, pool_price, twap, amount_in, propina_pct)
    };

    // --- Constant-product AMM (xy=k) ---
    // Determine which vault is in/out and compute gross output
    let (amount_out_gross, new_reserve_a, new_reserve_b, vault_in, vault_out): (
        u64,
        u64,
        u64,
        &AccountInfo,
        &AccountInfo,
    ) = if a_to_b {
        // A → B
        if reserve_a_snap == 0 || reserve_b_snap == 0 {
            return Err(TrampaError::InsufficientLiquidity.into());
        }
        // out = reserve_b * amount_in / (reserve_a + amount_in)
        let denom = reserve_a_snap
            .checked_add(amount_in)
            .ok_or::<ProgramError>(TrampaError::MathOverflow.into())?;
        let out = reserve_b_snap
            .checked_mul(amount_in)
            .ok_or::<ProgramError>(TrampaError::MathOverflow.into())?
            .checked_div(denom)
            .ok_or::<ProgramError>(TrampaError::InsufficientLiquidity.into())?;
        let new_a = reserve_a_snap
            .checked_add(amount_in)
            .ok_or::<ProgramError>(TrampaError::MathOverflow.into())?;
        let new_b = reserve_b_snap
            .checked_sub(out)
            .ok_or::<ProgramError>(TrampaError::InsufficientLiquidity.into())?;
        (out, new_a, new_b, vault_a, vault_b)
    } else {
        // B → A
        if reserve_a_snap == 0 || reserve_b_snap == 0 {
            return Err(TrampaError::InsufficientLiquidity.into());
        }
        // out = reserve_a * amount_in / (reserve_b + amount_in)
        let denom = reserve_b_snap
            .checked_add(amount_in)
            .ok_or::<ProgramError>(TrampaError::MathOverflow.into())?;
        let out = reserve_a_snap
            .checked_mul(amount_in)
            .ok_or::<ProgramError>(TrampaError::MathOverflow.into())?
            .checked_div(denom)
            .ok_or::<ProgramError>(TrampaError::InsufficientLiquidity.into())?;
        let new_b = reserve_b_snap
            .checked_add(amount_in)
            .ok_or::<ProgramError>(TrampaError::MathOverflow.into())?;
        let new_a = reserve_a_snap
            .checked_sub(out)
            .ok_or::<ProgramError>(TrampaError::InsufficientLiquidity.into())?;
        (out, new_a, new_b, vault_b, vault_a)
    };

    // Fee is capped at gross output (can never exceed what we're sending)
    let fee_capped = fee_tokens.min(amount_out_gross);
    let amount_out = amount_out_gross
        .checked_sub(fee_capped)
        .ok_or::<ProgramError>(TrampaError::MathOverflow.into())?;

    // --- Slippage check ---
    if amount_out < min_amount_out {
        return Err(TrampaError::SlippageExceeded.into());
    }

    // --- CPI: user → vault_in (user pays tokens in) ---
    Transfer {
        from:      user_in,
        to:        vault_in,
        authority: user,
        amount:    amount_in,
    }
    .invoke()?;

    // PDA signer seeds for pool-authority transfers
    // pinocchio 0.8: seeds! macro → [Seed; N], then Signer::from(&seeds)
    let bump_slice = &[pool_bump];
    let s1 = pinocchio::seeds!(b"trampa", &token_a_mint_key, &token_b_mint_key, bump_slice);
    let pool_signer = Signer::from(&s1);

    // --- CPI: vault_out → user (tokens out to trader) ---
    Transfer {
        from:      vault_out,
        to:        user_out,
        authority: pool_account,
        amount:    amount_out,
    }
    .invoke_signed(&[pool_signer])?;

    // --- CPI: vault_out → fee_vault (PROPINA fee) ---
    if fee_capped > 0 {
        let s2 = pinocchio::seeds!(b"trampa", &token_a_mint_key, &token_b_mint_key, bump_slice);
        let pool_signer2 = Signer::from(&s2);
        Transfer {
            from:      vault_out,
            to:        fee_vault,
            authority: pool_account,
            amount:    fee_capped,
        }
        .invoke_signed(&[pool_signer2])?;
    }

    // --- Update pool state (single mutable borrow, written once) ---
    let mut pool_data_mut = pool_account.try_borrow_mut_data()?;
    let pool_mut: &mut TrampaPool =
        bytemuck::from_bytes_mut(&mut pool_data_mut[8..8 + core::mem::size_of::<TrampaPool>()]);

    pool_mut.reserve_a            = new_reserve_a;
    pool_mut.reserve_b            = new_reserve_b;
    pool_mut.price_history        = new_history;
    pool_mut.price_history_idx    = new_idx;
    pool_mut.total_fees_collected = total_fees_snap.saturating_add(fee_capped);

    Ok(())
}
