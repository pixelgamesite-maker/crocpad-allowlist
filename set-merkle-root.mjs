/**
 * set-merkle-root.mjs
 *
 * Reads the root produced by generate-allowlist.mjs and calls
 * setMerkleRoot() on the deployed CrocsPad contract. Owner-only —
 * must be run with the deployer/owner's private key.
 *
 * Usage:
 *   CONTRACT_ADDRESS=0x... \
 *   PRIVATE_KEY=0x... \
 *   RH_RPC_URL=https://rpc.testnet.chain.robinhood.com \
 *   CHAIN_ID=46630 \
 *   node set-merkle-root.mjs
 *
 * Defaults to testnet if RH_RPC_URL / CHAIN_ID aren't set — swap to
 * mainnet values (chain id 4663, https://rpc.mainnet.chain.robinhood.com)
 * once you've verified the root on testnet.
 */

import { createWalletClient, createPublicClient, http, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "fs";

const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.RH_RPC_URL || "https://rpc.testnet.chain.robinhood.com";
const CHAIN_ID = Number(process.env.CHAIN_ID || 46630);

if (!CONTRACT_ADDRESS || !PRIVATE_KEY) {
  console.error("Missing CONTRACT_ADDRESS or PRIVATE_KEY env vars.");
  process.exit(1);
}

const root = readFileSync("merkle-root.txt", "utf8").trim();
console.log(`Setting merkle root ${root} on ${CONTRACT_ADDRESS} (chain ${CHAIN_ID})...`);

const robinhoodChain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
  rpcUrls: { default: { http: [RPC_URL] } },
});

const account = privateKeyToAccount(PRIVATE_KEY);

const walletClient = createWalletClient({ account, chain: robinhoodChain, transport: http(RPC_URL) });
const publicClient = createPublicClient({ chain: robinhoodChain, transport: http(RPC_URL) });

const abi = [
  {
    type: "function",
    name: "setMerkleRoot",
    stateMutability: "nonpayable",
    inputs: [{ name: "root", type: "bytes32" }],
    outputs: [],
  },
];

async function main() {
  const hash = await walletClient.writeContract({
    address: CONTRACT_ADDRESS,
    abi,
    functionName: "setMerkleRoot",
    args: [root],
  });
  console.log(`Transaction sent: ${hash}`);
  console.log("Waiting for confirmation...");
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`Confirmed in block ${receipt.blockNumber}. Status: ${receipt.status}`);
}

main().catch((err) => {
  console.error("Failed to set merkle root:", err);
  process.exit(1);
});
