use pinocchio::program_error::ProgramError;

pub enum TrampaError {
    InvalidOracle      = 0,
    InvalidVault       = 1,
    PoolClosed         = 2,
    OutOfConcentratorRange = 3,
    ZeroAmount         = 4,
    SlippageExceeded   = 5,
    Reentrancy         = 6,
    InsufficientLiquidity = 7,
    Unauthorized       = 8,
    MathOverflow       = 9,
    InvalidAccountData = 10,
    InvalidDiscriminator = 11,
    SeedPriceTooFar      = 12,
    LockExpired          = 13,
    AlreadyClaimed       = 14,
    InsufficientFunds    = 15,
}

impl From<TrampaError> for ProgramError {
    fn from(e: TrampaError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
