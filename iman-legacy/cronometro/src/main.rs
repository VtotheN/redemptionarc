/// CRONÓMETRO — Cross-DEX arb monitor for IMÁN v3
///
/// Mode B (24/7): Orca CLMM vs non-Orca spread detection + Jito bundle execution
///   Pairs: SOL/USDC, JitoSOL/USDC, mSOL/USDC (all scanned in parallel)
/// Mode A (epoch): auto-activates when |slot - epoch_boundary| < 500
///
/// Deploy: /root/iman-cronometro/
/// Service: iman-cronometro.service (systemd)
use anyhow::{anyhow, Result};
use base64::Engine;
use serde::{Deserialize, Serialize};
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_sdk::{
    commitment_config::CommitmentConfig,
    compute_budget::ComputeBudgetInstruction,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_instruction,
    transaction::Transaction,
};
use std::{env, fs, str::FromStr, sync::Arc, time::{Duration, Instant}};
use tokio::sync::Mutex;
use tracing::{error, info, warn};

// ─── Constants ─────────────────────────────────────────────────────────────

/// Orca Whirlpool SOL/USDC 4bps — most liquid CLMM
const ORCA_POOL:  &str = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE";
const ORCA_PROG:  &str = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";

const WSOL_MINT:    &str = "So11111111111111111111111111111111111111112";
const USDC_MINT:    &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const JITOSOL_MINT: &str = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";
const MSOL_MINT:    &str = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";

const POZO_PROG:  &str = "ADuge9aMsakJ29NUjisBU15bDkd2n72dUxDu97GLK82v";
const POZO_STATE: &str = "3nuaHD8aYhxTwCEk5ae8rLcuydMJGtppwznT7k6ZgszX";
const POZO_VAULT: &str = "BGTStf2cX4GcdFZJ6MRgiBUQYKAjiQgVEwh824Q47oDs";
const POZO_BUMP:   u8  = 255;
const POZO_AUTH:  &str = "FVxMBHVbyPqqo6ANaY4RM1h7JBJaRHuPTF9XehwaWztp";

/// Jito tip accounts (rotate round-robin)
const JITO_TIPS: &[&str] = &[
    "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
    "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
    "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
    "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
];
const JITO_URL: &str = "https://mainnet.block-engine.jito.wtf/api/v1/bundles";

// Probe + exec Orca leg. V2=30bps legacy (only mSOL route). CLMM/Whirlpool=4bps for SOL/USDC.
// Jupiter picks best pool from this list; net-profit check catches bad routes.
// TODO: once routePlan shows Jupiter using CLMM for SOL, can restrict to CLMM+Whirlpool for SOL exec.
const ORCA_PROBE_DEXES: &str = "Orca%20V2,Orca%20CLMM,Orca%20Whirlpool";
const ORCA_EXEC_DEXES:  &str = "Orca%20V2,Orca%20CLMM,Orca%20Whirlpool";
// Non-Orca leg: keep Raydium CPMM/CLMM available (4bps), only exclude Orca pools.
const EXCLUDE_ORCA:     &str = "Orca%20V2,Orca%20CLMM,Orca%20Whirlpool";

/// Orca whirlpool account layout offsets
const ORCA_SQRT_PRICE_OFFSET: usize = 65;
const ORCA_TICK_OFFSET:       usize = 81;
const ORCA_TICK_SPACING_OFFSET: usize = 41;
const ORCA_VAULT_A_OFFSET:    usize = 133;
const ORCA_VAULT_B_OFFSET:    usize = 213;

const SPL_AMOUNT_OFFSET: usize = 64;
const EPOCH_WINDOW_SLOTS: u64  = 500;

// ─── Config ────────────────────────────────────────────────────────────────

type PriceCache  = Arc<Mutex<Option<(f64, Instant)>>>;
/// Tracks timestamp of last Jupiter HTTP call — enforces min gap between calls
type JupLimiter  = Arc<Mutex<Instant>>;

fn new_cache()   -> PriceCache { Arc::new(Mutex::new(None)) }
fn new_limiter() -> JupLimiter { Arc::new(Mutex::new(Instant::now() - Duration::from_secs(10))) }

struct Config {
    keypair:          Keypair,
    rpc_url:          String,
    rpc_client:       RpcClient,
    http:             reqwest::Client,
    jup_limiter:      JupLimiter,
    /// SOL/USDC — non-Orca market price cache
    sol_market_cache: PriceCache,
    /// JitoSOL/USDC — Orca price cache
    jito_orca_cache:  PriceCache,
    /// JitoSOL/USDC — non-Orca market price cache
    jito_mkt_cache:   PriceCache,
    /// mSOL/USDC — Orca price cache
    msol_orca_cache:  PriceCache,
    /// mSOL/USDC — non-Orca market price cache
    msol_mkt_cache:   PriceCache,
    min_spread_bps:   f64,
    arb_usdc_amount:  u64,
    ray_probe_usdc:   u64,
    use_flash:        bool,
    tip_lamports:     u64,
    dry_run:          bool,
}

