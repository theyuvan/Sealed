// Funding helper.
//   --local                 mint dev stablecoin to the buyer on anvil (dev token only; reads .env.local)
//   (no flag)               show HSK gas and stablecoin balances of every service wallet
//   --send-gas <HSK>        send HSK for gas from the deployer to each service wallet (asks first)
//   --mint-dev <units>      testnet only: mint the DEV stablecoin to the buyer (when PINNED_TOKEN was not set)
import { createInterface } from "node:readline/promises";
import { createPublicClient, createWalletClient, formatEther, formatUnits, parseEther, type Address } from "viem";
import { accountFromEnv, chainFor, devTokenAbi, eip3009Abi, envInt, loadDeployment, loadEnv, requireEnv, rpcTransport } from "@sealed/core";

const env = loadEnv();
const chainId = envInt("CHAIN_ID", 31337);
const chain = chainFor(chainId, requireEnv("HSK_RPC_URL"));
const pub = createPublicClient({ chain, transport: rpcTransport() });
const d = loadDeployment(chainId);

const wallets: Record<string, Address> = {};
for (const k of ["DEPLOYER_PRIVATE_KEY", "COORDINATOR_PRIVATE_KEY", "VAULT_PRIVATE_KEY", "BUYER_WALLET_PRIVATE_KEY", "SELLER_1_PRIVATE_KEY", "SELLER_2_PRIVATE_KEY", "ROGUE_PRIVATE_KEY", "HSP_STANDIN_RELAYER_PRIVATE_KEY"]) {
  if (env[k]) wallets[k.replace("_PRIVATE_KEY", "")] = accountFromEnv(k).address;
}

if (process.argv.includes("--local")) {
  if (chainId !== 31337) throw new Error("--local only works on the local anvil chain");
  const deployer = accountFromEnv("DEPLOYER_PRIVATE_KEY");
  const w = createWalletClient({ chain, transport: rpcTransport(), account: deployer });
  const hash = await w.writeContract({ address: d.token, abi: devTokenAbi, functionName: "mint", args: [wallets.BUYER_WALLET!, 1_000_000_000n], chain, account: deployer });
  await pub.waitForTransactionReceipt({ hash });
  console.log(`minted 1000 dev USD to the buyer wallet ${wallets.BUYER_WALLET}`);
  process.exit(0);
}

const m = process.argv.indexOf("--mint-dev");
if (m >= 0) {
  // only the DevEIP3009Token deployed when PINNED_TOKEN is unset; its minter is the deployer
  if (chainId === 177) throw new Error("--mint-dev is not available on mainnet");
  const amount = BigInt(process.argv[m + 1] ?? "0");
  if (amount <= 0n) throw new Error("--mint-dev needs an amount in base units");
  const deployer = accountFromEnv("DEPLOYER_PRIVATE_KEY");
  const w = createWalletClient({ chain, transport: rpcTransport(), account: deployer });
  const hash = await w.writeContract({ address: d.token, abi: devTokenAbi, functionName: "mint", args: [wallets.BUYER_WALLET!, amount], chain, account: deployer });
  await pub.waitForTransactionReceipt({ hash });
  console.log(`minted ${amount} dev token units to the buyer wallet: ${hash}`);
}

const decimals = await pub.readContract({ address: d.token, abi: eip3009Abi, functionName: "decimals" });
console.log(`chain ${chainId}, pinned token ${d.token}`);
for (const [name, a] of Object.entries(wallets)) {
  const [gas, tok] = await Promise.all([pub.getBalance({ address: a }), pub.readContract({ address: d.token, abi: eip3009Abi, functionName: "balanceOf", args: [a] })]);
  console.log(`${name.padEnd(16)} ${a}  gas ${formatEther(gas)}  token ${formatUnits(tok, decimals)}`);
}

const i = process.argv.indexOf("--send-gas");
if (i >= 0) {
  const amount = parseEther(process.argv[i + 1] ?? "0");
  if (amount <= 0n) throw new Error("--send-gas needs an amount in HSK");
  const targets = Object.entries(wallets).filter(([n]) => n !== "DEPLOYER");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const phrase = chainId === 177 ? "send real HSK" : "yes";
  const a = await rl.question(`Send ${formatEther(amount)} HSK to ${targets.length} wallets on chain ${chainId}${chainId === 177 ? " (MAINNET, real funds)" : ""}? Type "${phrase}" to continue: `);
  rl.close();
  if (a.trim() !== phrase) {
    console.log("aborted");
    process.exit(1);
  }
  const deployer = accountFromEnv("DEPLOYER_PRIVATE_KEY");
  const w = createWalletClient({ chain, transport: rpcTransport(), account: deployer });
  for (const [name, to] of targets) {
    const hash = await w.sendTransaction({ to, value: amount, chain, account: deployer });
    await pub.waitForTransactionReceipt({ hash });
    console.log(`sent to ${name}: ${hash}`);
  }
}
