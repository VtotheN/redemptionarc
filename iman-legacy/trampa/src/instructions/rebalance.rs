use pinocchio::{
    account_info::AccountInfo,
    instruction::Signer,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};
use pinocchio_token::instructions::Transfer;

use crate::{
    ancla::{divergence_bps, compute_pool_price, compute_propina_fee, compute_twap, read_oracle_price},
    error::TrampaError,
    state::{TrampaPool, TRAMPA_POOL_DISCRIMINATOR},
    PYTH_PROGRAM_ID,
};

pub fn process(_program_id: &Pubkey, accounts: &[AccountInfo], _data: &[u8]) -> ProgramResult {
    if accounts.len() < 6 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let caller               = &accounts[0];
    let pool_account         = &accounts[1];
    let token_a_vault        = &accounts[2];
    let token_b_vault        = &accounts[3];
    let oracle               = &accounts[4];
    let caller_token_account = &accounts[5];

    if !caller.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let pool_data = pool_account.try_borrow_data()?;
    if pool_data.len() < crate::state::TRAMPA_POOL_SIZE {
        return Err(ProgramError::AccountDataTooSmall);
    }
    if &pool_data[0..8] != &TRAMPA_POOL_DISCRIMINATOR {
        return Err(TrampaError::InvalidAccountData.into());
    }
    let pool: &TrampaPool =
        bytemuck::from_bytes(&pool_data[8..8 + core::mem::size_of::<TrampaPool>()]);

    if pool.is_active == 0 {
        return Err(TrampaError::PoolClosed.into());
    }
    if oracle.key() != &pool.oracle_pubkey {
        return Err(TrampaError::InvalidOracle.into());
    }
    {
        let owner = unsafe { oracle.owner() };
        if owner != &PYTH_PROGRAM_ID && owner != _program_id {
            return Err(TrampaError::InvalidOracle.into());
        }
    }
    if token_a_vault.key() != &pool.token_a_vault {
        return Err(TrampaError::InvalidVault.into());
    }
    if token_b_vault.key() != &pool.token_b_vault {
        return Err(TrampaError::InvalidVault.into());
    }

    let reserve_a              = pool.reserve_a;
    let reserve_b              = pool.reserve_b;
    let concentrador_range_bps = pool.concentrador_range_bps;
    let propina_pct            = pool.propina_pct;
    let incentivo_pct          = pool.incentivo_pct;
    let price_history_snap     = pool.price_history;
    let price_history_idx_snap = pool.price_history_idx;
    let total_fees_snap        = pool.total_fees_collected;
    let token_a_mint           = pool.token_a_mint;
    let token_b_mint           = pool.token_b_mint;
    let bump                   = pool.bump;
    let mint_a_decimals        = pool.mint_a_decimals;
    let mint_b_decimals        = pool.mint_b_decimals;
    drop(pool_data);

    let oracle_price = read_oracle_price(oracle)?;
    let pool_price   = compute_pool_price(reserve_a, reserve_b, mint_a_decimals, mint_b_decimals);
    let div          = divergence_bps(oracle_price, pool_price);

    if div <= concentrador_range_bps as u64 {
        return Ok(());
    }

    let a_to_b = oracle_price > pool_price;

    let (reserve_in, reserve_out) = if a_to_b {
        (reserve_a, reserve_b)
    } else {
        (reserve_b, reserve_a)
    };

    let rebalance_amount = reserve_in / 100;
    if rebalance_amount == 0 {
        return Ok(());
    }

    let gross_out = reserve_out
        .checked_mul(rebalance_amount)
        .ok_or::<ProgramError>(TrampaError::MathOverflow.into())?
        .checked_div(
            reserve_in
                .checked_add(rebalance_amount)
                .ok_or::<ProgramError>(TrampaError::MathOverflow.into())?,
        )
        .ok_or::<ProgramError>(TrampaError::InsufficientLiquidity.into())?;

    if gross_out == 0 {
        return Ok(());
    }

    let mut new_history = price_history_snap;
    let idx = price_history_idx_snap as usize % 64;
    new_history[idx] = pool_price;
    let new_idx = ((price_history_idx_snap as usize + 1) % 64) as u8;
    let twap = compute_twap(&new_history);

    let fee      = compute_propina_fee(oracle_price, pool_price, twap, gross_out, propina_pct);
    let fee      = fee.min(gross_out);
    let net_out  = gross_out - fee;
    let incentivo = fee.saturating_mul(incentivo_pct as u64) / 10_000;

    let bump_slice = [bump];
    if incentivo > 0 {
        let vault_out = if a_to_b { token_b_vault } else { token_a_vault };
        let s = pinocchio::seeds!(b"trampa", &token_a_mint, &token_b_mint, &bump_slice);
        let signer = Signer::from(&s);
        Transfer {
            from:      vault_out,
            to:        caller_token_account,
            authority: pool_account,
            amount:    incentivo,
        }
        .invoke_signed(&[signer])?;
    }

    let (new_reserve_a, new_reserve_b) = if a_to_b {
        (
            reserve_a.saturating_add(rebalance_amount),
            reserve_b.saturating_sub(net_out.saturating_add(fee)),
        )
    } else {
        (
            reserve_a.saturating_sub(net_out.saturating_add(fee)),
            reserve_b.saturating_add(rebalance_amount),
        )
    };

    let new_pool_price = compute_pool_price(new_reserve_a, new_reserve_b, mint_a_decimals, mint_b_decimals);
    let mut new_history2 = new_history;
    let idx2 = new_idx as usize % 64;
    new_history2[idx2] = new_pool_price;
    let final_idx = ((new_idx as usize + 1) % 64) as u8;

    let mut pool_data_mut = pool_account.try_borrow_mut_data()?;
    let pool_mut: &mut TrampaPool =
        bytemuck::from_bytes_mut(&mut pool_data_mut[8..8 + core::mem::size_of::<TrampaPool>()]);

    pool_mut.reserve_a            = new_reserve_a;
    pool_mut.reserve_b            = new_reserve_b;
    pool_mut.price_history        = new_history2;
    pool_mut.price_history_idx    = final_idx;
    pool_mut.total_fees_collected = total_fees_snap.saturating_add(fee);

    Ok(())
}
