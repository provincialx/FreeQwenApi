/**
 * Pure JavaScript PoW (Proof-of-Work) solver for DeepSeek.
 * Replaces WASM-based solver — no .wasm file needed.
 *
 * Algorithm: SHA3-256 hashcash
 *   prefix   = salt + "_" + expire_at + "_"
 *   input    = prefix + nonce + challenge
 *   hash     = SHA3(input)
 *   answer   = nonce where hash has `difficulty` leading zero bits
 */
import jsSha3 from "js-sha3";
const { sha3_256 } = jsSha3;

/**
 * Count leading zero bits in a hex string (sha3 output).
 * @param {string} hex - Hex-encoded hash string (lowercase)
 * @returns {number} Number of leading zero bits
 */
function countLeadingZeroBits(hex) {
  let count = 0;
  for (let i = 0; i < hex.length; i++) {
    const c = hex[i];
    // Convert hex char to 4 bits
    const val = parseInt(c, 16);
    if (val === 0) {
      count += 4;
    } else {
      // Count leading zeros in this nibble
      if (val & 8) break;
      if (val & 4) {
        count += 3;
        break;
      }
      if (val & 2) {
        count += 2;
        break;
      }
      if (val & 1) {
        count += 1;
        break;
      }
      break;
    }
  }
  return count;
}

/**
 * Solve DeepSeek PoW challenge using SHA3-256.
 *
 * @param {object} challenge - The challenge object from DeepSeek API
 * @param {string} challenge.algorithm - Algorithm name (e.g., "PoW_SHA3")
 * @param {string} challenge.challenge - Challenge string (hex)
 * @param {string} challenge.salt - Salt string
 * @param {number} [challenge.difficulty=4096] - Required leading zero bits
 * @param {number} [challenge.expire_at] - Expiry timestamp
 * @param {string} [challenge.signature] - Optional signature
 * @returns {{ nonce: number, powData: string }} Solved nonce and Base64-encoded PoW header data
 */
export function solvePoW(challenge) {
  const prefix = (challenge.salt || "") + "_" + (challenge.expire_at || "") + "_";
  const suffix = challenge.challenge || "";
  const difficulty = challenge.difficulty || 4096;

  let nonce = 0;
  let leadingZeros = 0;

  // Iterate nonce until hash meets difficulty target
  while (leadingZeros < difficulty) {
    nonce++;
    leadingZeros = countLeadingZeroBits(sha3_256(prefix + nonce + suffix));
  }

  // Build PoW response header data (same format as WASM solver)
  const powData = JSON.stringify({
    algorithm: challenge.algorithm || "PoW_SHA3",
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer: nonce,
    signature: challenge.signature || "",
    target_path: "/api/v0/chat/completion",
  });

  // Base64 encode (safe for ASCII JSON)
  const base64 = Buffer.from(powData, "utf8").toString("base64");

  return { nonce, powData: base64 };
}
