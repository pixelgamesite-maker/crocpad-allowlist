/**
 * generate-allowlist-private.mjs
 *
 * Single source of truth: one CSV file with every allowlist wallet —
 * waitlist applicants, collab wallets, OG community wallets, whatever
 * your team compiles — all already merged into that one file by
 * whoever maintains it. This script doesn't read from Supabase or any
 * other source; it only reads the CSV you point it at.
 *
 * Builds the Merkle tree from that file, then privately stores each
 * address's proof in the `crocpad_proofs` Supabase table (see
 * migration-005-private-proofs-table.sql) — a table with no public
 * read policy, so nobody browsing your site can see the full list or
 * its size. Only this script (via the service_role key) and the
 * lookup API (also service_role, server-side only) can ever read it.
 *
 * Each run fully replaces what's in crocpad_proofs — since the CSV is
 * the single source of truth, if you remove an address from the file
 * and re-run, that address's old proof gets cleared out too, not left
 * behind as a stale leftover.
 *
 * Usage:
 *   SUPABASE_URL=https://xxx.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=xxx \
 *   node generate-allowlist-private.mjs allowlist.csv
 *
 * Whenever the file changes, just run the exact same command again —
 * that's the entire "reupload" workflow.
 */

import { createClient } from "@supabase/supabase-js";
import { MerkleTree } from "merkletreejs";
import keccak256 from "keccak256";
import { writeFileSync, readFileSync } from "fs";
import { isAddress, getAddress } from "viem";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const csvPath = process.argv[2] || "allowlist.csv";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function leafFor(address) {
  const hex = address.slice(2).toLowerCase();
  return keccak256(Buffer.from(hex, "hex"));
}

/**
 * Reads a simple CSV of addresses. Only the first column matters — a
 * "wallet_address" or "address" header is fine and gets skipped
 * automatically, plain address-per-line with no header also works.
 */
function parseAddressCsv(filePath) {
  const content = readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const addresses = [];
  let skippedHeader = false;
  for (const line of lines) {
    const firstCol = line.split(",")[0].trim().replace(/^"|"$/g, "");
    if (isAddress(firstCol)) {
      addresses.push(getAddress(firstCol));
    } else if (!skippedHeader && /address/i.test(firstCol)) {
      skippedHeader = true; // looks like a header row, ignore silently
    } else {
      console.warn(`Skipping unrecognized line: "${line}"`);
    }
  }
  return addresses;
}

async function main() {
  console.log(`Reading ${csvPath}...`);
  const rawAddresses = parseAddressCsv(csvPath);

  if (rawAddresses.length === 0) {
    console.error("No valid addresses found in that file. Nothing to build.");
    process.exit(1);
  }

  // Dedupe, case-insensitive.
  const seen = new Set();
  const addresses = [];
  for (const addr of rawAddresses) {
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    addresses.push(addr);
  }

  console.log(`${addresses.length} unique address(es) found (${rawAddresses.length - addresses.length} duplicate(s) removed).`);
  console.log("Building Merkle tree...");

  const leaves = addresses.map(leafFor);
  const tree = new MerkleTree(leaves, keccak256, { sortPairs: true });
  const root = tree.getHexRoot();

  writeFileSync("merkle-root.txt", root);
  console.log(`Merkle root (safe to publish/set on-chain): ${root}`);

  console.log("Clearing previous proofs from crocpad_proofs (full replace)...");
  const { error: deleteError } = await supabase
    .from("crocpad_proofs")
    .delete()
    .neq("wallet_address", ""); // matches every row; wallet_address is never empty

  if (deleteError) {
    console.error("Failed clearing old proofs:", deleteError.message);
    process.exit(1);
  }

  console.log("Writing new proofs privately to crocpad_proofs...");

  const BATCH_SIZE = 500;
  const rows = addresses.map((address, i) => ({
    wallet_address: address.toLowerCase(),
    proof: tree.getHexProof(leaves[i]),
  }));

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error: insertError } = await supabase
      .from("crocpad_proofs")
      .insert(batch);

    if (insertError) {
      console.error(`Failed writing batch starting at row ${i}:`, insertError.message);
      process.exit(1);
    }
    console.log(`  wrote ${Math.min(i + BATCH_SIZE, rows.length)} / ${rows.length}`);
  }

  console.log("\nDone.");
  console.log(`${addresses.length} proofs written privately to crocpad_proofs.`);
  console.log("Nothing publicly downloadable was created — proofs are only");
  console.log("retrievable one at a time, per-address, via the lookup API.");
  console.log("\nNext: call set-merkle-root.mjs to submit the new root on-chain.");
  console.log("(Do this promptly if this replaces an existing live root — old");
  console.log("proofs stop working the instant the on-chain root changes.)");
}

main();