impl Config {
    fn from_env() -> Result<Self> {
        let keypair_path = env::var("KEYPAIR_PATH")
            .unwrap_or_else(|_| "/root/.keys/fvxmbh.json".to_string());
        let raw = fs::read_to_string(&keypair_path)?;
        let bytes: Vec<u8> = serde_json::from_str(&raw)?;
        let keypair = Keypair::from_bytes(&bytes)?;

        let rpc_url = env::var("RPC_URL")
            .unwrap_or_else(|_| "https://solana.publicnode.com".to_string());
        let rpc_client = RpcClient::new_with_timeout_and_commitment(
            rpc_url.clone(),
            Duration::from_secs(8),
            CommitmentConfig::confirmed(),
        );

        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(8))
            .build()?;

        let tip_lamports: u64 = env::var("TIP_LAMPORTS")
            .unwrap_or_else(|_| "10000".to_string()).parse()?;
        let arb_usdc_amount: u64 = env::var("ARB_USDC_AMOUNT")
            .unwrap_or_else(|_| "50000000".to_string()).parse()?;

        Ok(Config {
            keypair,
            rpc_url,
            rpc_client,
            http,
            jup_limiter: new_limiter(),
            sol_market_cache: new_cache(),
            jito_orca_cache:  new_cache(),
            jito_mkt_cache:   new_cache(),
            msol_orca_cache:  new_cache(),
            msol_mkt_cache:   new_cache(),
            min_spread_bps: env::var("MIN_SPREAD_BPS")
                .unwrap_or_else(|_| "2".to_string()).parse()?,
            arb_usdc_amount,
            ray_probe_usdc: env::var("RAY_PROBE_USDC")
                .unwrap_or_else(|_| "10000000".to_string()).parse()?,
            use_flash: env::var("USE_FLASH")
                .unwrap_or_else(|_| "false".to_string()).parse().unwrap_or(false),
            tip_lamports,
            dry_run: env::var("DRY_RUN")
                .unwrap_or_else(|_| "false".to_string()).parse().unwrap_or(false),
        })
    }
}

// ─── Threshold ─────────────────────────────────────────────────────────────

/// Dynamic threshold: max(breakeven*1.5, min_spread_bps_env)
/// breakeven_bps = (tip_lamports / arb_usdc_amount) * 10_000
fn effective_threshold(cfg: &Config) -> f64 {
    let breakeven = (cfg.tip_lamports as f64 / cfg.arb_usdc_amount as f64) * 10_000.0;
    f64::max(breakeven * 1.5, cfg.min_spread_bps)
}

// ─── Price types ───────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct Prices {
    orca_usd:    f64,
    market_usd:  f64,
}

impl Prices {
    fn spread_bps(&self) -> f64 {
        let denom = self.orca_usd.min(self.market_usd);
        if denom == 0.0 { return 0.0; }
        ((self.orca_usd - self.market_usd).abs() / denom) * 10_000.0
    }

    fn orca_is_cheaper(&self) -> bool {
        self.orca_usd < self.market_usd
    }
}

// ─── Price reading — SOL/USDC ───────────────────────────────────────────────

async fn get_sol_prices(cfg: &Config) -> Result<(Prices, OrcaPoolInfo)> {
    let orca_key = Pubkey::from_str(ORCA_POOL)?;
    let accs = cfg.rpc_client.get_multiple_accounts(&[orca_key]).await?;
    let orca_data = accs[0].as_ref()
        .ok_or_else(|| anyhow!("Orca SOL/USDC pool not found"))?
        .data.clone();

    let orca_info  = parse_orca_pool(&orca_data)?;
    let orca_price = sqrt_price_to_usd(orca_info.sqrt_price);
    let market_price = probe_market_price(
        &cfg.http, &cfg.jup_limiter, USDC_MINT, WSOL_MINT, cfg.ray_probe_usdc, true, &cfg.sol_market_cache,
    ).await?;

    Ok((Prices { orca_usd: orca_price, market_usd: market_price }, orca_info))
}

// ─── Price reading — LST/USDC ───────────────────────────────────────────────

/// Returns prices for given LST mint. Sequential to avoid Jupiter burst.
async fn get_lst_prices(
    cfg: &Config,
    lst_mint: &str,
    orca_cache: &PriceCache,
    mkt_cache: &PriceCache,
) -> Result<Prices> {
    let orca_usd   = probe_market_price(&cfg.http, &cfg.jup_limiter, USDC_MINT, lst_mint, cfg.ray_probe_usdc, false, orca_cache).await?;
    let market_usd = probe_market_price(&cfg.http, &cfg.jup_limiter, USDC_MINT, lst_mint, cfg.ray_probe_usdc, true,  mkt_cache).await?;
    Ok(Prices { orca_usd, market_usd })
}

/// Jupiter USDC→output quote.
/// exclude_orca=false → Orca-only routes (price discovery for Orca side)
/// exclude_orca=true  → non-Orca market price
// Jupiter free tier: 1 RPS strict. 2000ms gap → max 0.5 RPS, well clear of limit.
async fn jup_acquire(limiter: &JupLimiter) {
    const MIN_GAP: Duration = Duration::from_millis(2000);
    loop {
        let elapsed = {
            let g = limiter.lock().await;
            g.elapsed()
        };
        if elapsed >= MIN_GAP { break; }
        tokio::time::sleep(MIN_GAP - elapsed).await;
    }
    *limiter.lock().await = Instant::now();
}

