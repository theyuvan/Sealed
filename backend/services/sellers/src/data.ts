import { type Address, type PublicClient, erc20Abi, parseAbiItem } from "viem";

// Data products read live from the chain over RPC (README 9.3: "real sources on HSK where possible").

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

async function recentTransfers(client: PublicClient, asset: Address, lookback: bigint) {
  const latest = await client.getBlockNumber({ cacheTime: 0 });
  const from = latest > lookback ? latest - lookback : 0n;
  return client.getLogs({ address: asset, event: TRANSFER, fromBlock: from, toBlock: latest });
}

export async function buildProduct(client: PublicClient, serviceId: string, assets: Address[], lookback = 5_000n): Promise<{ block: bigint; data: unknown[] }> {
  const block = await client.getBlockNumber({ cacheTime: 0 });
  if (serviceId === "nav-snapshot") {
    const data = await Promise.all(
      assets.map(async (asset) => {
        const [symbol, decimals, totalSupply] = await Promise.all([
          client.readContract({ address: asset, abi: erc20Abi, functionName: "symbol", blockNumber: block }),
          client.readContract({ address: asset, abi: erc20Abi, functionName: "decimals", blockNumber: block }),
          client.readContract({ address: asset, abi: erc20Abi, functionName: "totalSupply", blockNumber: block }),
        ]);
        return { asset, symbol, decimals, totalSupply: totalSupply.toString() };
      }),
    );
    return { block, data };
  }
  if (serviceId === "holder-distribution") {
    const data = await Promise.all(
      assets.map(async (asset) => {
        const logs = await recentTransfers(client, asset, lookback);
        const seen = [...new Set(logs.flatMap((l) => [l.args.from!, l.args.to!]))].filter((a) => !/^0x0{40}$/i.test(a)).slice(0, 50);
        const balances = await Promise.all(seen.map((a) => client.readContract({ address: asset, abi: erc20Abi, functionName: "balanceOf", args: [a], blockNumber: block })));
        const holders = seen
          .map((address, i) => ({ address, balance: balances[i]!.toString() }))
          .filter((h) => h.balance !== "0")
          .sort((a, b) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : -1))
          .slice(0, 10);
        return { asset, holders };
      }),
    );
    return { block, data };
  }
  if (serviceId === "recent-transfers") {
    const data = await Promise.all(
      assets.map(async (asset) => {
        const logs = await recentTransfers(client, asset, lookback);
        const transfers = logs.slice(-20).map((l) => ({ from: l.args.from!, to: l.args.to!, value: l.args.value!.toString(), block: l.blockNumber!.toString(), tx: l.transactionHash! }));
        return { asset, transfers };
      }),
    );
    return { block, data };
  }
  throw new Error(`unknown service ${serviceId}`);
}
