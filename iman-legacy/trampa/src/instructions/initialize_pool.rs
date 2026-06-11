use pinocchio::{
    account_info::AccountInfo,
    instruction::Signer,
    program_error::ProgramError,
    pubkey::{create_program_address, Pubkey},
    sysvars::{rent::Rent, Sysvar},
    ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;

use crate::{
    error::TrampaError,
    state::{TrampaPool, TRAMPA_POOL_DISCRIMINATOR, TRAMPA_POOL_SIZE},
};

/// Instruction data layout (after discriminator byte):
///   [0..2]   propina_pct:            u16
///   [2..4]   concentrador_range_bps: u16
///   [4..8]   _pad:                   u32
///   [8..16]  latido_interval_min:    u64
///   [16..24] latido_interval_max:    u64
///   [24..32] latido_window:          u64
///   [32..34] incentivo_pct:          u16
///   [34..40] _pad2:                  u48 (6 bytes)
///   [40..48] initial_reserve_a:      u64
///   [48..56] initial_reserve_b:      u64
///   [56]     bump:                   u8
///
/// Accounts:
///   [0] payer          (signer, writable)
///   [1] pool           (writable, PDA: [b"trampa", token_a_mint, token_b_mint, bump])
///   [2] token_a_mint   (read)
///   [3] token_b_mint   (read)
///   [4] token_a_vault  (writable)
///   [5] token_b_vault  (writable)
///   [6] fee_vault      (writable)
///   [7] oracle         (read)
///   [8] authority      (read)
///   [9] system_program (read)
pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if accounts.len() < 10 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    // Minimum data: 57 bytes
    if data.len() < 57 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let payer        = &accounts[0];
    let pool_account = &accounts[1];
    let token_a_mint = &accounts[2];
    let token_b_mint = &accounts[3];
    let vault_a      = &accounts[4];
    let vault_b      = &accounts[5];
    let fee_vault    = &accounts[6];
    let oracle       = &accounts[7];
    let authority    = &accounts[8];

    // Parse instruction data
    let propina_pct            = u16::from_le_bytes(data[0..2].try_into().unwrap());
    let concentrador_range_bps = u16::from_le_bytes(data[2..4].try_into().unwrap());
    // [4..8] padding
    let latido_interval_min    = u64::from_le_bytes(data[8..16].try_into().unwrap());
    let latido_interval_max    = u64::from_le_bytes(data[16..24].try_into().unwrap());
    let latido_window          = u64::from_le_bytes(data[24..32].try_into().unwrap());
    let incentivo_pct          = u16::from_le_bytes(data[32..34].try_into().unwrap());
    // [34..40] padding
    let initial_reserve_a      = u64::from_le_bytes(data[40..48].try_into().unwrap());
    let initial_reserve_b      = u64::from_le_bytes(data[48..56].try_into().unwrap());
    let bump                   = data[56];

    // Read mintA decimals from SPL mint account (offset 44 in mint layout)
    let mint_a_decimals: u8 = {
        let mint_data = token_a_mint.try_borrow_data()?;
        if mint_data.len() < 45 {
            return Err(ProgramError::InvalidAccountData);
        }
        mint_data[44]
    };

    let mint_b_decimals: u8 = {
        let mint_data = token_b_mint.try_borrow_data()?;
        if mint_data.len() < 45 {
            return Err(ProgramError::InvalidAccountData);
        }
        mint_data[44]
    };

    // SIEMBRE: validate seed price within 50bps of oracle
    if initial_reserve_a == 0 {
        return Err(TrampaError::ZeroAmount.into());
    }
    {
        let oracle_data = oracle.try_borrow_data()?;
        let price_raw = i64::from_le_bytes(
            oracle_data[208..216].try_into().unwrap_or([0u8; 8]),
        );
        let exponent = i32::from_le_bytes(
            oracle_data[20..24].try_into().unwrap_or([0u8; 4]),
        );
        let exp_adj = 6i32 + exponent;
        let oracle_price: u64 = if exp_adj >= 0 {
            (price_raw as u64).saturating_mul(10u64.pow(exp_adj as u32))
        } else {
            (price_raw as u64) / 10u64.pow((-exp_adj) as u32)
        };
        let exp_a  = if mint_a_decimals == 0 { 9i32 } else { mint_a_decimals as i32 };
        let exp_b  = if mint_b_decimals == 0 { 6i32 } else { mint_b_decimals as i32 };
        let net    = exp_a + 6 - exp_b;
        let seed_price: u64 = if net >= 0 {
            (initial_reserve_b as u128)
                .saturating_mul(10u128.pow(net as u32))
                .checked_div(initial_reserve_a as u128)
                .unwrap_or(0) as u64
        } else {
            (initial_reserve_b as u128)
                .checked_div(10u128.pow((-net) as u32))
                .unwrap_or(0)
                .checked_div(initial_reserve_a as u128)
                .unwrap_or(0) as u64
        };
        if oracle_price == 0 {
            return Err(TrampaError::InvalidOracle.into());
        }
        let diff = if oracle_price > seed_price {
            oracle_price - seed_price
        } else {
            seed_price - oracle_price
        };
        let divergence_bps = diff
            .saturating_mul(10_000)
            .checked_div(oracle_price)
            .unwrap_or(u64::MAX);
        if divergence_bps > 50 {
            return Err(TrampaError::SeedPriceTooFar.into());
        }
    }

    // Validate payer is signer
    if !payer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Derive and validate pool PDA
    // Seeds: [b"trampa", token_a_mint, token_b_mint, bump]
    let bump_arr = [bump];
    let expected_pool = create_program_address(
        &[
            b"trampa",
            token_a_mint.key().as_ref(),
            token_b_mint.key().as_ref(),
            bump_arr.as_ref(),
        ],
        program_id,
    )
    .map_err(|_| ProgramError::InvalidSeeds)?;

    if expected_pool != *pool_account.key() {
        return Err(TrampaError::InvalidAccountData.into());
    }

    // Compute rent for pool account
    let rent     = Rent::get()?;
    let lamports = rent.minimum_balance(TRAMPA_POOL_SIZE);

    // Build PDA signer. Each element must be Into<Seed<'_>> (From<&[u8]> impl).
    // pinocchio::signer! expands to Signer::from(&[seed.into(), ...])
    let pool_seeds = pinocchio::seeds!(
        b"trampa",
        token_a_mint.key().as_ref(),
        token_b_mint.key().as_ref(),
        bump_arr.as_ref()
    );
    let pool_signer = Signer::from(&pool_seeds);

    CreateAccount {
        from:  payer,
        to:    pool_account,
        lamports,
        space: TRAMPA_POOL_SIZE as u64,
        owner: program_id,
    }
    .invoke_signed(&[pool_signer])?;

    // Write pool state.
    // SAFETY: pool was just created by CreateAccount CPI; no borrows held at this point.
    let pool_data = unsafe { pool_account.borrow_mut_data_unchecked() };

    // Discriminator
    pool_data[..8].copy_from_slice(&TRAMPA_POOL_DISCRIMINATOR);

    // Pool struct (via bytemuck zero-copy write)
    let pool_state = TrampaPool::from_bytes_mut(pool_data);
    pool_state.token_a_mint           = *token_a_mint.key();
    pool_state.token_b_mint           = *token_b_mint.key();
    pool_state.token_a_vault          = *vault_a.key();
    pool_state.token_b_vault          = *vault_b.key();
    pool_state.oracle_pubkey          = *oracle.key();
    pool_state.authority              = *authority.key();
    pool_state.fee_vault              = *fee_vault.key();
    pool_state.propina_pct            = propina_pct;
    pool_state.concentrador_range_bps = concentrador_range_bps;
    pool_state._pad0                  = [0u8; 4];
    pool_state.latido_interval_min    = latido_interval_min;
    pool_state.latido_interval_max    = latido_interval_max;
    pool_state.latido_window          = latido_window;
    pool_state.last_latido_slot       = 0;
    pool_state.incentivo_pct          = incentivo_pct;
    pool_state._pad1                  = [0u8; 6];
    pool_state.total_fees_collected   = 0;
    pool_state.reserve_a              = initial_reserve_a;
    pool_state.reserve_b              = initial_reserve_b;
    pool_state.price_history          = [0u64; 64];
    pool_state.price_history_idx      = 0;
    pool_state.is_active              = 1;
    pool_state.bump                   = bump;
    pool_state.mint_a_decimals        = mint_a_decimals;
    pool_state.mint_b_decimals        = mint_b_decimals;
    pool_state._pad2                  = [0u8; 3];

    Ok(())
}
