use bytemuck::{Pod, Zeroable};

// ── MAGNETAR ──────────────────────────────────────────────────────────────────
pub const MAGNETAR_DISCRIMINATOR: [u8; 8] = *b"magnetar";
pub const MAX_MAGNETAR_ENTRIES:   usize   = 50;
pub const MAGNETAR_ENTRY_SIZE:    usize   = core::mem::size_of::<MagnetarEntry>();
pub const MAGNETAR_STATE_SIZE:    usize   = 16 + MAX_MAGNETAR_ENTRIES * MAGNETAR_ENTRY_SIZE;

#[derive(Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct MagnetarEntry {
    pub pool:           [u8; 32], // pool PDA
    pub oracle_price:   u64,      // USDC micros (oracle_usd * 1_000_000)
    pub pool_price:     u64,      // USDC micros
    pub divergence_bps: u16,
    pub _pad:           [u8; 6],
    pub reserve_a:      u64,
    pub reserve_b:      u64,
    pub propina_24h:    u64,      // lamports accumulated (informational)
}

#[derive(Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct MagnetarHeader {
    pub discriminator: [u8; 8],
    pub count:         u8,
    pub _pad:          [u8; 7],
}

// ── LOCK OPPORTUNITY ─────────────────────────────────────────────────────────
pub const LOCK_OPP_DISCRIMINATOR: [u8; 8] = *b"lockopp!";
pub const LOCK_OPP_SIZE: usize = 8 + core::mem::size_of::<LockOpportunity>();

#[derive(Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct LockOpportunity {
    pub pool:               [u8; 32],
    pub oracle_price:       u64,
    pub pool_price_at_lock: u64,
    pub incentivo_lamports: u64,
    pub slot_expiry:        u64,
    pub claimed:            u8,
    pub _pad:               [u8; 7],
    pub claimer:            [u8; 32],
}

pub const TRAMPA_POOL_DISCRIMINATOR: [u8; 8] = *b"trampool";
pub const TRAMPA_POOL_SIZE: usize = 8 + core::mem::size_of::<TrampaPool>();

#[derive(Clone, Copy, Pod, Zeroable)]
#[repr(C)]
pub struct TrampaPool {
    pub token_a_mint:            [u8; 32],
    pub token_b_mint:            [u8; 32],
    pub token_a_vault:           [u8; 32],
    pub token_b_vault:           [u8; 32],
    pub oracle_pubkey:           [u8; 32],
    pub authority:               [u8; 32],
    pub fee_vault:               [u8; 32],
    pub propina_pct:             u16,   // 7500 = 75%
    pub concentrador_range_bps:  u16,   // 20000 = ±200bps
    pub _pad0:                   [u8; 4],
    pub latido_interval_min:     u64,
    pub latido_interval_max:     u64,
    pub latido_window:           u64,
    pub last_latido_slot:        u64,
    pub incentivo_pct:           u16,   // 1000 = 10%
    pub _pad1:                   [u8; 6],
    pub total_fees_collected:    u64,
    pub reserve_a:               u64,
    pub reserve_b:               u64,
    pub price_history:           [u64; 64],
    pub price_history_idx:       u8,
    pub is_active:               u8,    // 1 = active
    pub bump:                    u8,
    pub mint_a_decimals:         u8,
    pub mint_b_decimals:         u8,
    pub _pad2:                   [u8; 3],
}

impl TrampaPool {
    pub fn from_bytes(data: &[u8]) -> &Self {
        bytemuck::from_bytes(&data[8..8 + core::mem::size_of::<Self>()])
    }
    pub fn from_bytes_mut(data: &mut [u8]) -> &mut Self {
        bytemuck::from_bytes_mut(&mut data[8..8 + core::mem::size_of::<Self>()])
    }
    pub fn update_price_history(&mut self, price: u64) {
        let idx = self.price_history_idx as usize % 64;
        self.price_history[idx] = price;
        self.price_history_idx = self.price_history_idx.wrapping_add(1) % 64;
    }
}
