use anyhow::{anyhow, Result};
use base64::{prelude::BASE64_STANDARD as B64, Engine};
use solana_client::rpc_client::RpcClient;
use solana_sdk::{
    address_lookup_table_account::AddressLookupTableAccount,
    commitment_config::CommitmentConfig,
    instruction::{AccountMeta, Instruction},
    message::{v0, VersionedMessage},
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_instruction,
    system_program,
    transaction::VersionedTransaction,
};
use std::{str::FromStr, time::Duration};
use tracing::{info, warn};

// ── constants ─────────────────────────────────────────────────────────────────
const TRAMPA_PROGRAM:  &str = "FpFXNWCm5qM4t9GKttp9Jkx8YpYfxgW5Cu37T8pdr8oE";
const TRAMPA_POOL:     &str = "7Arc38Z415VqT2sc8skNVmebGE1RCKyrctJo2sGd6XUs";
const PYTH_ORACLE:     &str = "H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG";
const JITO_URL:        &str = "https://mainnet.block-engine.jito.wtf/api/v1/bundles";
const JITO_TIP:        &str = "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5";
const TIP_LAMPORTS:    u64  = 10_000;
const WSOL_MINT:       &str = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAM:   &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SPL_ATA_PROG:    &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe8bY4";
const CLOCK_SYSVAR:    &str = "SysvarC1ock11111111111111111111111111111111";

const MSOL_POOL:       &str = "B4n16UwDe7k6UujuoSqsd7L54VnUVw46GwqCnT6dq268";
const MSOL_ORACLE:     &str = "E4v1BBgoso9s64TQvmyownAVJbhbEPGyzA3qn4n46qj9";
const JITOSOL_POOL:    &str = "3JifN9CHEUGkDrfCv2TCa1LzvrfxQabbNuEZrGTnccTH";
const JITOSOL_ORACLE:  &str = "EeiNMjxsnieNg2Na4kpVYctB1t23gZzciZoC82zgP6wM";
const JITO_STAKE_POOL: &str = "Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb";
const SOL_USD_ORACLE:  &str = "H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG";

// Pyth offsets
const PYTH_PRICE_OFFSET: usize = 208; // i64 raw price
const PYTH_EXP_OFFSET:   usize = 20;  // i32 exponent

// Pool state offsets
const POOL_VAULT_A_OFFSET:          usize = 72;
const POOL_VAULT_B_OFFSET:          usize = 104;
const POOL_RESERVE_A_OFFSET:        usize = 288; // u64 LE
const POOL_RESERVE_B_OFFSET:        usize = 296; // u64 LE
const POOL_MINT_A_DECIMALS_OFFSET:  usize = 819; // u8
const POOL_MINT_B_DECIMALS_OFFSET:  usize = 820; // u8

// ── pool config ───────────────────────────────────────────────────────────────

struct PoolConfig {
    pool_pk:   Pubkey,
    oracle_pk: Pubkey,
}

// ── helpers ───────────────────────────────────────────────────────────────────

fn load_keypair(path: &str) -> Result<Keypair> {
    let data = std::fs::read_to_string(path)?;
    let bytes: Vec<u8> = serde_json::from_str(&data)?;
    Keypair::from_bytes(&bytes).map_err(|e| anyhow!("keypair: {e}"))
}

fn read_u64_le(data: &[u8], offset: usize) -> Result<u64> {
    data.get(offset..offset + 8)
        .ok_or_else(|| anyhow!("read_u64 oob: off={offset} len={}", data.len()))
        .map(|b| u64::from_le_bytes(b.try_into().unwrap()))
}

fn read_i64_le(data: &[u8], offset: usize) -> Result<i64> {
    data.get(offset..offset + 8)
        .ok_or_else(|| anyhow!("read_i64 oob: off={offset}"))
        .map(|b| i64::from_le_bytes(b.try_into().unwrap()))
}

fn read_i32_le(data: &[u8], offset: usize) -> Result<i32> {
    data.get(offset..offset + 4)
        .ok_or_else(|| anyhow!("read_i32 oob: off={offset}"))
        .map(|b| i32::from_le_bytes(b.try_into().unwrap()))
}

fn read_pubkey(data: &[u8], offset: usize) -> Result<Pubkey> {
    data.get(offset..offset + 32)
        .ok_or_else(|| anyhow!("read_pubkey oob: off={offset}"))
        .map(|b| Pubkey::new_from_array(b.try_into().unwrap()))
}

