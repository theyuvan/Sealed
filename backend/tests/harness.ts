// Test harness: a throwaway anvil chain with the real contracts deployed by the real forge script.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Address, type Hex, createPublicClient, createWalletClient, http, type PublicClient, type WalletClient, parseEther, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { BACKEND_ROOT, REPO_ROOT, devTokenAbi, localAnvil, sessionEscrowAbi, type Deployment, EIP3009_TYPES } from "@sealed/core";

const EXE = process.platform === "win32" ? ".exe" : "";
export const tool = (n: string) => {
  const p = join(BACKEND_ROOT, ".tools", "bin", `${n}${EXE}`);
  return existsSync(p) ? p : n;
};

export interface Keys {
  deployer: PrivateKeyAccount;
  coordinator: PrivateKeyAccount;
  vault: PrivateKeyAccount;
  buyer: PrivateKeyAccount;
  relayer: PrivateKeyAccount;
  seller1: PrivateKeyAccount;
  seller2: PrivateKeyAccount;
  rogue: PrivateKeyAccount;
}

export interface TestChain {
  rpcUrl: string;
  port: number;
  pub: PublicClient;
  keys: Keys;
  keyHex: Record<keyof Keys, Hex>;
  deployment: Deployment;
  wallet(a: PrivateKeyAccount): WalletClient;
  mint(to: Address, amount: bigint): Promise<void>;
  balance(a: Address): Promise<bigint>;
  /** buyer signs EIP-3009 (nonce = sessionId) to `to`; relayer submits */
  payWithAuthorization(o: { from: PrivateKeyAccount; to: Address; value: bigint; nonce: Hex }): Promise<Hex>;
  markFunded(sessionId: Hex, orderId: Hex): Promise<void>;
  increaseTime(seconds: number): Promise<void>;
  stop(): Promise<void>;
}

async function rpc(url: string, method: string, params: unknown[]) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await r.json()) as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

export async function startChain(): Promise<TestChain> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const rpcUrl = `http://127.0.0.1:${port}`;
  const anvil: ChildProcess = spawn(tool("anvil"), ["--port", String(port), "--silent", "--chain-id", "31337"], { stdio: "ignore" });
  for (let i = 0; ; i++) {
    try {
      await rpc(rpcUrl, "eth_chainId", []);
      break;
    } catch {
      if (i > 100) throw new Error("anvil did not start");
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const keyHex = Object.fromEntries(
    ["deployer", "coordinator", "vault", "buyer", "relayer", "seller1", "seller2", "rogue"].map((k) => [k, generatePrivateKey()]),
  ) as Record<keyof Keys, Hex>;
  const keys = Object.fromEntries(Object.entries(keyHex).map(([k, v]) => [k, privateKeyToAccount(v)])) as unknown as Keys;
  for (const a of Object.values(keys)) await rpc(rpcUrl, "anvil_setBalance", [a.address, toHex(parseEther("100"))]);

  const file = join(REPO_ROOT, "contracts", "deployments", `test-${port}.json`);
  const env: NodeJS.ProcessEnv = { ...process.env, DEPLOYER_PRIVATE_KEY: keyHex.deployer, COORDINATOR_ADDRESS: keys.coordinator.address, DEPLOYMENT_FILE: `deployments/test-${port}.json` };
  for (const k of ["PINNED_TOKEN", "CONFIRM_MAINNET", "ESCROW_OWNER"]) delete env[k];
  const r = spawnSync(tool("forge"), ["script", "script/Deploy.s.sol", "--rpc-url", rpcUrl, "--broadcast", "--silent"], {
    cwd: join(REPO_ROOT, "contracts"),
    env,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`deploy failed: ${r.stderr || r.stdout}`);
  const deployment = JSON.parse(readFileSync(file, "utf8")) as Deployment;
  rmSync(file, { force: true });
  rmSync(join(REPO_ROOT, "contracts", "broadcast", "Deploy.s.sol", "31337"), { recursive: true, force: true });

  const chain = { ...localAnvil, rpcUrls: { default: { http: [rpcUrl] } } };
  const pub = createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient;
  const wallet = (a: PrivateKeyAccount) => createWalletClient({ chain, transport: http(rpcUrl), account: a });
  const wait = async (hash: Hex) => {
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error(`tx ${hash} reverted`);
  };

  const tc: TestChain = {
    rpcUrl,
    port,
    pub,
    keys,
    keyHex,
    deployment,
    wallet,
    async mint(to, amount) {
      await wait(await wallet(keys.deployer).writeContract({ address: deployment.token, abi: devTokenAbi, functionName: "mint", args: [to, amount], chain, account: keys.deployer }));
    },
    async balance(a) {
      return pub.readContract({ address: deployment.token, abi: devTokenAbi, functionName: "balanceOf", args: [a] });
    },
    async payWithAuthorization({ from, to, value, nonce }) {
      const block = await pub.getBlock();
      const validBefore = block.timestamp + 600n;
      const signature = await from.signTypedData({
        domain: { name: "Sealed Dev USD", version: "2", chainId: 31337, verifyingContract: deployment.token },
        types: EIP3009_TYPES,
        primaryType: "TransferWithAuthorization",
        message: { from: from.address, to, value, validAfter: 0n, validBefore, nonce },
      });
      const hash = await wallet(keys.relayer).writeContract({
        address: deployment.token,
        abi: devTokenAbi,
        functionName: "transferWithAuthorization",
        args: [from.address, to, value, 0n, validBefore, nonce, signature],
        chain,
        account: keys.relayer,
      });
      await wait(hash);
      return hash;
    },
    async markFunded(sessionId, orderId) {
      await wait(await wallet(keys.coordinator).writeContract({ address: deployment.escrow, abi: sessionEscrowAbi, functionName: "markFunded", args: [sessionId, orderId], chain, account: keys.coordinator }));
    },
    async increaseTime(seconds) {
      await rpc(rpcUrl, "evm_increaseTime", [seconds]);
      await rpc(rpcUrl, "evm_mine", []);
    },
    async stop() {
      anvil.kill();
    },
  };
  return tc;
}
