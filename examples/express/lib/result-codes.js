"use strict";

/**
 * Fail-closed Peach Payments result-code mapper.
 * Based on verified skill reference patterns (references/result-codes.md, scripts/map-result-code.js).
 *
 * Rules:
 * - ANY whitespace (leading/trailing/embedded, incl. "\n") -> error.
 * - 000.400.101 and 000.400.102 are intermediate 3DS-step codes, NOT success.
 * - 000.100.2xx is the chargeback/reversal family, NOT success.
 * - Unknown codes fail closed to "error".
 * - Missing/empty code is treated as "pending" (session open).
 */

const SUCCESS = /^(000\.000\.|000\.100\.1|000\.[36])/;
const SUCCESS_REVIEW = /^(000\.400\.0[0-24-9]|000\.400\.100|000\.400\.1[12]0)/;
const PENDING = /^(000\.200)/;
const PENDING_EXT = /^(800\.400\.5|100\.400\.500)/;
const REQUIRES_MORE = /^(300\.100\.100|900\.100\.[34])/;
const CANCELLED = /^(100\.396\.101|100\.396\.104)/;
const CODE_SHAPE = /^\d{3}\.\d{3}\.\d{3}$/;

/**
 * Maps a raw Peach result code string to a status category.
 * @param {string} raw - Dotted result code, e.g. "000.100.110"
 * @returns {"captured"|"review"|"pending"|"requires_more"|"canceled"|"error"}
 */
function mapResultCode(raw) {
  if (raw == null || raw === "") return "pending";
  const code = String(raw);
  if (/\s/.test(code) || !CODE_SHAPE.test(code)) return "error";
  if (SUCCESS.test(code)) return "captured";
  if (SUCCESS_REVIEW.test(code)) return "review";
  if (PENDING.test(code)) return "pending";
  if (PENDING_EXT.test(code)) return "pending";
  if (REQUIRES_MORE.test(code)) return "requires_more";
  if (CANCELLED.test(code)) return "canceled";
  return "error";
}

/**
 * Convenience helper to determine if a code represents captured payment.
 * @param {string} raw
 * @returns {boolean}
 */
function isSuccessResultCode(raw) {
  return mapResultCode(raw) === "captured";
}

module.exports = {
  mapResultCode,
  isSuccessResultCode,
  SUCCESS,
  SUCCESS_REVIEW,
  PENDING,
  CANCELLED,
};
