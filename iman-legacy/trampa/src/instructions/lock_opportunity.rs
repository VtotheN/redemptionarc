use pinocchio::{
    account_info::AccountInfo,
    instruction::Signer,
    program_error::ProgramError,
    pubkey::{create_program_address, Pubkey},
    ProgramResult,
};
use pinocchio_system::instructions::{CreateAccount, Transfer};

use crate::{
    ancla,
    error::TrampaError,
    state::{LockOpportunity, TrampaPool, LOCK_OPP_DISCRIMINATOR, LOCK_OPP_SIZE, TRAMPA_POOL_DISCRIMINATOR},
};

/// Instruction 6 — lock_opportunity
///
/// ESPEJO: reads Pyth oracle → tx appears in ALL Yellowstone streams
/// filtering on Pyth SOL/USD, broadcasting the arb opportunity automatically.
///
/// Data layout:
///   [0]      bump:               u8  — lock_pda bump
///   [1..9]   incentivo_lamports: u64
///   [9..17]  slot_expiry:        u64 (absolute slot)
///
/// Accounts:
///   [0] authority    (signer, writable)
///   [1] pool         (read)
///   [2] lock_pda     (writable) — seeds=[b"lock", pool.key(), bump]
///   [3] oracle       (read)     — Pyth SOL/USD (ESPEJO trigger)
///   [4] system_program (read)
pub fn process(
    program_id: &Pubkey,
    accounts:   &[AccountInfo],
    data:       &[u8],
) -> ProgramResult {
    if accounts.len() < 5 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() < 17 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let authority    = &accounts[0];
    let pool_account = &accounts[1];
    let lock_pda     = &accounts[2];
    let oracle       = &accounts[3];

    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let bump               = data[0];
    let incentivo_lamports = u64::from_le_bytes(data[1..9].try_into().unwrap());
    let slot_expiry        = u64::from_le_bytes(data[9..17].try_into().unwrap());

    // Read pool
    let pool_data = pool_account.try_borrow_data()?;
    if pool_data.len() < 8 || pool_data[..8] != TRAMPA_POOL_DISCRIMINATOR {
        return Err(TrampaError::InvalidDiscriminator.into());
    }
    let pool = TrampaPool::from_bytes(&pool_data);
    if pool.reserve_a == 0 {
        return Err(TrampaError::ZeroAmount.into());
    }
    let reserve_a = pool.reserve_a;
    let reserve_b = pool.reserve_b;
    let mint_a_decimals = pool.mint_a_decimals;
    let mint_b_decimals = pool.mint_b_decimals;
    drop(pool_data);

    // ESPEJO: read oracle (side-effect = Yellowstone discovery)
    let oracle_price = ancla::read_oracle_price(oracle)?; // u64 USDC micros
    let pool_price   = ancla::compute_pool_price(reserve_a, reserve_b, mint_a_decimals, mint_b_decimals); // u64 USDC micros

    // Derive lock PDA: seeds = [b"lock", pool.key(), bump]
    let pool_key = *pool_account.key(); // [u8; 32]
    let bump_arr = [bump];
    let expected = create_program_address(&[b"lock", &pool_key, &bump_arr], program_id)?;
    if lock_pda.key() != &expected {
        return Err(TrampaError::InvalidAccountData.into());
    }

    // Create or refresh PDA
    let rent_lamports = 1_670_400u64; // rent-exempt 112 bytes
    let signer_seeds = pinocchio::seeds!(b"lock", &pool_key, &bump_arr);

    if lock_pda.data_len() == 0 {
        let total = incentivo_lamports.saturating_add(rent_lamports);
        CreateAccount {
            from:     authority,
            to:       lock_pda,
            lamports: total,
            space:    LOCK_OPP_SIZE as u64,
            owner:    program_id,
        }
        .invoke_signed(&[Signer::from(&signer_seeds)])?;
    } else {
        // Top up incentivo if needed
        Transfer {
            from:     authority,
            to:       lock_pda,
            lamports: incentivo_lamports,
        }
        .invoke()?;
    }

    // Write state
    let mut lock_data = lock_pda.try_borrow_mut_data()?;
    lock_data[..8].copy_from_slice(&LOCK_OPP_DISCRIMINATOR);

    let opp = LockOpportunity {
        pool:               pool_key,
        oracle_price,
        pool_price_at_lock: pool_price,
        incentivo_lamports,
        slot_expiry,
        claimed:            0,
        _pad:               [0u8; 7],
        claimer:            [0u8; 32],
    };
    let opp_bytes = bytemuck::bytes_of(&opp);
    lock_data[8..8 + opp_bytes.len()].copy_from_slice(opp_bytes);

    Ok(())
}
