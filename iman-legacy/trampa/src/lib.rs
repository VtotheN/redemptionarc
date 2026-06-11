#![cfg_attr(target_os = "solana", no_std)]

#[cfg(target_os = "solana")]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}

use pinocchio::{
    account_info::AccountInfo,
    entrypoint,
    program_error::ProgramError,
    pubkey::Pubkey,
    ProgramResult,
};

pub mod ancla;
pub mod error;
pub mod instructions;
pub mod state;

// Pyth v1 oracle program — mainnet: FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH
pub const PYTH_PROGRAM_ID: Pubkey = [
    0xdc, 0xe5, 0xeb, 0xe1, 0xe4, 0x9c, 0x3b, 0x9f,
    0x11, 0x4c, 0xb5, 0x54, 0x4c, 0x50, 0xa9, 0x9e,
    0xc0, 0xd6, 0x92, 0xd6, 0x3f, 0x56, 0x79, 0x5a,
    0xe0, 0x29, 0xac, 0x83, 0xd9, 0xea, 0x8b, 0xe2,
];

entrypoint!(process_instruction);

pub fn process_instruction(
    program_id:       &Pubkey,
    accounts:         &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    if instruction_data.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }
    match instruction_data[0] {
        0 => instructions::initialize_pool::process(program_id, accounts, &instruction_data[1..]),
        1 => instructions::swap::process(program_id, accounts, &instruction_data[1..]),
        2 => instructions::rebalance::process(program_id, accounts, &instruction_data[1..]),
        3 => instructions::collect_fees::process(program_id, accounts, &instruction_data[1..]),
        4 => instructions::fund_pool::process(program_id, accounts, &instruction_data[1..]),
        5 => instructions::update_magnetar::process(program_id, accounts, &instruction_data[1..]),
        6 => instructions::lock_opportunity::process(program_id, accounts, &instruction_data[1..]),
        7 => instructions::claim_incentivo::process(program_id, accounts, &instruction_data[1..]),
        8 => instructions::update_synthetic_oracle::process(program_id, accounts, &instruction_data[1..]),
        // RESONADOR: detect Raydium CPMM swap discriminators
        // Raydium CPMM swap_base_input:  sha256("global:swap_base_input")[0..8]
        // Raydium CPMM swap_base_output: sha256("global:swap_base_output")[0..8]
        _ if instruction_data.len() >= 9
            && (instruction_data[..8] == [143, 190, 90, 218, 196, 30, 51, 222]  // swap_base_input
             || instruction_data[..8] == [55, 217, 98, 86, 163, 74, 180, 173])  // swap_base_output
        => {
            // Parse Raydium compat: amount_in(8) + min_out(8) at data[8..24]
            // Route to TRAMPA swap with synthetic discriminator-1 data
            if instruction_data.len() < 25 {
                return Err(ProgramError::InvalidInstructionData);
            }
            let amount_in  = u64::from_le_bytes(instruction_data[8..16].try_into().unwrap_or([0u8;8]));
            let min_out    = u64::from_le_bytes(instruction_data[16..24].try_into().unwrap_or([0u8;8]));
            let a_to_b     = instruction_data[24];
            let mut synth  = [0u8; 17];
            synth[0..8].copy_from_slice(&amount_in.to_le_bytes());
            synth[8..16].copy_from_slice(&min_out.to_le_bytes());
            synth[16]   = a_to_b;
            instructions::swap::process(program_id, accounts, &synth)
        }
        _ => Err(ProgramError::InvalidInstructionData),
    }
}
