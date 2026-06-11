use pinocchio::{
    account_info::AccountInfo,
    instruction::Signer,
    program_error::ProgramError,
    pubkey::create_program_address,
    ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;

use crate::error::TrampaError;

/// Instruction 8 — update_synthetic_oracle (permissionless)
///
/// Mode 0 (JitoSOL/SOL): price = total_lamports × 1e6 / pool_supply, exp=-6
/// Mode 1 (JitoSOL/USD): price = total_lamports × sol_usd_raw × 10^(8+sol_exp) / pool_supply, exp=-8
///
/// JitoSOL stake pool offsets:
///   258: total_lamports    u64 LE
///   266: pool_token_supply u64 LE
///
/// Data: [0] bump, [1] mode (0=SOL, 1=USD)
/// Accounts: [0] payer, [1] synth_oracle PDA, [2] stake_pool, [3] sol_oracle, [4] system_program

const SYNTH_ORACLE_SIZE:  usize = 240;
const SYNTH_ORACLE_RENT:  u64   = 2_561_280; // rent-exempt 240 bytes
const STAKE_TOTAL_OFF:    usize = 258;
const STAKE_SUPPLY_OFF:   usize = 266;
const PRICE_WRITE_OFF:    usize = 208;
const EXP_WRITE_OFF:      usize = 20;

pub fn process(
    program_id: &Pubkey,
    accounts:   &[AccountInfo],
    data:       &[u8],
) -> ProgramResult {
    if accounts.len() < 5 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() < 2 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let payer        = &accounts[0];
    let synth_oracle = &accounts[1];
    let stake_pool   = &accounts[2];
    let sol_oracle   = &accounts[3];

    if !payer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let bump     = data[0];
    let mode     = data[1];
    let bump_arr = [bump];
    let pool_key = *stake_pool.key();

    // Validate PDA
    let expected = create_program_address(
        &[b"synth_oracle", &pool_key, &bump_arr],
        program_id,
    )?;
    if synth_oracle.key() != &expected {
        return Err(TrampaError::InvalidAccountData.into());
    }

    // Read stake pool redemption rate
    let (total_lamports, pool_supply) = {
        let sp = stake_pool.try_borrow_data()?;
        if sp.len() < STAKE_SUPPLY_OFF + 8 {
            return Err(TrampaError::InvalidAccountData.into());
        }
        let tl = u64::from_le_bytes(sp[STAKE_TOTAL_OFF..STAKE_TOTAL_OFF + 8].try_into().unwrap());
        let ps = u64::from_le_bytes(sp[STAKE_SUPPLY_OFF..STAKE_SUPPLY_OFF + 8].try_into().unwrap());
        (tl, ps)
    };
    if pool_supply == 0 {
        return Err(TrampaError::ZeroAmount.into());
    }

    let (price_i64, exponent): (i64, i32) = match mode {
        0 => {
            // JitoSOL/SOL: price = rate × 1e6, exp=-6
            let p = ((total_lamports as u128)
                .saturating_mul(1_000_000)
                / pool_supply as u128) as i64;
            (p, -6)
        }
        _ => {
            // JitoSOL/USD: price = rate × SOL_USD × 1e8, exp=-8
            let (sol_raw, sol_exp) = {
                let od = sol_oracle.try_borrow_data()?;
                if od.len() < 228 {
                    return Err(TrampaError::InvalidOracle.into());
                }
                let p = i64::from_le_bytes(od[208..216].try_into().unwrap());
                let e = i32::from_le_bytes(od[20..24].try_into().unwrap());
                (p, e)
            };
            if sol_raw <= 0 {
                return Err(TrampaError::InvalidOracle.into());
            }
            let adj = 8i32 + sol_exp;
            let p: i64 = if adj >= 0 {
                ((total_lamports as u128)
                    .saturating_mul(sol_raw as u128)
                    .saturating_mul(10u128.pow(adj as u32))
                    / pool_supply as u128) as i64
            } else {
                ((total_lamports as u128)
                    .saturating_mul(sol_raw as u128)
                    / 10u128.pow((-adj) as u32)
                    / pool_supply as u128) as i64
            };
            (p, -8)
        }
    };

    if price_i64 <= 0 {
        return Err(TrampaError::InvalidOracle.into());
    }

    // Create PDA if uninitialized
    if synth_oracle.data_len() == 0 {
        let signer_seeds = pinocchio::seeds!(b"synth_oracle", &pool_key, &bump_arr);
        CreateAccount {
            from:     payer,
            to:       synth_oracle,
            lamports: SYNTH_ORACLE_RENT,
            space:    SYNTH_ORACLE_SIZE as u64,
            owner:    program_id,
        }
        .invoke_signed(&[Signer::from(&signer_seeds)])?;
    }

    // Write Pyth V1-compatible layout
    let mut pda = synth_oracle.try_borrow_mut_data()?;
    pda[EXP_WRITE_OFF..EXP_WRITE_OFF + 4].copy_from_slice(&exponent.to_le_bytes());
    pda[PRICE_WRITE_OFF..PRICE_WRITE_OFF + 8].copy_from_slice(&price_i64.to_le_bytes());

    Ok(())
}

use pinocchio::pubkey::Pubkey;
