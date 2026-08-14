/**
 * Example: checking allowlist eligibility from the frontend.
 *
 * This replaces `fetch("/proofs.json")` from the earlier design. That
 * approach is what we're moving away from — it shipped every address in
 * the allowlist to every visitor's browser. This calls the private API
 * instead, which only ever answers for the one address you ask about.
 */

const ALLOWLIST_API_URL = "https://your-allowlist-api.up.railway.app"; // set to your deployed service's URL

async function checkAllowlistEligibility(address) {
  const res = await fetch(
    `${ALLOWLIST_API_URL}/api/allowlist-proof?address=${address}`
  );

  if (!res.ok) {
    throw new Error("Eligibility check failed. Try again.");
  }

  const { eligible, proof } = await res.json();
  return { eligible, proof }; // proof is null if not eligible
}

// Usage inside your mint page, once a wallet connects:
//
//   const { eligible, proof } = await checkAllowlistEligibility(connectedAddress);
//
//   if (eligible) {
//     // pass `proof` straight into the mintAllowlist(quantity, proof) call
//   } else {
//     // show "not on the allowlist" state
//   }
