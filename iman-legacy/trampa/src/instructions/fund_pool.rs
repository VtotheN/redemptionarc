use pinocchio::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};
use pinocchio_token::instructions::Transfer;

use crate::{
    error::TrampaError,
    state::{TrampaPool, TRAMPA_POOL_DISCRIMINATOR},
};

/// Authority-only: seed initial liquidity into pool vaults and update reserve state.
///
/// Accounts:
///   [0] authority         — signer (must match pool.authority)
///   [1] pool              — writable (PDA)
///   [2] vault_a           — writable (pool's token-a ATA)
///   [3] vault_b           — writable (pool's token-b ATA)
///   [4] authority_token_a — writable (payer's token-a account)
///   [5] authority_token_b — writable (payer's token-b account)
///   [6] token_program
///
/// Data (after discriminator):
///   [0..8]  amount_a: u64
///   [8..16] amount_b: u64
pub fn process(_program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if accounts.len() < 7 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() < 16 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let authority     = &accounts[0];
    let pool_account  = &accounts[1];
    let vault_a       = &accounts[2];
    let vault_b       = &accounts[3];
    let auth_token_a  = &accounts[4];
    let auth_token_b  = &accounts[5];

    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let amount_a = u64::from_le_bytes(data[0..8].try_into().unwrap());
    let amount_b = u64::from_le_bytes(data[8..16].try_into().unwrap());

    if amount_a == 0 && amount_b == 0 {
        return Err(TrampaError::ZeroAmount.into());
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

    if authority.key() != &pool.authority {
        return Err(TrampaError::Unauthorized.into());
    }
    if vault_a.key() != &pool.token_a_vault {
        return Err(TrampaError::InvalidVault.into());
    }
    if vault_b.key() != &pool.token_b_vault {
        return Err(TrampaError::InvalidVault.into());
    }

    let old_a = pool.reserve_a;
    let old_b = pool.reserve_b;
    drop(pool_data);

    if amount_a > 0 {
        Transfer {
            from:      auth_token_a,
            to:        vault_a,
            authority,
            amount:    amount_a,
        }
        .invoke()?;
    }

    if amount_b > 0 {
        Transfer {
            from:      auth_token_b,
            to:        vault_b,
            authority,
            amount:    amount_b,
        }
        .invoke()?;
    }

    let mut d = pool_account.try_borrow_mut_data()?;
    let s: &mut TrampaPool =
        bytemuck::from_bytes_mut(&mut d[8..8 + core::mem::size_of::<TrampaPool>()]);
    s.reserve_a = old_a.saturating_add(amount_a);
    s.reserve_b = old_b.saturating_add(amount_b);

    Ok(())
}
