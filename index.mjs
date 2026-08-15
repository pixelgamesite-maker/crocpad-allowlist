/**
 * Private allowlist API — two roles in one small service.
 *
 * PUBLIC:
 *   GET /api/allowlist-proof?address=0x...
 *     Returns whether one specific address is eligible, and its proof
 *     if so. Never reveals the list or its size. Rate-limited.
 *
 * ADMIN (requires the ADMIN_API_KEY header, set as a Railway env var —
 * never put this key in frontend source code, only paste it into the
 * admin page's prompt when you use it):
 *   POST /admin/allowlist
 *     Body: { csv: string }
 *     Parses the CSV, builds the Merkle tree, fully replaces
 *     crocpad_proofs, and returns { root, count } so the admin page can
 *     submit that root on-chain with one wallet transaction.
 *
 * Deploy this as its own Railway service. Env vars needed:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ALLOWED_ORIGIN, ADMIN_API_KEY
 */

import express from "express";
import rateLimit from "express-rate-limit";
import { createClient } from "@supabase/supabase-js";
import { isAddress, getAddress } from "viem";
import { MerkleTree } from "merkletreejs";
import keccak256 from "keccak256";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PORT = process.env.PORT || 3001;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.");
  process.exit(1);
}
if (!ADMIN_API_KEY) {
  console.warn("ADMIN_API_KEY is not set — /admin/allowlist will reject every request until it is.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const app = express();
app.use(express.json({ limit: "5mb" })); // CSVs can be large with a few thousand rows

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* ───────────────────── public: eligibility lookup ───────────────────── */

const lookupLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Try again shortly." },
});

app.get("/api/allowlist-proof", lookupLimiter, async (req, res) => {
  const address = req.query.address;
  if (!address || typeof address !== "string" || !isAddress(address)) {
    return res.status(400).json({ error: "A valid EVM address is required." });
  }

  const normalized = getAddress(address).toLowerCase();
  const { data, error } = await supabase
    .from("crocpad_proofs")
    .select("proof")
    .eq("wallet_address", normalized)
    .maybeSingle();

  if (error) {
    console.error("Lookup failed:", error.message);
    return res.status(500).json({ error: "Lookup failed. Try again shortly." });
  }
  if (!data) return res.status(200).json({ eligible: false, proof: null });
  return res.status(200).json({ eligible: true, proof: data.proof });
});

/* ───────────────────── admin: build + store the tree ───────────────────── */

const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many admin requests. Wait a moment." },
});

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!ADMIN_API_KEY || token !== ADMIN_API_KEY) {
    return res.status(401).json({ error: "Unauthorized." });
  }
  next();
}

function leafFor(address) {
  const hex = address.slice(2).toLowerCase();
  return keccak256(Buffer.from(hex, "hex"));
}

function parseAddressCsv(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const addresses = [];
  const skipped = [];
  let sawHeader = false;

  for (const line of lines) {
    const firstCol = line.split(",")[0].trim().replace(/^"|"$/g, "");
    if (isAddress(firstCol)) {
      addresses.push(getAddress(firstCol));
    } else if (!sawHeader && /address/i.test(firstCol)) {
      sawHeader = true;
    } else {
      skipped.push(line);
    }
  }
  return { addresses, skipped };
}

app.post("/admin/allowlist", adminLimiter, requireAdmin, async (req, res) => {
  const csv = req.body?.csv;
  if (!csv || typeof csv !== "string") {
    return res.status(400).json({ error: "Missing csv field in request body." });
  }

  const { addresses: raw, skipped } = parseAddressCsv(csv);
  if (raw.length === 0) {
    return res.status(400).json({ error: "No valid addresses found in that file.", skipped });
  }

  // Dedupe, case-insensitive.
  const seen = new Set();
  const addresses = [];
  for (const a of raw) {
    const key = a.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    addresses.push(a);
  }

  const leaves = addresses.map(leafFor);
  const tree = new MerkleTree(leaves, keccak256, { sortPairs: true });
  const root = tree.getHexRoot();

  // Full replace — this CSV is the single source of truth for the list.
  const { error: deleteError } = await supabase
    .from("crocpad_proofs")
    .delete()
    .neq("wallet_address", "");
  if (deleteError) {
    console.error("Failed clearing old proofs:", deleteError.message);
    return res.status(500).json({ error: "Failed clearing previous list." });
  }

  const rows = addresses.map((address, i) => ({
    wallet_address: address.toLowerCase(),
    proof: tree.getHexProof(leaves[i]),
  }));

  const BATCH_SIZE = 500;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error: insertError } = await supabase.from("crocpad_proofs").insert(batch);
    if (insertError) {
      console.error(`Failed writing batch at row ${i}:`, insertError.message);
      return res.status(500).json({ error: "Failed writing proofs partway through. List may be in a partial state — try again." });
    }
  }

  return res.status(200).json({
    root,
    count: addresses.length,
    skippedCount: skipped.length,
    skipped: skipped.slice(0, 20), // cap so a huge bad file doesn't bloat the response
  });
});

app.get("/health", (req, res) => res.status(200).send("ok"));

app.listen(PORT, () => {
  console.log(`Allowlist API listening on port ${PORT}`);
});
