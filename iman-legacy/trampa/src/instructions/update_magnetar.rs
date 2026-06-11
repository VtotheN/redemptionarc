use pinocchio::{
    account_info::AccountInfo,
    instruction::Signer,
    program_error::ProgramError,
    pubkey::create_program_address,
    ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;

use crate::{
    error::TrampaError,
    state::{MAGNETAR_DISCRIMINATOR, MAGNETAR_ENTRY_SIZE, MAGNETAR_STATE_SIZE, MAX_MAGNETAR_ENTRIES},
};

/// Instruction 5 — update_magnetar
///
/// Data layout:
///   [0]      bump:  u8
///   [1]      count: u8                     — number of entries (≤ MAX_MAGNETAR_ENTRIES)
///   [2..N]   entries: [MagnetarEntry; count] — 80 bytes each
///
/// Accounts:
///   [0] authority    (signer, writable)
///   [1] magnetar_pda (writable) — seeds=[b"magnetar"], owned by TRAMPA
///   [2] system_program (read)
pub fn process(
    program_id: &Pubkey,
    accounts:   &[AccountInfo],
    data:       &[u8],
) -> ProgramResult {
    if accounts.len() < 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    if data.len() < 2 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let authority    = &accounts[0];
    let magnetar_pda = &accounts[1];

    if !authority.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let bump  = data[0];
    let count = data[1] as usize;
    if count > MAX_MAGNETAR_ENTRIES {
        return Err(TrampaError::InvalidAccountData.into());
    }
    let expected_data_len = 2 + count * MAGNETAR_ENTRY_SIZE;
    if data.len() < expected_data_len {
        return Err(ProgramError::InvalidInstructionData);
    }

    // Validate PDA
    let bump_arr = [bump];
    let expected = create_program_address(&[b"magnetar", &bump_arr], program_id)?;
    if magnetar_pda.key() != &expected {
        return Err(TrampaError::InvalidAccountData.into());
    }

    // Create PDA if uninitialized
    if magnetar_pda.data_len() == 0 {
        let signer_seeds = pinocchio::seeds!(b"magnetar", &bump_arr);
        CreateAccount {
            from:     authority,
            to:       magnetar_pda,
            lamports: 28_842_240, // rent-exempt 4016 bytes
            space:    MAGNETAR_STATE_SIZE as u64,
            owner:    program_id,
        }
        .invoke_signed(&[Signer::from(&signer_seeds)])?;

        let mut pda_data = magnetar_pda.try_borrow_mut_data()?;
        pda_data[..8].copy_from_slice(&MAGNETAR_DISCRIMINATOR);
    }

    {
        let mut pda_data = magnetar_pda.try_borrow_mut_data()?;
        if pda_data.len() < 8 || pda_data[..8] != MAGNETAR_DISCRIMINATOR {
            return Err(TrampaError::InvalidDiscriminator.into());
        }
        pda_data[8] = count as u8;
        let entries_offset = 16usize;
        for i in 0..count {
            let src = 2 + i * MAGNETAR_ENTRY_SIZE;
            let dst = entries_offset + i * MAGNETAR_ENTRY_SIZE;
            pda_data[dst..dst + MAGNETAR_ENTRY_SIZE]
                .copy_from_slice(&data[src..src + MAGNETAR_ENTRY_SIZE]);
        }
    }

    Ok(())
}

use pinocchio::pubkey::Pubkey;
