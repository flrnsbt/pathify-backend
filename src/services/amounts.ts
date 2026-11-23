/**
 * Token amount helpers shared by the transaction creator and the verifier.
 * All math is done in base units (BigInt) to avoid floating point errors.
 */

/**
 * Parses a decimal token amount string into base units without floating
 * point errors or zero-stripping bugs. Excess fraction digits are truncated,
 * missing digits are zero-padded.
 */
export function parseTokenUnits(amountStr: string, decimals: number): bigint {
  const trimmed = amountStr.trim();
  if (!trimmed || isNaN(Number(trimmed))) {
    throw new Error(`Invalid amount string: "${amountStr}"`);
  }

  const parts = trimmed.split(".");
  const wholePart = parts[0] || "0";
  let fractionPart = parts[1] || "";

  if (fractionPart.length > decimals) {
    fractionPart = fractionPart.slice(0, decimals);
  } else {
    fractionPart = fractionPart.padEnd(decimals, "0");
  }

  return BigInt(wholePart) * BigInt(10) ** BigInt(decimals) + BigInt(fractionPart);
}

/**
 * Formats base units back into a decimal string with at most `decimals`
 * fractional digits (trailing zeros trimmed). Never uses exponent notation.
 */
export function formatTokenUnits(units: bigint, decimals: number): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const base = BigInt(10) ** BigInt(decimals);
  const whole = abs / base;
  const fraction = abs % base;

  let result = whole.toString();
  if (fraction > 0n) {
    const fracStr = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
    result += "." + fracStr;
  }
  return (negative ? "-" : "") + result;
}

/**
 * Maximum USD value of the random "uniqueness tag" added to direct-transfer
 * amounts. The tag makes every manual payment amount unique so it can be
 * matched to exactly one pending transaction on-chain.
 */
export const DIRECT_AMOUNT_MAX_OVERPAY_USD = 0.5;

/**
 * Adds a random uniqueness tag to a base-unit amount. The tag is a random
 * number of base units worth at most DIRECT_AMOUNT_MAX_OVERPAY_USD, giving
 * each pending direct payment a distinct, unguessable amount.
 *
 * @param baseUnits   amount in base units (without tag)
 * @param decimals    token decimals
 * @param priceUsd    current USD price of the token (must be > 0)
 */
export function addUniquenessTag(
  baseUnits: bigint,
  decimals: number,
  priceUsd: number,
): bigint {
  // tag ceiling in base units: $MAX_OVERPAY worth of token
  const priceMicroUsd = BigInt(Math.max(1, Math.floor(priceUsd * 1e6)));
  const maxTagUnits =
    (BigInt(Math.floor(DIRECT_AMOUNT_MAX_OVERPAY_USD * 1e6)) *
      BigInt(10) ** BigInt(decimals)) /
    priceMicroUsd;

  // crypto.getRandomValues for an unbiased-ish range; range can exceed 2^32
  // so build a BigInt from random bytes.
  const range = maxTagUnits > 1n ? maxTagUnits - 1n : 1n;
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const rand = BigInt("0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""));
  const tag = 1n + (rand % range);

  return baseUnits + tag;
}
