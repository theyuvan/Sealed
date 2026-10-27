// Auditor view: decrypt every sealed mandate's rules from the Sealed events (F9).
//   AUDITOR_PRIVATE_KEY=0x... npx tsx scripts/auditor-decrypt.ts
import { createPublicClient, type Hex } from "viem";
import { chainFor, decryptAsAuditor, envInt, loadDeployment, loadEnv, mandateRegistryAbi, requireEnv, rpcTransport } from "@sealed/core";

loadEnv();
const chainId = envInt("CHAIN_ID", 31337);
const d = loadDeployment(chainId);
const pub = createPublicClient({ chain: chainFor(chainId, requireEnv("HSK_RPC_URL")), transport: rpcTransport() });
const key = requireEnv("AUDITOR_PRIVATE_KEY") as Hex;
const logs = await pub.getContractEvents({ address: d.registry, abi: mandateRegistryAbi, eventName: "Sealed", fromBlock: BigInt(d.deployBlock) });
for (const l of logs) {
  try {
    console.log(`leaf ${l.args.leafIndex} tx ${l.transactionHash}\n  ${decryptAsAuditor(key, l.args.auditorCiphertext!)}`);
  } catch {
    console.log(`leaf ${l.args.leafIndex}: not encrypted to this auditor key`);
  }
}