/// oracle price as f64 USD/SOL
fn parse_pyth_price(data: &[u8]) -> Result<f64> {
    let raw = read_i64_le(data, PYTH_PRICE_OFFSET)?;
    let exp = read_i32_le(data, PYTH_EXP_OFFSET)?;
    if raw <= 0 {
        return Err(anyhow!("pyth price non-positive: {raw}"));
    }
    Ok((raw as f64) * 10f64.powi(exp))
}

/// Returns (pool_price_usd, vault_a, vault_b)
fn parse_pool_state(data: &[u8]) -> Result<(f64, Pubkey, Pubkey)> {
    let vault_a         = read_pubkey(data, POOL_VAULT_A_OFFSET)?;
    let vault_b         = read_pubkey(data, POOL_VAULT_B_OFFSET)?;
    let reserve_a       = read_u64_le(data, POOL_RESERVE_A_OFFSET)?;
    let reserve_b       = read_u64_le(data, POOL_RESERVE_B_OFFSET)?;
    let mint_a_decimals = data.get(POOL_MINT_A_DECIMALS_OFFSET).copied().unwrap_or(0);
    let mint_b_decimals = data.get(POOL_MINT_B_DECIMALS_OFFSET).copied().unwrap_or(0);
    if reserve_a == 0 {
        return Err(anyhow!("reserve_a == 0"));
    }
    let exp_a = if mint_a_decimals == 0 { 9i32 } else { mint_a_decimals as i32 };
    let exp_b = if mint_b_decimals == 0 { 6i32 } else { mint_b_decimals as i32 };
    let net   = exp_a + 6 - exp_b;
    let pool_price = if net >= 0 {
        (reserve_b as f64) * 10f64.powi(net) / (reserve_a as f64) / 1_000_000.0
    } else {
        (reserve_b as f64) / 10f64.powi(-net) / (reserve_a as f64) / 1_000_000.0
    };
    Ok((pool_price, vault_a, vault_b))
}

/// SPL ATA derivation: [wallet, token_program, mint]
fn derive_wsol_ata(owner: &Pubkey) -> Pubkey {
    let token_program = Pubkey::from_str(TOKEN_PROGRAM).unwrap();
    let wsol_mint     = Pubkey::from_str(WSOL_MINT).unwrap();
    spl_associated_token_account::get_associated_token_address_with_program_id(
        owner,
        &wsol_mint,
        &token_program,
    )
}

fn build_rebalance_ix(
    trampa_program:       &Pubkey,
    pool:                 &Pubkey,
    vault_a:              &Pubkey,
    vault_b:              &Pubkey,
    oracle:               &Pubkey,
    payer:                &Pubkey,
    caller_token_account: &Pubkey,
) -> Instruction {
    let token_program = Pubkey::from_str(TOKEN_PROGRAM).unwrap();
    let clock_sysvar  = Pubkey::from_str(CLOCK_SYSVAR).unwrap();

    Instruction {
        program_id: *trampa_program,
        accounts: vec![
            AccountMeta::new(*payer,                true),  // [0] signer writable
            AccountMeta::new(*pool,                 false), // [1] writable
            AccountMeta::new(*vault_a,              false), // [2] writable
            AccountMeta::new(*vault_b,              false), // [3] writable
            AccountMeta::new_readonly(*oracle,      false), // [4] readonly
            AccountMeta::new(*caller_token_account, false), // [5] writable
            AccountMeta::new_readonly(token_program, false),// [6] readonly
            AccountMeta::new_readonly(clock_sysvar, false), // [7] readonly
        ],
        data: vec![2u8], // discriminator = 2
    }
}

fn make_v0_tx(
    payer:      &Pubkey,
    keypair:    &Keypair,
    ixs:        &[Instruction],
    blockhash:  solana_sdk::hash::Hash,
) -> Result<VersionedTransaction> {
    let msg = v0::Message::try_compile(
        payer,
        ixs,
        &[] as &[AddressLookupTableAccount],
        blockhash,
    )?;
    let tx = VersionedTransaction::try_new(VersionedMessage::V0(msg), &[keypair])?;
    Ok(tx)
}

