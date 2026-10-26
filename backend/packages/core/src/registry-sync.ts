import { type Address, type PublicClient, parseAbiItem } from "viem";
import { MANDATE_TREE_DEPTH, MerkleTree } from "./merkle.ts";

const SEALED = parseAbiItem("event Sealed(uint256 indexed commitment, uint256 leafIndex, bytes auditorCiphertext)");
const CONSUMED = parseAbiItem("event Consumed(uint256 indexed nullifier, uint256 newCommitment, uint256 leafIndex)");

/**
 * Rebuilds the registry's commitment tree from Sealed/Consumed events and checks the root
 * against the contract. Logs are fetched in chunks because public RPCs cap eth_getLogs ranges.
 */
export async function syncRegistryTree(
  client: PublicClient,
  registry: Address,
  fromBlock: bigint,
  chunk = 5_000n,
): Promise<MerkleTree> {
  // cacheTime 0: a cached (stale) head would give a consistent but outdated tree
  const latest = await client.getBlockNumber({ cacheTime: 0 });
  const leaves = new Map<number, bigint>();
  for (let start = fromBlock; start <= latest; start += chunk) {
    const end = start + chunk - 1n > latest ? latest : start + chunk - 1n;
    const [sealed, consumed] = await Promise.all([
      client.getLogs({ address: registry, event: SEALED, fromBlock: start, toBlock: end }),
      client.getLogs({ address: registry, event: CONSUMED, fromBlock: start, toBlock: end }),
    ]);
    for (const l of sealed) leaves.set(Number(l.args.leafIndex!), l.args.commitment!);
    for (const l of consumed) leaves.set(Number(l.args.leafIndex!), l.args.newCommitment!);
  }
  const tree = new MerkleTree(MANDATE_TREE_DEPTH);
  for (let i = 0; i < leaves.size; i++) {
    const leaf = leaves.get(i);
    if (leaf === undefined) throw new Error(`registry sync: missing leaf ${i} (wrong fromBlock?)`);
    tree.insert(leaf);
  }
  const onchain = (await client.readContract({
    address: registry,
    abi: [parseAbiItem("function currentRoot() view returns (uint256)")],
    functionName: "currentRoot",
    blockNumber: latest,
  })) as bigint;
  if (onchain !== tree.root) throw new Error("registry sync: rebuilt root does not match the contract");
  return tree;
}
