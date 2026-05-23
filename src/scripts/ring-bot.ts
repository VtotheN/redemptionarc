import "dotenv/config";
import fs from "node:fs";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction
} from "@solana/web3.js";
import {
  createTransferCheckedWithFeeInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getTransferFeeConfig,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID
} from "@solana/spl-token";
import { HOP_MINT_DEFAULT } from "../constants.js";
import { loadConfig } from "../config.js";
import { connectionFor } from "../utils/rpc.js";
import { writeReceipt } from "../utils/receipt.js";
import { assertKeypairMatches, ensureKeypair, loadKeypair, publicKeyFromKeypairFile } from "../utils/keypair.js";
import { assertLiveAllowed, assertNoForbiddenConfigured } from "../utils/safety.js";
import {
  borrowIx,
  endFlashIx,
  JITO_TIP_WALLET,
  MARGINFI_PROGRAM,
  MARGINFI_USDC_BANK,
  MARGINFI_USDC_LIQUIDITY_VAULT,
  oracleForBank,
  repayIx,
  startFlashIx,
  USER_PROVIDED_FLASH_BORROW_DISCRIMINATOR,
  USER_PROVIDED_FLASH_REPAY_DISCRIMINATOR
} from "../utils/marginfi.js";
import { serializableInstruction } from "../utils/orca-whirlpool.js";

const HOP_DECIMALS = 6;

type RingHop = {
  fromIndex: number;
  toIndex: number;
  sourceAta: PublicKey;
  destinationAta: PublicKey;
  owner: PublicKey;
  inputRaw: bigint;
  feeRaw: bigint;
  deliveredRaw: bigint;
};

