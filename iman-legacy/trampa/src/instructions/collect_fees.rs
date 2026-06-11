use pinocchio::{
    account_info::AccountInfo,
    instruction::Signer,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};
use pinocchio_token::{instructions::Transfer, state::TokenAccount};

use crate::{
    error::TrampaError,
    state::{TrampaPool, TRAMPA_POOL_DISCRIMINATOR},
};

pub fn process(_program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if accounts.len() < 5 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let authority    = &accounts[0];
    let pool_account = &accounts[1];
    let fee_vault    = &accounts[2];
    let destination  = &accounts[3];

    if !authority.is_signer() {
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

    if authority.key() != &pool.authority {
        return Err(TrampaError::Unauthorized.into());
    }
    if fee_vault.key() != &pool.fee_vault {
        return Err(TrampaError::InvalidVault.into());
    }

    let token_a_mint = pool.token_a_mint;
    let token_b_mint = pool.token_b_mint;
    let bump         = pool.bump;
    drop(pool_data);

    let requested: u64 = if data.len() >= 8 {
        u64::from_le_bytes(data[0..8].try_into().map_err(|_| ProgramError::InvalidInstructionData)?)
    } else {
        0
    };

    let vault_balance = {
        let token_acct = TokenAccount::from_account_info(fee_vault)?;
        token_acct.amount()
    };

    let amount = if requested == 0 || requested > vault_balance {
        vault_balance
    } else {
        requested
    };

    if amount == 0 {
        return Ok(());
    }

    let bump_slice = [bump];
    let s = pinocchio::seeds!(b"trampa", &token_a_mint, &token_b_mint, &bump_slice);
    let signer = Signer::from(&s);

    Transfer {
        from:      fee_vault,
        to:        destination,
        authority: pool_account,
        amount,
    }
    .invoke_signed(&[signer])?;

    Ok(())
}