async fn probe_market_price(
    http: &reqwest::Client,
    limiter: &JupLimiter,
    input_mint: &str,
    output_mint: &str,
    probe_input: u64,
    exclude_orca: bool,
    cache: &PriceCache,
) -> Result<f64> {
    const CACHE_SECS: u64 = 60;
    {
        let g = cache.lock().await;
        if let Some((price, ts)) = *g {
            if ts.elapsed().as_secs() < CACHE_SECS {
                return Ok(price);
            }
        }
    }
    jup_acquire(limiter).await;
    let filter = if exclude_orca {
        format!("&excludeDexes={EXCLUDE_ORCA}")
    } else {
        format!("&dexes={ORCA_PROBE_DEXES}")
    };
    let url = format!(
        "https://api.jup.ag/swap/v1/quote?inputMint={input_mint}&outputMint={output_mint}&amount={probe_input}&slippageBps=50{filter}"
    );
    let resp: serde_json::Value = http.get(&url).send().await?
        .json().await
        .map_err(|e| anyhow!("Jupiter probe parse: {e}"))?;

    // 429 → serve stale cache if available, else propagate
    if resp.get("code").and_then(|c| c.as_u64()) == Some(429) {
        let g = cache.lock().await;
        if let Some((price, _)) = *g {
            return Ok(price);
        }
        return Err(anyhow!("Jupiter 429, no cached price yet"));
    }

    if let Some(err) = resp.get("error") {
        return Err(anyhow!("Jupiter probe no routes: {err}"));
    }
    let out: u64 = resp["outAmount"].as_str()
        .ok_or_else(|| anyhow!("no outAmount in probe resp={}", &resp.to_string()[..resp.to_string().len().min(150)]))?
        .parse()?;
    if out == 0 { return Err(anyhow!("Jupiter probe returned 0 out")); }
    // input is USDC μ (6 dec), output is SOL/LST lamports (9 dec)
    // price = USDC per token = (probe_input/1e6) / (out/1e9) = probe_input * 1e3 / out
    let price = (probe_input as f64 / out as f64) * 1_000.0;
    *cache.lock().await = Some((price, Instant::now()));
    Ok(price)
}

#[derive(Debug, Clone)]
struct OrcaPoolInfo {
    sqrt_price:   u128,
    tick:         i32,
    tick_spacing: u16,
    vault_a:      Pubkey,
    vault_b:      Pubkey,
}

fn parse_orca_pool(data: &[u8]) -> Result<OrcaPoolInfo> {
    if data.len() < ORCA_VAULT_B_OFFSET + 32 {
        return Err(anyhow!("Orca pool data too short: {} bytes", data.len()));
    }
    let sqrt_price = u128::from_le_bytes(
        data[ORCA_SQRT_PRICE_OFFSET..ORCA_SQRT_PRICE_OFFSET+16].try_into()?
    );
    let tick = i32::from_le_bytes(
        data[ORCA_TICK_OFFSET..ORCA_TICK_OFFSET+4].try_into()?
    );
    let tick_spacing = u16::from_le_bytes(
        data[ORCA_TICK_SPACING_OFFSET..ORCA_TICK_SPACING_OFFSET+2].try_into()?
    );
    let vault_a = Pubkey::from(<[u8;32]>::try_from(&data[ORCA_VAULT_A_OFFSET..ORCA_VAULT_A_OFFSET+32])?);
    let vault_b = Pubkey::from(<[u8;32]>::try_from(&data[ORCA_VAULT_B_OFFSET..ORCA_VAULT_B_OFFSET+32])?);
    Ok(OrcaPoolInfo { sqrt_price, tick, tick_spacing, vault_a, vault_b })
}

fn sqrt_price_to_usd(sqrt_price: u128) -> f64 {
    let sp = sqrt_price as f64;
    let divisor = (1u128 << 64) as f64;
    let raw = (sp / divisor).powi(2);
    raw * 1_000.0
}


// ─── Orca tick arrays ───────────────────────────────────────────────────────

fn tick_array_start(tick: i32, tick_spacing: u16, offset: i32) -> i32 {
    let ticks_per_arr = 88i32 * tick_spacing as i32;
    let mod_ = ((tick % ticks_per_arr) + ticks_per_arr) % ticks_per_arr;
    let start = tick - mod_;
    start + offset * ticks_per_arr
}

fn tick_array_pda(pool: &Pubkey, start_tick: i32, prog: &Pubkey) -> Pubkey {
    let start_str = start_tick.to_string();
    Pubkey::find_program_address(
        &[b"tick_array", pool.as_ref(), start_str.as_bytes()],
        prog,
    ).0
}