fn build_magnetar_update_ix(
    trampa_program: &Pubkey,
    magnetar_pda:   &Pubkey,
    magnetar_bump:  u8,
    payer:          &Pubkey,
    pool_pk:        &Pubkey,
    oracle_price:   f64,
    pool_price:     f64,
    div_bps:        u64,
    reserve_a:      u64,
    reserve_b:      u64,
) -> Instruction {
    let mut data = Vec::with_capacity(83);
    data.push(5u8);             // discriminator (consumed by lib.rs before reaching instruction)
    data.push(magnetar_bump);   // data[0] in instruction: bump
    data.push(1u8);             // data[1] in instruction: count = 1 entry

    // MagnetarEntry: 80 bytes
    data.extend_from_slice(pool_pk.as_ref());                          // pool: [u8; 32]
    let oracle_micros = (oracle_price * 1_000_000.0) as u64;
    data.extend_from_slice(&oracle_micros.to_le_bytes());              // oracle_price: u64
    let pool_micros = (pool_price * 1_000_000.0) as u64;
    data.extend_from_slice(&pool_micros.to_le_bytes());                // pool_price: u64
    data.extend_from_slice(&(div_bps as u16).to_le_bytes());          // divergence_bps: u16
    data.extend_from_slice(&[0u8; 6]);                                 // _pad: [u8; 6]
    data.extend_from_slice(&reserve_a.to_le_bytes());                  // reserve_a: u64
    data.extend_from_slice(&reserve_b.to_le_bytes());                  // reserve_b: u64
    data.extend_from_slice(&0u64.to_le_bytes());                       // propina_24h: u64 = 0

    Instruction {
        program_id: *trampa_program,
        accounts: vec![
            AccountMeta::new(*payer,        true),  // [0] payer signer writable
            AccountMeta::new(*magnetar_pda, false), // [1] magnetar_pda writable
            AccountMeta::new_readonly(system_program::id(), false), // [2] system_program
        ],
        data,
    }
}

/// Instruction 8 — update_synthetic_oracle (permissionless)
/// Accounts: [0] payer, [1] synth_oracle PDA, [2] stake_pool, [3] sol_oracle, [4] system_program
/// Data: [0]=8 (discriminator), [1]=bump (254), [2]=mode (0=SOL)
fn build_synth_oracle_update_ix(
    trampa_program: &Pubkey,
    payer:          &Pubkey,
    synth_oracle:   &Pubkey,
    stake_pool:     &Pubkey,
    sol_oracle:     &Pubkey,
) -> Instruction {
    let system_program = Pubkey::from_str("11111111111111111111111111111111").unwrap();
    Instruction {
        program_id: *trampa_program,
        accounts: vec![
            AccountMeta::new(*payer,        true),
            AccountMeta::new(*synth_oracle,  false),
            AccountMeta::new_readonly(*stake_pool,    false),
            AccountMeta::new_readonly(*sol_oracle,    false),
            AccountMeta::new_readonly(system_program, false),
        ],
        data: vec![8u8, 254u8, 0u8], // discriminator=8, bump=254, mode=0
    }
}

async fn send_jito_bundle(
    txs:  Vec<VersionedTransaction>,
    http: &reqwest::Client,
) -> Result<String> {
    let encoded: Vec<String> = txs
        .iter()
        .map(|tx| {
            let raw = bincode::serialize(tx).expect("serialize tx");
            B64.encode(&raw)
        })
        .collect();

    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id":      1,
        "method":  "sendBundle",
        "params":  [encoded]
    });

    let resp = http
        .post(JITO_URL)
        .json(&body)
        .timeout(Duration::from_secs(10))
        .send()
        .await?
        .text()
        .await?;

    Ok(resp)
}

