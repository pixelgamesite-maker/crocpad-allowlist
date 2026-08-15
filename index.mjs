/**
 * Private allowlist proof lookup API.
 *
 * Exposes exactly one thing: "is this specific address eligible, and if
 * so, what's its proof." Never returns any other address's data, never
 * exposes a way to list or count entries. This is the piece that makes
 * the allowlist actually private — the Merkle root on-chain already
 * reveals nothing, but a naive frontend fetching a public proofs.json
 * would defeat that. This service is the alternative to that file.
 *
 * Deploy this as its own small Railway service (or any Node host).
 * Uses the Supabase service_role key — keep that as a server-side
 * environment variable on whatever platform runs this, never in
 * frontend code.
 */

import express from "express";
import rateLimit from "express-rate-limit";
import { createClient } from "@supabase/supabase-js";
import { isAddress, getAddress } from "viem";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PORT = process.env.PORT || 3001;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*"; // set to your site's real origin in production

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const app = express();

// Basic CORS — only your frontend's origin should be able to call this.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Rate limiting: slows down anyone trying to enumerate addresses by
// brute-force querying. Doesn't need to be aggressive — a real user
// checking their own wallet only ever needs one request.
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20, // 20 lookups per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Try again shortly." },
});
app.use(limiter);

app.get("/api/allowlist-proof", async (req, res) => {
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

  if (!data) {
    // Deliberately the same shape/status as a real "not eligible" response
    // for any address — no signal that distinguishes "wrong format" from
    // "valid but not on the list."
    return res.status(200).json({ eligible: false, proof: null });
  }

  return res.status(200).json({ eligible: true, proof: data.proof });
});

app.get("/health", (req, res) => res.status(200).send("ok"));

app.listen(PORT, () => {
  console.log(`Allowlist proof API listening on port ${PORT}`);
});