fn orca_tick_arrays(pool: &Pubkey, tick: i32, tick_spacing: u16, a_to_b: bool, prog: &Pubkey) -> [Pubkey; 3] {
    let offsets: [i32; 3] = if a_to_b { [0, -1, -2] } else { [0, 1, 2] };
    std::array::from_fn(|i| {
        let start = tick_array_start(tick, tick_spacing, offsets[i]);
        tick_array_pda(pool, start, prog)
    })
}

fn orca_oracle_pda(pool: &Pubkey, prog: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"oracle", pool.as_ref()], prog).0
}

// ─── Jupiter API ───────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct JupiterQuote {
    #[serde(rename = "routePlan")]
    route_plan: serde_json::Value,
    #[serde(rename = "outAmount")]
    out_amount: String,
    #[serde(rename = "inAmount")]
    in_amount: String,
}

#[derive(Deserialize)]
struct JupiterSwapResponse {
    #[serde(rename = "swapTransaction")]
    swap_transaction: String,
}

async fn jupiter_swap_tx(
    quote: &JupiterQuote,
    user_pubkey: &str,
    quote_raw: serde_json::Value,
) -> Result<Vec<u8>> {
    let body = serde_json::json!({
        "quoteResponse": quote_raw,
        "userPublicKey": user_pubkey,
        "wrapAndUnwrapSol": true,
        "computeUnitPriceMicroLamports": 50_000,
    });
    let client = reqwest::Client::new();
    let resp: JupiterSwapResponse = client
        .post("https://api.jup.ag/swap/v1/swap")
        .json(&body)
        .send()
        .await?
        .json()
        .await
        .map_err(|e| anyhow!("Jupiter swap error: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.decode(&resp.swap_transaction)?)
}

// ─── POZO flash loan instructions ─────────────────────────────────────────

fn pozo_borrow_ix(borrower: &Pubkey, amount: u64) -> Result<Instruction> {
    let pozo_prog  = Pubkey::from_str(POZO_PROG)?;
    let pozo_state = Pubkey::from_str(POZO_STATE)?;
    let pozo_vault = Pubkey::from_str(POZO_VAULT)?;
    let usdc_mint  = Pubkey::from_str(USDC_MINT)?;
    let spl_prog   = spl_token::ID;
    let ix_sysvar  = solana_sdk::sysvar::instructions::ID;
    let clock_sys  = solana_sdk::sysvar::clock::ID;

    let recipient_ata = spl_associated_token_account::get_associated_token_address(
        borrower, &usdc_mint,
    );

    let mut data = vec![1u8];
    data.extend_from_slice(&amount.to_le_bytes());

    Ok(Instruction {
        program_id: pozo_prog,
        accounts: vec![
            AccountMeta::new_readonly(*borrower, true),
            AccountMeta::new(pozo_state, false),
            AccountMeta::new(pozo_vault, false),
            AccountMeta::new(recipient_ata, false),
            AccountMeta::new_readonly(spl_prog, false),
            AccountMeta::new_readonly(ix_sysvar, false),
            AccountMeta::new_readonly(clock_sys, false),
        ],
        data,
    })
}

fn pozo_repay_ix(repayer: &Pubkey, amount: u64) -> Result<Instruction> {
    let pozo_prog  = Pubkey::from_str(POZO_PROG)?;
    let pozo_state = Pubkey::from_str(POZO_STATE)?;
    let pozo_vault = Pubkey::from_str(POZO_VAULT)?;
    let usdc_mint  = Pubkey::from_str(USDC_MINT)?;
    let spl_prog   = spl_token::ID;

    let repayer_ata = spl_associated_token_account::get_associated_token_address(
        repayer, &usdc_mint,
    );

    let mut data = vec![2u8];
    data.extend_from_slice(&amount.to_le_bytes());

    Ok(Instruction {
        program_id: pozo_prog,
        accounts: vec![
            AccountMeta::new_readonly(*repayer, true),
            AccountMeta::new(pozo_state, false),
            AccountMeta::new(pozo_vault, false),
            AccountMeta::new(repayer_ata, false),
            AccountMeta::new_readonly(spl_prog, false),
        ],
        data,
    })
}

// ─── Jito bundle ──────────────────────────────────────────────────────────

#[derive(Serialize)]
struct JitoBundleRequest {
    jsonrpc: String,
    id: u64,
    method: String,
    params: Vec<serde_json::Value>,
}

async fn send_jito_bundle(txs: Vec<Vec<u8>>) -> Result<String> {
    let encoded: Vec<String> = txs.iter()
        .map(|tx| base64::engine::general_purpose::STANDARD.encode(tx))
        .collect();
    let req = JitoBundleRequest {
        jsonrpc: "2.0".into(),
        id: 1,
        method: "sendBundle".into(),
        params: vec![serde_json::json!(encoded)],
    };
    let client = reqwest::Client::new();
    let resp: serde_json::Value = client
        .post(JITO_URL)
        .json(&req)
        .send()
        .await?
        .json()
        .await?;
    if let Some(e) = resp.get("error") {
        return Err(anyhow!("Jito error: {e}"));
    }
    Ok(resp["result"].to_string())
}

fn build_tip_tx(keypair: &Keypair, tip_lamports: u64, blockhash: &solana_sdk::hash::Hash) -> Result<Vec<u8>> {
    let tip_idx = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?.as_secs() % JITO_TIPS.len() as u64) as usize;
    let tip_acct = Pubkey::from_str(JITO_TIPS[tip_idx])?;
    let tx = Transaction::new_signed_with_payer(
        &[system_instruction::transfer(&keypair.pubkey(), &tip_acct, tip_lamports)],
        Some(&keypair.pubkey()),
        &[keypair],
        *blockhash,
    );
    Ok(bincode::serialize(&tx)?)
}

// ─── Mode A — Epoch spike ──────────────────────────────────────────────────

/// Fetch quotes + build signed (buy_tx, sell_tx) for one arb leg.
/// Returns None (not Err) if quotes are net negative.
async fn build_arb_leg(
    cfg: &Config,
    prices: &Prices,
    inner_mint: &str,
    amount: u64,
    payer: &str,
    blockhash: &solana_sdk::hash::Hash,
) -> Result<Option<(Vec<u8>, Vec<u8>, f64)>> {
    let orca_buy = prices.orca_is_cheaper();
    let buy_dex  = if orca_buy { format!("&dexes={ORCA_EXEC_DEXES}") }
                   else        { format!("&excludeDexes={EXCLUDE_ORCA}") };
    let sell_dex = if orca_buy { format!("&excludeDexes={EXCLUDE_ORCA}") }
                   else        { format!("&dexes={ORCA_EXEC_DEXES}") };

    jup_acquire(&cfg.jup_limiter).await;
    let buy_raw = cfg.http.get(format!(
        "https://api.jup.ag/swap/v1/quote?inputMint={USDC_MINT}&outputMint={inner_mint}&amount={amount}&slippageBps=50{buy_dex}"
    )).send().await?.json::<serde_json::Value>().await?;
    if buy_raw.get("code").and_then(|c| c.as_u64()) == Some(429) {
        return Err(anyhow!("429 on buy leg"));
    }
    let out: u64 = buy_raw["outAmount"].as_str()
        .ok_or_else(|| anyhow!("no outAmount buy: {}", &buy_raw.to_string()[..buy_raw.to_string().len().min(150)]))?
        .parse()?;

    jup_acquire(&cfg.jup_limiter).await;
    let sell_raw = cfg.http.get(format!(
        "https://api.jup.ag/swap/v1/quote?inputMint={inner_mint}&outputMint={USDC_MINT}&amount={out}&slippageBps=50{sell_dex}"
    )).send().await?.json::<serde_json::Value>().await?;
    if sell_raw.get("code").and_then(|c| c.as_u64()) == Some(429) {
        return Err(anyhow!("429 on sell leg"));
    }

    let usdc_in:  u64 = buy_raw["inAmount"].as_str().ok_or(anyhow!("no inAmount"))?.parse()?;
    let usdc_out: u64 = sell_raw["outAmount"].as_str()
        .ok_or_else(|| anyhow!("no outAmount sell: {}", &sell_raw.to_string()[..sell_raw.to_string().len().min(150)]))?
        .parse()?;

    if usdc_out <= usdc_in { return Ok(None); }
    let profit = (usdc_out - usdc_in) as f64 / 1e6;

    let buy_q:  JupiterQuote = serde_json::from_value(buy_raw.clone()).map_err(|e| anyhow!("deser buy: {e}"))?;
    let sell_q: JupiterQuote = serde_json::from_value(sell_raw.clone()).map_err(|e| anyhow!("deser sell: {e}"))?;
    let buy_tx  = sign_versioned_tx(&jupiter_swap_tx(&buy_q,  payer, buy_raw).await?,  &cfg.keypair, blockhash)?;
    let sell_tx = sign_versioned_tx(&jupiter_swap_tx(&sell_q, payer, sell_raw).await?, &cfg.keypair, blockhash)?;
    Ok(Some((buy_tx, sell_tx, profit)))
}

/// Build + submit 1 Jito bundle with up to 2 arb legs (mSOL + JitoSOL).
/// TXs chain sequentially in bundle: sell leg returns USDC for next buy leg.
/// Jito max = 5 TXs → 4 arb TXs + 1 tip.
async fn run_mode_a_bundle(cfg: &Config) -> Result<()> {
    let threshold   = effective_threshold(cfg);
    let msol_prices = get_lst_prices(cfg, MSOL_MINT,    &cfg.msol_orca_cache, &cfg.msol_mkt_cache).await?;
    let jito_prices = get_lst_prices(cfg, JITOSOL_MINT, &cfg.jito_orca_cache, &cfg.jito_mkt_cache).await?;
    let ms = msol_prices.spread_bps();
    let js = jito_prices.spread_bps();
    info!("MODE_A: mSOL={:.1}bps jito={:.1}bps threshold={:.1}bps", ms, js, threshold);

    if ms <= threshold && js <= threshold {
        return Ok(());
    }

    let payer     = cfg.keypair.pubkey().to_string();
    let amount    = cfg.arb_usdc_amount;
    let blockhash = cfg.rpc_client.get_latest_blockhash().await?;
    let mut txs   = Vec::<Vec<u8>>::new();
    let mut total = 0.0f64;

    if ms > threshold {
        match build_arb_leg(cfg, &msol_prices, MSOL_MINT, amount, &payer, &blockhash).await {
            Ok(Some((b, s, p))) => { txs.push(b); txs.push(s); total += p; info!("MODE_A: mSOL +${:.4}", p); }
            Ok(None) => warn!("MODE_A: mSOL net negative"),
            Err(e)   => warn!("MODE_A: mSOL leg error: {e}"),
        }
    }
    // JitoSOL: only if room (max 4 arb TXs + 1 tip = 5 bundle limit)
    if js > threshold && txs.len() + 2 <= 4 {
        match build_arb_leg(cfg, &jito_prices, JITOSOL_MINT, amount, &payer, &blockhash).await {
            Ok(Some((b, s, p))) => { txs.push(b); txs.push(s); total += p; info!("MODE_A: JitoSOL +${:.4}", p); }
            Ok(None) => warn!("MODE_A: JitoSOL net negative"),
            Err(e)   => warn!("MODE_A: JitoSOL leg error: {e}"),
        }
    }

    if txs.is_empty() { info!("MODE_A: no profitable legs"); return Ok(()); }

    if cfg.dry_run {
        info!("MODE_A_DRY_RUN: {} arb TXs profit~=${:.4}", txs.len(), total);
        return Ok(());
    }

    txs.push(build_tip_tx(&cfg.keypair, cfg.tip_lamports, &blockhash)?);
    let id = send_jito_bundle(txs).await?;
    info!("MODE_A_BUNDLE_SENT id={id} profit~=${:.4}", total);
    Ok(())
}

/// Returns true if mode A fired (within epoch window).
async fn check_mode_a(cfg: &Config) -> Result<bool> {
    let epoch_info    = cfg.rpc_client.get_epoch_info().await?;
    let slots_left    = epoch_info.slots_in_epoch.saturating_sub(epoch_info.slot_index);
    if slots_left < EPOCH_WINDOW_SLOTS {
        info!("MODE_A: {} slots to epoch {}→{} boundary", slots_left, epoch_info.epoch, epoch_info.epoch + 1);
        run_mode_a_bundle(cfg).await?;
        return Ok(true);
    }
    Ok(false)
}

// ─── Mode B — Cross-DEX arb ────────────────────────────────────────────────

/// Execute arb for any pair. inner_mint = the token being arb'd (WSOL, JitoSOL, mSOL).
async fn run_mode_b(
    cfg: &Config,
    prices: &Prices,
    inner_mint: &str,
    pair_name: &str,
    orca_info: Option<&OrcaPoolInfo>,
) -> Result<()> {
    let spread = prices.spread_bps();
    let orca_buy = prices.orca_is_cheaper();

    info!(
        "ARB_{pair_name}: orca=${:.4} market=${:.4} spread={:.1}bps buy_orca={}",
        prices.orca_usd, prices.market_usd, spread, orca_buy
    );

    if cfg.dry_run {
        info!("DRY_RUN: skipping execution");
        return Ok(());
    }

    let payer_pk = cfg.keypair.pubkey().to_string();
    let amount   = cfg.arb_usdc_amount;

    let (buy_quote_raw, sell_quote_raw) = if orca_buy {
        jup_acquire(&cfg.jup_limiter).await;
        let buy = cfg.http.get(format!(
            "https://api.jup.ag/swap/v1/quote?inputMint={USDC_MINT}&outputMint={inner_mint}&amount={amount}&slippageBps=50&dexes={ORCA_EXEC_DEXES}"
        )).send().await?.json::<serde_json::Value>().await?;

        if buy.get("code").and_then(|c| c.as_u64()) == Some(429) {
            return Err(anyhow!("Jupiter 429 on exec buy"));
        }
        let out: u64 = buy["outAmount"].as_str()
            .ok_or_else(|| anyhow!("no outAmount buy (orca). resp={}", &buy.to_string()[..buy.to_string().len().min(200)]))?
            .parse()?;

        jup_acquire(&cfg.jup_limiter).await;
        let sell = cfg.http.get(format!(
            "https://api.jup.ag/swap/v1/quote?inputMint={inner_mint}&outputMint={USDC_MINT}&amount={out}&slippageBps=50&excludeDexes={EXCLUDE_ORCA}"
        )).send().await?.json::<serde_json::Value>().await?;
        if sell.get("code").and_then(|c| c.as_u64()) == Some(429) {
            return Err(anyhow!("Jupiter 429 on exec sell"));
        }

        (buy, sell)
    } else {
        jup_acquire(&cfg.jup_limiter).await;
        let buy = cfg.http.get(format!(
            "https://api.jup.ag/swap/v1/quote?inputMint={USDC_MINT}&outputMint={inner_mint}&amount={amount}&slippageBps=50&excludeDexes={EXCLUDE_ORCA}"
        )).send().await?.json::<serde_json::Value>().await?;

        if buy.get("code").and_then(|c| c.as_u64()) == Some(429) {
            return Err(anyhow!("Jupiter 429 on exec buy"));
        }
        let out: u64 = buy["outAmount"].as_str()
            .ok_or_else(|| anyhow!("no outAmount buy (mkt). resp={}", &buy.to_string()[..buy.to_string().len().min(200)]))?
            .parse()?;

        jup_acquire(&cfg.jup_limiter).await;
        let sell = cfg.http.get(format!(
            "https://api.jup.ag/swap/v1/quote?inputMint={inner_mint}&outputMint={USDC_MINT}&amount={out}&slippageBps=50&dexes={ORCA_EXEC_DEXES}"
        )).send().await?.json::<serde_json::Value>().await?;
        if sell.get("code").and_then(|c| c.as_u64()) == Some(429) {
            return Err(anyhow!("Jupiter 429 on exec sell"));
        }

        (buy, sell)
    };

    let usdc_in: u64  = buy_quote_raw["inAmount"].as_str()
        .ok_or(anyhow!("no inAmount"))?.parse()?;
    let usdc_out: u64 = sell_quote_raw["outAmount"].as_str()
        .ok_or_else(|| anyhow!("no outAmount sell. resp={}", &sell_quote_raw.to_string()[..sell_quote_raw.to_string().len().min(300)]))?
        .parse()?;

    // Always log route plan so we can diagnose routing costs
    let buy_route = buy_quote_raw["routePlan"].as_array()
        .map(|r| r.iter()
            .filter_map(|s| s["swapInfo"]["label"].as_str())
            .collect::<Vec<_>>().join("→"))
        .unwrap_or_default();
    let sell_route = sell_quote_raw["routePlan"].as_array()
        .map(|r| r.iter()
            .filter_map(|s| s["swapInfo"]["label"].as_str())
            .collect::<Vec<_>>().join("→"))
        .unwrap_or_default();

    if usdc_out <= usdc_in {
        warn!("quote net negative: in={usdc_in} out={usdc_out} routes=[{buy_route}]→[{sell_route}] — skipping");
        return Ok(());
    }
    let profit_usdc = (usdc_out - usdc_in) as f64 / 1e6;
    info!("quote profit=${profit_usdc:.4} USDC routes=[{buy_route}]→[{sell_route}]");

    let blockhash = cfg.rpc_client.get_latest_blockhash().await?;

    let buy_quote: JupiterQuote = serde_json::from_value(buy_quote_raw.clone())
        .map_err(|_| anyhow!("deserialize buy quote"))?;
    let sell_quote: JupiterQuote = serde_json::from_value(sell_quote_raw.clone())
        .map_err(|_| anyhow!("deserialize sell quote"))?;

    let buy_tx  = sign_versioned_tx(
        &jupiter_swap_tx(&buy_quote, &payer_pk, buy_quote_raw).await?,
        &cfg.keypair, &blockhash,
    )?;
    let sell_tx = sign_versioned_tx(
        &jupiter_swap_tx(&sell_quote, &payer_pk, sell_quote_raw).await?,
        &cfg.keypair, &blockhash,
    )?;
    let tip_tx = build_tip_tx(&cfg.keypair, cfg.tip_lamports, &blockhash)?;

    let bundle_id = send_jito_bundle(vec![buy_tx, sell_tx, tip_tx]).await?;
    info!("BUNDLE_SENT id={bundle_id} pair={pair_name} profit~=${profit_usdc:.4}");

    Ok(())
}

fn sign_versioned_tx(
    bytes: &[u8],
    keypair: &Keypair,
    blockhash: &solana_sdk::hash::Hash,
) -> Result<Vec<u8>> {
    use solana_sdk::transaction::VersionedTransaction;
    let mut tx: VersionedTransaction = bincode::deserialize(bytes)?;
    match &mut tx.message {
        solana_sdk::message::VersionedMessage::Legacy(m) => {
            m.recent_blockhash = *blockhash;
        }
        solana_sdk::message::VersionedMessage::V0(m) => {
            m.recent_blockhash = *blockhash;
        }
    }
    let msg_bytes = match &tx.message {
        solana_sdk::message::VersionedMessage::Legacy(m) => m.serialize(),
        solana_sdk::message::VersionedMessage::V0(m)     => m.serialize(),
    };
    let sig = keypair.sign_message(&msg_bytes);
    if tx.signatures.is_empty() {
        tx.signatures.push(sig);
    } else {
        tx.signatures[0] = sig;
    }
    Ok(bincode::serialize(&tx)?)
}

// ─── Main loop ────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("iman_cronometro=info".parse()?),
        )
        .init();

    info!("CRONÓMETRO starting…");
    let cfg = Config::from_env()?;
    let threshold = effective_threshold(&cfg);
    info!(
        "config: threshold={:.1}bps (min={}) amount=${:.2} USDC flash={} dry_run={}",
        threshold,
        cfg.min_spread_bps,
        cfg.arb_usdc_amount as f64 / 1e6,
        cfg.use_flash,
        cfg.dry_run
    );
    info!("pairs: SOL/USDC + JitoSOL/USDC + mSOL/USDC | Mode A: mSOL+JitoSOL bundle @ epoch boundary");

    let mut cycle: u64 = 0;
    let mut last_exec_sol:  Option<Instant> = None;
    let mut last_exec_jito: Option<Instant> = None;
    let mut last_exec_msol: Option<Instant> = None;
    let mut last_mode_a:    Option<Instant> = None;
    let mut near_epoch:     bool            = false;
    const EXEC_COOLDOWN:    Duration = Duration::from_secs(30);
    const MODE_A_COOLDOWN:  Duration = Duration::from_secs(30);

    loop {
        cycle += 1;
        let threshold = effective_threshold(&cfg);

        // Sequential fetches — avoids Jupiter burst (probes cached 30s, overhead negligible)
        let sol_result  = get_sol_prices(&cfg).await;
        let jito_result = get_lst_prices(&cfg, JITOSOL_MINT, &cfg.jito_orca_cache, &cfg.jito_mkt_cache).await;
        let msol_result = get_lst_prices(&cfg, MSOL_MINT,    &cfg.msol_orca_cache, &cfg.msol_mkt_cache).await;

        // SOL/USDC
        match sol_result {
            Ok((prices, orca_info)) => {
                let spread = prices.spread_bps();
                if cycle % 10 == 0 {
                    info!(
                        "[{}] SOL orca=${:.4} mkt=${:.4} spread={:.1}bps threshold={:.1}bps",
                        cycle, prices.orca_usd, prices.market_usd, spread, threshold
                    );
                }
                let cooled = last_exec_sol.map(|t| t.elapsed() > EXEC_COOLDOWN).unwrap_or(true);
                if spread > threshold && cooled {
                    last_exec_sol = Some(Instant::now());
                    if let Err(e) = run_mode_b(&cfg, &prices, WSOL_MINT, "SOL", Some(&orca_info)).await {
                        warn!("mode_b SOL: {e}");
                    }
                }
            }
            Err(e) => error!("[{}] SOL price error: {e}", cycle),
        }

        // JitoSOL/USDC
        match jito_result {
            Ok(prices) => {
                let spread = prices.spread_bps();
                if cycle % 10 == 0 {
                    info!(
                        "[{}] JITO orca=${:.4} mkt=${:.4} spread={:.1}bps",
                        cycle, prices.orca_usd, prices.market_usd, spread
                    );
                }
                let cooled = last_exec_jito.map(|t| t.elapsed() > EXEC_COOLDOWN).unwrap_or(true);
                if spread > threshold && cooled {
                    last_exec_jito = Some(Instant::now());
                    if let Err(e) = run_mode_b(&cfg, &prices, JITOSOL_MINT, "JITO", None).await {
                        warn!("mode_b JITO: {e}");
                    }
                }
            }
            Err(_) => {} // JitoSOL Orca-only route not routable via Jupiter dex filter
        }

        // mSOL/USDC
        match msol_result {
            Ok(prices) => {
                let spread = prices.spread_bps();
                if cycle % 10 == 0 {
                    info!(
                        "[{}] MSOL orca=${:.4} mkt=${:.4} spread={:.1}bps",
                        cycle, prices.orca_usd, prices.market_usd, spread
                    );
                }
                let cooled = last_exec_msol.map(|t| t.elapsed() > EXEC_COOLDOWN).unwrap_or(true);
                if spread > threshold && cooled {
                    last_exec_msol = Some(Instant::now());
                    if let Err(e) = run_mode_b(&cfg, &prices, MSOL_MINT, "MSOL", None).await {
                        warn!("mode_b MSOL: {e}");
                    }
                }
            }
            Err(e) => {
                if cycle % 20 == 0 { warn!("[{}] MSOL price error: {e}", cycle); }
            }
        }

        // Mode A: every 20 cycles (~10s) normally; every cycle (~400ms) inside window
        if near_epoch || cycle % 20 == 0 {
            let cooled = last_mode_a.map(|t| t.elapsed() > MODE_A_COOLDOWN).unwrap_or(true);
            if cooled {
                match check_mode_a(&cfg).await {
                    Ok(true)  => { last_mode_a = Some(Instant::now()); near_epoch = true; }
                    Ok(false) => { if near_epoch { info!("MODE_A: exited epoch window"); } near_epoch = false; }
                    Err(e)    => error!("mode_a: {e}"),
                }
            }
        }

        tokio::time::sleep(Duration::from_millis(if near_epoch { 400 } else { 500 })).await;
    }
}

// ─── bincode helper ────────────────────────────────────────────────────────
mod bincode {
    use anyhow::Result;
    pub fn serialize<T: serde::Serialize>(v: &T) -> Result<Vec<u8>> {
        ::bincode::serialize(v).map_err(|e| anyhow::anyhow!("{e}"))
    }
    pub fn deserialize<T: serde::de::DeserializeOwned>(b: &[u8]) -> Result<T> {
        ::bincode::deserialize(b).map_err(|e| anyhow::anyhow!("{e}"))
    }
}
