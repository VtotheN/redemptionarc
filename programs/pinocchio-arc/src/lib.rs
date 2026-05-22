#![no_std]

use pinocchio::{
    account_info::AccountInfo,
    msg,
    no_allocator,
    nostd_panic_handler,
    program_entrypoint,
    pubkey::Pubkey,
    ProgramResult,
};

program_entrypoint!(process_instruction);
nostd_panic_handler!();
no_allocator!();

const IX_PING: u8 = 0;
const IX_ARC_CALLBACK_V0: u8 = 1;

pub fn process_instruction(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    match instruction_data.first().copied() {
        Some(IX_PING) => {
            msg!("redemption-pinocchio-arc: ping");
            Ok(())
        }
        Some(IX_ARC_CALLBACK_V0) => process_arc_callback_v0(accounts, instruction_data),
        _ => {
            msg!("redemption-pinocchio-arc: unknown instruction");
            Ok(())
        }
    }
}

fn process_arc_callback_v0(accounts: &[AccountInfo], _instruction_data: &[u8]) -> ProgramResult {
    // V0 is intentionally read-only. It gives us a deployable CU baseline before
    // moving SPL/Token-2022 CPI into this program.
    if accounts.len() < 4 {
        msg!("redemption-pinocchio-arc: missing accounts");
        return Ok(());
    }

    msg!("redemption-pinocchio-arc: callback v0");
    Ok(())
}

