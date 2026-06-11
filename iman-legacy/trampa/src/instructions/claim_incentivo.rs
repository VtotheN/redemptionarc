use pinocchio::{
    account_info::AccountInfo,
    instruction::Signer,
    program_error::ProgramError,
    pubkey::{create_program_address, Pubkey},
    ProgramResult,
};
use pinocchio_system::instructions::Transfer;

use crate::{
    ancla,
    error::TrampaError,
    state::{LockOpportunity, TrampaPool, LOCK_OPP_DISCRIMINATOR, TRAMPA_POOL_DISCRIMINATOR},
};

/// Instruction 7 — claim_incentivo
///
/// Called by a searcher after executing an arb that reduced pool divergence.
/// Validates improvement, pays incentivo from lock_pda lamports.
///
/// ESPEJO: reads oracle → captured by Yellowstone Pyth streams.
///
/// Accounts:
///   [0] claimer   (signer, writable) — receives incentivo
///   [1] pool      (read)
///   [2] lock_pda  (writable) — must exist, unclaimed
///   [3] oracle    (read)
///
/// Data layout:
///   [0] bump: u8 — lock_pda bump
pub fn process(
    program_id: &Pubkey,
    accounts:   &[AccountInfo],
    data:       &[u8],
) -> ProgramResult {
    if accounts.len() < 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }

    let claimer      = &accounts[0];
    let pool_account = &accounts[1];
    let lock_pda     = &accounts[2];
    let oracle       = &accounts[3];

    if !claimer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let bump = data[0];

    // Read and validate lock PDA
    let (oracle_price_before, pool_price_before, incentivo, pool_key, bump_arr) = {
        let lock_data = lock_pda.try_borrow_data()?;
        if lock_data.len() < 8 || lock_data[..8] != LOCK_OPP_DISCRIMINATOR {
            return Err(TrampaError::InvalidDiscriminator.into());
        }
        let opp: &LockOpportunity = bytemuck::from_bytes(
            &lock_data[8..8 + core::mem::size_of::<LockOpportunity>()],
        );
        if opp.claimed != 0 {
            return Err(TrampaError::AlreadyClaimed.into());
        }
        if &opp.pool != pool_account.key() {
            return Err(TrampaError::InvalidAccountData.into());
        }
        (opp.oracle_price, opp.pool_price_at_lock, opp.incentivo_lamports, opp.pool, [bump])
    };

    // Validate PDA derivation
    let expected = create_program_address(&[b"lock", &pool_key, &bump_arr], program_id)?;
    if lock_pda.key() != &expected {
        return Err(TrampaError::InvalidAccountData.into());
    }

    // Read current pool state
    let (reserve_a, reserve_b, mint_a_decimals, mint_b_decimals) = {
        let pool_data = pool_account.try_borrow_data()?;
        if pool_data.len() < 8 || pool_data[..8] != TRAMPA_POOL_DISCRIMINATOR {
            return Err(TrampaError::InvalidDiscriminator.into());
        }
        let pool = TrampaPool::from_bytes(&pool_data);
        (pool.reserve_a, pool.reserve_b, pool.mint_a_decimals, pool.mint_b_decimals)
    };

    // ESPEJO: read oracle
    let oracle_price_now = ancla::read_oracle_price(oracle)?;
    let pool_price_now   = ancla::compute_pool_price(reserve_a, reserve_b, mint_a_decimals, mint_b_decimals);

    // Validate improvement: divergence must have decreased by ≥1bps
    let div_before = ancla::divergence_bps(oracle_price_before, pool_price_before);
    let div_now    = ancla::divergence_bps(oracle_price_now,   pool_price_now);
    if div_now + 1 >= div_before {
        return Err(TrampaError::InvalidAccountData.into());
    }

    // Mark claimed
    {
        let mut lock_data_mut = lock_pda.try_borrow_mut_data()?;
        let opp_mut: &mut LockOpportunity = bytemuck::from_bytes_mut(
            &mut lock_data_mut[8..8 + core::mem::size_of::<LockOpportunity>()],
        );
        opp_mut.claimed = 1;
        opp_mut.claimer = *claimer.key();
    }

    // Pay incentivo: lock_pda → claimer via CPI (lock_pda signs with its PDA seeds)
    let signer_seeds = pinocchio::seeds!(b"lock", &pool_key, &bump_arr);
    Transfer {
        from:     lock_pda,
        to:       claimer,
        lamports: incentivo,
    }
    .invoke_signed(&[Signer::from(&signer_seeds)])?;

    Ok(())
}