// ── main ──────────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "iman_escorpion=info".parse().unwrap()),
        )
        .with_target(false)
        .init();

    let rpc_url = std::env::var("RPC_URL")
        .unwrap_or_else(|_| "https://api.mainnet-beta.solana.com".to_string());
    let keypair_path = std::env::var("KEYPAIR_PATH")
        .unwrap_or_else(|_| "/root/.keys/fvxmbh.json".to_string());
    let dry_run = std::env::var("DRY_RUN")
        .map(|v| v != "false" && v != "0")
        .unwrap_or(true); // safe default
    let threshold_bps: u64 = std::env::var("THRESHOLD_BPS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(10);

    let keypair = load_keypair(&keypair_path)?;
    let payer   = keypair.pubkey();

    let rpc    = RpcClient::new_with_commitment(rpc_url, CommitmentConfig::processed());
    let http   = reqwest::Client::new();

    let trampa_program = Pubkey::from_str(TRAMPA_PROGRAM)?;
    let pool_pk        = Pubkey::from_str(TRAMPA_POOL)?;
    let oracle_pk      = Pubkey::from_str(PYTH_ORACLE)?;
    let jito_tip_pk    = Pubkey::from_str(JITO_TIP)?;
    let caller_ata     = derive_wsol_ata(&payer);

    // log SPL_ATA_PROG is accessible (compile-time check via Pubkey parse)
    let _ = Pubkey::from_str(SPL_ATA_PROG)?;

    let (magnetar_pda, magnetar_bump) =
        Pubkey::find_program_address(&[b"magnetar"], &trampa_program);

    let pools = vec![
        PoolConfig { pool_pk: Pubkey::from_str(TRAMPA_POOL)?,  oracle_pk: Pubkey::from_str(PYTH_ORACLE)? },
        PoolConfig { pool_pk: Pubkey::from_str(MSOL_POOL)?,    oracle_pk: Pubkey::from_str(MSOL_ORACLE)? },
        PoolConfig { pool_pk: Pubkey::from_str(JITOSOL_POOL)?, oracle_pk: Pubkey::from_str(JITOSOL_ORACLE)? },
    ];
    let jito_stake_pool_pk = Pubkey::from_str(JITO_STAKE_POOL)?;
    let sol_usd_oracle_pk  = Pubkey::from_str(SOL_USD_ORACLE)?;
    let synth_oracle_pk    = Pubkey::from_str(JITOSOL_ORACLE)?;

    info!(payer = %payer, dry_run, threshold_bps, magnetar = %magnetar_pda, "ESCORPIÓN starting");

    let mut slot: u64 = 0;
    let mut slot_counter: u64 = 0;

    loop {
        tokio::time::sleep(Duration::from_millis(400)).await;
        slot += 1;
        slot_counter += 1;

        // ── MAGNETAR update (every 100 slots, pool[0] only) ──────────────────
        if slot_counter % 100 == 0 {
            let oracle_data_0 = match rpc.get_account_data(&oracle_pk) {
                Ok(d)  => d,
                Err(e) => { warn!(slot, "magnetar oracle fetch: {e}"); vec![] }
            };
            let pool_data_0 = match rpc.get_account_data(&pool_pk) {
                Ok(d)  => d,
                Err(e) => { warn!(slot, "magnetar pool fetch: {e}"); vec![] }
            };
            if !oracle_data_0.is_empty() && !pool_data_0.is_empty() {
                if let (Ok(oracle_price_0), Ok((pool_price_0, _, _))) = (
                    parse_pyth_price(&oracle_data_0),
                    parse_pool_state(&pool_data_0),
                ) {
                    let div_bps_0 = ((oracle_price_0 - pool_price_0).abs() / oracle_price_0 * 10_000.0) as u64;
                    let reserve_a = read_u64_le(&pool_data_0, POOL_RESERVE_A_OFFSET).unwrap_or(0);
                    let reserve_b = read_u64_le(&pool_data_0, POOL_RESERVE_B_OFFSET).unwrap_or(0);
                    if dry_run {
                        info!(slot, "DRY_RUN: would update MAGNETAR");
                    } else {
                        match rpc.get_latest_blockhash() {
                            Ok(bh) => {
                                let mag_ix = build_magnetar_update_ix(
                                    &trampa_program,
                                    &magnetar_pda,
                                    magnetar_bump,
                                    &payer,
                                    &pool_pk,
                                    oracle_price_0,
                                    pool_price_0,
                                    div_bps_0,
                                    reserve_a,
                                    reserve_b,
                                );
                                match make_v0_tx(&payer, &keypair, &[mag_ix], bh) {
                                    Ok(tx) => match rpc.send_transaction(&tx) {
                                        Ok(sig) => info!(slot, %sig, "magnetar updated"),
                                        Err(e)  => warn!(slot, "magnetar send: {e}"),
                                    },
                                    Err(e) => warn!(slot, "magnetar tx build: {e}"),
                                }
                            }
                            Err(e) => warn!(slot, "magnetar blockhash: {e}"),
                        }
                    }
                }
            }

            // ── synth oracle refresh (every 100 slots) ────────────────────────
            if !dry_run {
                match rpc.get_latest_blockhash() {
                    Ok(bh) => {
                        let synth_ix = build_synth_oracle_update_ix(
                            &trampa_program,
                            &payer,
                            &synth_oracle_pk,
                            &jito_stake_pool_pk,
                            &sol_usd_oracle_pk,
                        );
                        match make_v0_tx(&payer, &keypair, &[synth_ix], bh) {
                            Ok(tx) => match rpc.send_transaction(&tx) {
                                Ok(sig) => info!(slot, %sig, "synth oracle refreshed"),
                                Err(e)  => warn!(slot, "synth oracle send: {e}"),
                            },
                            Err(e) => warn!(slot, "synth oracle tx: {e}"),
                        }
                    }
                    Err(e) => warn!(slot, "synth oracle blockhash: {e}"),
                }
            }
        }

        // ── per-pool oracle/divergence/rebalance loop ─────────────────────────
        for pool_cfg in &pools {
            let oracle_data = match rpc.get_account_data(&pool_cfg.oracle_pk) {
                Ok(d)  => d,
                Err(e) => { warn!(slot, pool=%pool_cfg.pool_pk, "oracle fetch: {e}"); continue; }
            };
            let oracle_price = match parse_pyth_price(&oracle_data) {
                Ok(p)  => p,
                Err(e) => { warn!(slot, pool=%pool_cfg.pool_pk, "pyth parse: {e}"); continue; }
            };

            let pool_data = match rpc.get_account_data(&pool_cfg.pool_pk) {
                Ok(d)  => d,
                Err(e) => { warn!(slot, pool=%pool_cfg.pool_pk, "pool fetch: {e}"); continue; }
            };
            let (pool_price, vault_a, vault_b) = match parse_pool_state(&pool_data) {
                Ok(v)  => v,
                Err(e) => { warn!(slot, pool=%pool_cfg.pool_pk, "pool parse: {e}"); continue; }
            };

            let div_bps = ((oracle_price - pool_price).abs() / oracle_price * 10_000.0) as u64;
            let action  = if div_bps > threshold_bps { "REBALANCE" } else { "ok" };

            info!(
                pool = %pool_cfg.pool_pk,
                "oracle=${:.4} pool=${:.4} div={}bps [{}]",
                oracle_price, pool_price, div_bps, action
            );

            if div_bps <= threshold_bps {
                continue;
            }

            if rpc.get_account(&caller_ata).is_err() {
                warn!(slot, pool=%pool_cfg.pool_pk, ata=%caller_ata, "WSOL ATA missing — skipping");
                continue;
            }

            if dry_run {
                info!(slot, pool=%pool_cfg.pool_pk, "DRY_RUN: would send Jito bundle [tip + rebalance]");
                continue;
            }

            let blockhash = match rpc.get_latest_blockhash() {
                Ok(bh) => bh,
                Err(e) => { warn!(slot, pool=%pool_cfg.pool_pk, "blockhash: {e}"); continue; }
            };

            let tip_ix = system_instruction::transfer(&payer, &jito_tip_pk, TIP_LAMPORTS);
            let tip_tx = match make_v0_tx(&payer, &keypair, &[tip_ix], blockhash) {
                Ok(tx) => tx,
                Err(e) => { warn!(slot, pool=%pool_cfg.pool_pk, "tip_tx build: {e}"); continue; }
            };

            let rebalance_ix = build_rebalance_ix(
                &trampa_program,
                &pool_cfg.pool_pk,
                &vault_a,
                &vault_b,
                &pool_cfg.oracle_pk,
                &payer,
                &caller_ata,
            );
            let rebalance_tx = match make_v0_tx(&payer, &keypair, &[rebalance_ix], blockhash) {
                Ok(tx) => tx,
                Err(e) => { warn!(slot, pool=%pool_cfg.pool_pk, "rebalance_tx build: {e}"); continue; }
            };

            match send_jito_bundle(vec![tip_tx, rebalance_tx], &http).await {
                Ok(resp) => info!(slot, pool=%pool_cfg.pool_pk, resp=resp.trim(), "bundle sent"),
                Err(e)   => warn!(slot, pool=%pool_cfg.pool_pk, "bundle send: {e}"),
            }
        }
    }
}