async function quoteHopToUsdc(hopMint: PublicKey, usdcMint: PublicKey, amount: bigint) {
  if (amount <= 0n) return null;
  const jupiterApi = process.env.JUPITER_API || "https://quote-api.jup.ag/v6";
  try {
    const url = `${jupiterApi}/quote?inputMint=${hopMint.toBase58()}&outputMint=${usdcMint.toBase58()}&amount=${amount}&slippageBps=${process.env.JUPITER_SLIPPAGE_BPS || "100"}`;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return { ok: false, status: res.status, error: (await res.text()).slice(0, 240) };
    const json = await res.json();
    if ((json as { error?: string }).error) return { ok: false, error: (json as { error: string }).error };
    return {
      ok: true,
      outAmount: (json as { outAmount: string }).outAmount,
      outUsdc: Number((json as { outAmount: string }).outAmount) / 1e6,
      routePlanLabels: ((json as { routePlan?: Array<{ swapInfo?: { label?: string } }> }).routePlan ?? []).map((r) => r.swapInfo?.label)
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function loadLookupTable(connection: ReturnType<typeof connectionFor>): Promise<AddressLookupTableAccount | null> {
  const altAddress = process.env.ALT_ADDRESS || (fs.existsSync("receipts/vol-alt-address.txt")
    ? fs.readFileSync("receipts/vol-alt-address.txt", "utf8").trim()
    : "");
  if (!altAddress) return null;
  const result = await connection.getAddressLookupTable(new PublicKey(altAddress));
  if (!result.value) throw new Error(`ALT not found: ${altAddress}`);
  return result.value;
}

function activeTransferFee(args: {
  epoch: number;
  newerTransferFee: { epoch: bigint; transferFeeBasisPoints: number; maximumFee: bigint };
  olderTransferFee: { epoch: bigint; transferFeeBasisPoints: number; maximumFee: bigint };
}) {
  return BigInt(args.epoch) >= args.newerTransferFee.epoch ? args.newerTransferFee : args.olderTransferFee;
}

function calcTransferFee(amount: bigint, bps: number, maximumFee: bigint): bigint {
  const raw = amount * BigInt(bps);
  const rounded = raw / 10_000n + (raw % 10_000n > 0n ? 1n : 0n);
  return rounded > maximumFee ? maximumFee : rounded;
}

function buildRing(args: {
  botOwners: PublicKey[];
  botAtas: PublicKey[];
  startAmount: bigint;
  feeBps: number;
  maximumFee: bigint;
}): RingHop[] {
  const hops: RingHop[] = [];
  let amount = args.startAmount;
  for (let i = 0; i < args.botOwners.length; i++) {
    const toIndex = (i + 1) % args.botOwners.length;
    const fee = calcTransferFee(amount, args.feeBps, args.maximumFee);
    const delivered = amount - fee;
    hops.push({
      fromIndex: i,
      toIndex,
      sourceAta: args.botAtas[i],
      destinationAta: args.botAtas[toIndex],
      owner: args.botOwners[i],
      inputRaw: amount,
      feeRaw: fee,
      deliveredRaw: delivered
    });
    amount = delivered;
  }
  return hops;
}

async function tokenAccountState(connection: ReturnType<typeof connectionFor>, ata: PublicKey) {
  try {
    const account = await getAccount(connection, ata, "confirmed", TOKEN_2022_PROGRAM_ID);
    return { exists: true, amount: account.amount.toString() };
  } catch (error) {
    return { exists: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  const config = loadConfig();
  assertNoForbiddenConfigured(config);
  assertLiveAllowed(config);
  if (!config.crank) throw new Error("Missing REDEMPTION_CRANK");

  const hopMint = new PublicKey(process.env.RING_HOP_MINT || process.env.HOP_MINT || HOP_MINT_DEFAULT);
  const connection = connectionFor(config.rpcUrl);
  const crank = loadKeypair(process.env.CRANK_KEYPAIR_PATH || "keys/crank.json");
  assertKeypairMatches("crank", crank, config.crank);

  const botCount = Number(process.env.RING_BOT_COUNT || "4");
  if (botCount !== 4) throw new Error("ring-bot currently requires exactly 4 bot wallets");
  const bots = Array.from({ length: botCount }, (_, index) =>
    ensureKeypair(process.env[`BOT_${index + 1}_KEYPAIR_PATH`] || `keys/bot-${index + 1}.json`, { useSolanaKeygen: true })
  );

  const botOwners = bots.map((bot) => bot.publicKey);
  const botAtas = botOwners.map((owner) => getAssociatedTokenAddressSync(hopMint, owner, false, TOKEN_2022_PROGRAM_ID));
  const accountStates = await Promise.all(botAtas.map((ata) => tokenAccountState(connection, ata)));

  const mintInfo = await getMint(connection, hopMint, "confirmed", TOKEN_2022_PROGRAM_ID);
  const feeConfig = getTransferFeeConfig(mintInfo);
  if (!feeConfig) throw new Error(`HOP mint ${hopMint.toBase58()} missing TransferFeeConfig extension`);
  const epochInfo = await connection.getEpochInfo("confirmed");
  const fee = activeTransferFee({
    epoch: epochInfo.epoch,
    newerTransferFee: feeConfig.newerTransferFee,
    olderTransferFee: feeConfig.olderTransferFee
  });

  const ringStartRaw = BigInt(process.env.RING_START_HOP_MICRO || "1000000");
  const ring = buildRing({
    botOwners,
    botAtas,
    startAmount: ringStartRaw,
    feeBps: fee.transferFeeBasisPoints,
    maximumFee: fee.maximumFee
  });
  const estimatedWithheldRaw = ring.reduce((sum, hop) => sum + hop.feeRaw, 0n);

  const marginfiAccount = publicKeyFromKeypairFile(process.env.MARGINFI_ACCOUNT_KEYPAIR_PATH || "keys/marginfi-account.json");
  const crankUsdcAta = process.env.GHOST_USDC_ATA
    ? new PublicKey(process.env.GHOST_USDC_ATA)
    : getAssociatedTokenAddressSync(config.usdcMint, crank.publicKey, false, TOKEN_PROGRAM_ID);
  const flashAmountUsdc = Number(process.env.FLASH_USDC || "1");
  const flashAmountMicro = BigInt(Math.floor(flashAmountUsdc * 1e6));
  const jitoTipWallet = new PublicKey(process.env.JITO_TIP_WALLET || JITO_TIP_WALLET.toBase58());
  const jitoTipLamports = BigInt(process.env.JITO_TIP_LAMPORTS || "10000");
  const cuLimit = Number(process.env.CU_LIMIT || "1200000");
  const cuPrice = Number(process.env.CU_PRICE || "1000");
  const oracle = await oracleForBank(connection);

  const ringIxs = ring.map((hop) =>
    createTransferCheckedWithFeeInstruction(
      hop.sourceAta,
      hopMint,
      hop.destinationAta,
      hop.owner,
      hop.inputRaw,
      HOP_DECIMALS,
      hop.feeRaw,
      [],
      TOKEN_2022_PROGRAM_ID
    )
  );

  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }),
    startFlashIx(marginfiAccount, crank.publicKey, 10n),
    borrowIx(marginfiAccount, crank.publicKey, crankUsdcAta, flashAmountMicro),
    ...ringIxs,
    repayIx(marginfiAccount, crank.publicKey, crankUsdcAta, flashAmountMicro),
    SystemProgram.transfer({ fromPubkey: crank.publicKey, toPubkey: jitoTipWallet, lamports: Number(jitoTipLamports) }),
    endFlashIx(marginfiAccount, crank.publicKey, oracle)
  ];

  const lookupTable = await loadLookupTable(connection);
  const message = new TransactionMessage({
    payerKey: crank.publicKey,
    recentBlockhash: (await connection.getLatestBlockhash("confirmed")).blockhash,
    instructions: ixs
  }).compileToV0Message(lookupTable ? [lookupTable] : []);
  const tx = new VersionedTransaction(message);
  tx.sign([crank, ...bots]);
  let sim;
  let simulationBuildError: string | null = null;
  try {
    sim = await connection.simulateTransaction(tx, {
      replaceRecentBlockhash: true,
      sigVerify: false,
      commitment: "confirmed"
    });
  } catch (error) {
    simulationBuildError = error instanceof Error ? error.message : String(error);
    sim = {
      value: {
        err: { simulationBuildError },
        unitsConsumed: null,
        logs: []
      }
    };
  }

  const quote = await quoteHopToUsdc(hopMint, config.usdcMint, estimatedWithheldRaw);
  const priorityFeeLamports = BigInt(cuLimit) * BigInt(cuPrice) / 1_000_000n;
  const baseFeeLamports = BigInt(tx.signatures.length) * 5000n;
  const gasLamports = baseFeeLamports + priorityFeeLamports + jitoTipLamports;
  let serializedLength: number | null = null;
  let serializedLengthError: string | null = null;
  try {
    serializedLength = tx.serialize().length;
  } catch (error) {
    serializedLengthError = error instanceof Error ? error.message : String(error);
  }
  const netVerdict = sim.value.err
    ? "SIM_FAILED_NO_SEND"
    : quote?.ok
      ? Number((quote as { outUsdc: number }).outUsdc) > Number(gasLamports) / 1e9
        ? "QUOTE_POSITIVE_BEFORE_SOL_PRICE_CHECK"
        : "QUOTE_NOT_ENOUGH_AFTER_GAS_PROXY"
      : "NON_CASH_NO_HOP_USDC_ROUTE";

  const receipt: Record<string, unknown> = {
    verdict: netVerdict,
    generatedAt: new Date().toISOString(),
    dryRun: config.dryRun,
    allowLive: config.allowLive,
    liveTxApproved: process.env.LIVE_TX_APPROVED === "true",
    mode: "bundle-ready single v0 transaction with Jito tip; not submitted to Jito block engine by this script",
    hopMint: hopMint.toBase58(),
    configuredHopMint: config.hopMint.toBase58(),
    feeBps: fee.transferFeeBasisPoints,
    maximumFee: fee.maximumFee.toString(),
    warning: fee.transferFeeBasisPoints !== 690 ? "Active HOP transfer fee is not 690 bps." : null,
    marginfi: {
      program: MARGINFI_PROGRAM.toBase58(),
      account: marginfiAccount.toBase58(),
      usdcBank: MARGINFI_USDC_BANK.toBase58(),
      liquidityVault: MARGINFI_USDC_LIQUIDITY_VAULT.toBase58(),
      crankUsdcAta: crankUsdcAta.toBase58(),
      flashAmountUsdc,
      provenRepoPath: "LendingAccountStartFlashloan -> LendingAccountBorrow -> LendingAccountRepay -> LendingAccountEndFlashloan",
      userProvidedDiscriminators: {
        flashBorrow: Array.from(USER_PROVIDED_FLASH_BORROW_DISCRIMINATOR),
        flashRepay: Array.from(USER_PROVIDED_FLASH_REPAY_DISCRIMINATOR)
      }
    },
    addressLookupTable: lookupTable
      ? {
          address: lookupTable.key.toBase58(),
          addresses: lookupTable.state.addresses.length
        }
      : null,
    serializedLength,
    serializedLengthError,
    bots: bots.map((bot, index) => ({
      index: index + 1,
      owner: bot.publicKey.toBase58(),
      hopAta: botAtas[index].toBase58(),
      accountState: accountStates[index]
    })),
    ring: ring.map((hop) => ({
      from: hop.fromIndex + 1,
      to: hop.toIndex + 1,
      sourceAta: hop.sourceAta.toBase58(),
      destinationAta: hop.destinationAta.toBase58(),
      authority: hop.owner.toBase58(),
      inputRaw: hop.inputRaw.toString(),
      feeRaw: hop.feeRaw.toString(),
      deliveredRaw: hop.deliveredRaw.toString()
    })),
    estimated_withheld_hop: Number(estimatedWithheldRaw) / 1e6,
    estimatedWithheldRaw: estimatedWithheldRaw.toString(),
    gas_cost_sol: Number(gasLamports) / 1e9,
    gasLamports: gasLamports.toString(),
    jitoTipLamports: jitoTipLamports.toString(),
    hopToUsdcQuote: quote,
    simulation: {
      err: sim.value.err ?? null,
      unitsConsumed: sim.value.unitsConsumed ?? null,
      logs: sim.value.logs ?? [],
      buildError: simulationBuildError
    },
    instructions: ixs.map(serializableInstruction)
  };

  if (config.dryRun || sim.value.err) {
    const out = writeReceipt("RING-BOT-LATEST.json", receipt);
    console.log(`estimated_withheld_hop=${receipt.estimated_withheld_hop} gas_cost_sol=${receipt.gas_cost_sol} net_verdict=${receipt.verdict} receipt=${out}`);
    if (sim.value.err) process.exitCode = 1;
    return;
  }

  const signature = await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
  receipt.verdict = "RING_BOT_EXECUTED";
  receipt.signature = signature;
  const out = writeReceipt("RING-BOT-LATEST.json", receipt);
  console.log(`estimated_withheld_hop=${receipt.estimated_withheld_hop} gas_cost_sol=${receipt.gas_cost_sol} net_verdict=${receipt.verdict} sig=${signature} receipt=${out}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
