<?php
/**
 * Fail-closed Peach Payments result code mapper in plain PHP.
 * Based on verified skill reference patterns (references/result-codes.md, scripts/map-result-code.js).
 *
 * Rules:
 * - ANY whitespace (leading/trailing/embedded, incl. "\n") -> error.
 * - 000.400.101 and 000.400.102 are intermediate 3DS-step codes, NOT success.
 * - 000.100.2xx is the chargeback/reversal family, NOT success.
 * - Unknown codes fail closed to "error".
 * - Missing/empty code is treated as "pending" (session open).
 */

declare(strict_types=1);

/**
 * Maps a raw Peach result code string to a status category.
 *
 * @param string|null $raw
 * @return string "captured" | "review" | "pending" | "requires_more" | "canceled" | "error"
 */
function map_result_code(?string $raw): string {
    if ($raw === null || $raw === '') {
        return 'pending';
    }

    $code = (string)$raw;

    // Fail closed on any whitespace (leading, trailing, embedded) or non-matching format
    if (preg_match('/\s/', $code) === 1 || preg_match('/^\d{3}\.\d{3}\.\d{3}$/', $code) !== 1) {
        return 'error';
    }

    // Success (000.000.*, 000.100.1*, 000.3*, 000.6*)
    if (preg_match('/^(000\.000\.|000\.100\.1|000\.[36])/', $code) === 1) {
        return 'captured';
    }

    // Review band (000.400.0xx except 03x, 000.400.100, 000.400.110/120)
    if (preg_match('/^(000\.400\.0[0-24-9]|000\.400\.100|000\.400\.1[12]0)/', $code) === 1) {
        return 'review';
    }

    // Pending short-term (000.200.*) or external pending (800.400.5*, 100.400.500)
    if (preg_match('/^(000\.200)/', $code) === 1 || preg_match('/^(800\.400\.5|100\.400\.500)/', $code) === 1) {
        return 'pending';
    }

    // Requires shopper action / SCA soft-decline (300.100.100, 900.100.3xx/4xx)
    if (preg_match('/^(300\.100\.100|900\.100\.[34])/', $code) === 1) {
        return 'requires_more';
    }

    // Cancelled by user / uncertain (100.396.101, 100.396.104)
    if (preg_match('/^(100\.396\.101|100\.396\.104)/', $code) === 1) {
        return 'canceled';
    }

    // Declines, 000.100.2xx chargebacks, 000.400.101/102 3DS intermediate codes, unknown codes fail closed
    return 'error';
}

/**
 * Convenience helper to check if a code represents captured payment.
 *
 * @param string|null $raw
 * @return bool
 */
function is_success_result_code(?string $raw): bool {
    return map_result_code($raw) === 'captured';
}
