<?php
/**
 * Peach Payments webhook signature verification in plain PHP.
 *
 * Supports:
 * - Scheme A (Checkout default): Classic form-urlencoded body signature with secret token.
 *   Canonical: all parameters sorted by key (excluding 'signature'), concatenated key+value with no separators.
 *   Empty values ARE part of the canonical string.
 * - Scheme B: Dashboard header scheme (x-webhook-signature) with webhook secret.
 *   Canonical: "{timestamp}.{webhook_id}.{url}.{raw_body}"
 *   Replay protection: rejects stale timestamps > 5 minutes BEFORE computing HMAC.
 *
 * FAILS CLOSED: With no secret configured, verification always returns ['valid' => false, 'reason' => 'no_secret_configured'].
 */

declare(strict_types=1);

/**
 * Case-insensitive header lookup from associative headers array.
 *
 * @param array<string, mixed> $headers
 * @param string $name
 * @return string|null
 */
function get_case_insensitive_header(array $headers, string $name): ?string {
    $target = strtolower($name);
    foreach ($headers as $k => $v) {
        if (strtolower((string)$k) === $target) {
            return is_array($v) ? (string)reset($v) : (string)$v;
        }
    }
    return null;
}

/**
 * Parses raw form-urlencoded body into a list of [key, value] pairs,
 * preserving parameter order, empty values, and dotted/bracketed key names.
 *
 * NOTE: PHP's built-in parse_str() converts dots and spaces in keys to underscores
 * (e.g. "result.code" gets mangled to an underscored key), which corrupts the canonical string
 * and destroys Peach signature verification. This parser avoids that fatal flaw.
 *
 * @param string $rawBody
 * @return array<int, array{0: string, 1: string}> List of [key, value] pairs
 */
function parse_raw_form_params(string $rawBody): array {
    if ($rawBody === '') {
        return [];
    }

    $pairs = explode('&', $rawBody);
    $entries = [];

    foreach ($pairs as $pair) {
        if ($pair === '') {
            continue;
        }
        $parts = explode('=', $pair, 2);
        $k = urldecode($parts[0]);
        $v = isset($parts[1]) ? urldecode($parts[1]) : '';
        $entries[] = [$k, $v];
    }

    return $entries;
}

/**
 * Flattens nested array or object into bracket-notation parameter pairs.
 * Used when a webhook payload arrives as JSON (such as Dashboard config pings or Payment Links).
 *
 * @param mixed $data
 * @param string $prefix
 * @param array<int, array{0: string, 1: string}> $out
 * @return array<int, array{0: string, 1: string}>
 */
function flatten_params(mixed $data, string $prefix = '', array &$out = []): array {
    if (is_array($data)) {
        $isAssoc = array_keys($data) !== range(0, count($data) - 1);
        foreach ($data as $k => $v) {
            if ($isAssoc) {
                $key = $prefix !== '' ? "{$prefix}[{$k}]" : (string)$k;
                flatten_params($v, $key, $out);
            } else {
                // Repeated key for list items
                flatten_params($v, $prefix, $out);
            }
        }
    } else {
        $val = $data === null ? '' : (string)$data;
        $out[] = [$prefix, $val];
    }
    return $out;
}

/**
 * Scheme A canonical string construction:
 * Sort all parameters alphabetically by key (excluding 'signature'),
 * concatenate key + value with no separators.
 * Empty values ARE part of the canonical string.
 *
 * @param array<int, array{0: string, 1: string}> $params
 * @return string
 */
function classic_canonical_message(array $params): string {
    $filtered = [];
    foreach ($params as $pair) {
        if ($pair[0] !== 'signature') {
            $filtered[] = $pair;
        }
    }

    usort($filtered, function (array $a, array $b): int {
        return strcmp($a[0], $b[0]);
    });

    $message = '';
    foreach ($filtered as $pair) {
        $message .= $pair[0] . $pair[1];
    }

    return $message;
}

/**
 * Verifies Peach Payments webhook signatures.
 * Fails closed if no secret is configured.
 *
 * @param string $rawBody Exact raw request body string
 * @param array<string, mixed> $headers Request headers
 * @param string|null $secretToken PEACH_SECRET_TOKEN for Scheme A
 * @param string|null $webhookSecret PEACH_WEBHOOK_SECRET for Scheme B
 * @param string|null $configuredUrl Webhook URL as configured in Dashboard
 * @param int $maxAgeSec Max timestamp age in seconds for Scheme B replay protection (default 300s = 5m)
 * @return array{valid: bool, scheme?: string, reason?: string}
 */
function verify_webhook_signature(
    string $rawBody,
    array $headers = [],
    ?string $secretToken = null,
    ?string $webhookSecret = null,
    ?string $configuredUrl = null,
    int $maxAgeSec = 300
): array {
    $cleanSecretToken = ($secretToken !== null && trim($secretToken) !== '') ? trim($secretToken) : null;
    $cleanWebhookSecret = ($webhookSecret !== null && trim($webhookSecret) !== '') ? trim($webhookSecret) : null;

    // Fail closed if no secret is configured
    if ($cleanSecretToken === null && $cleanWebhookSecret === null) {
        return ['valid' => false, 'reason' => 'no_secret_configured'];
    }

    // 1. Parse parameters for Scheme A check
    $params = [];
    $bodySig = null;

    $stripped = trim($rawBody);
    if (str_starts_with($stripped, '{')) {
        $jsonData = json_decode($stripped, true);
        if (is_array($jsonData)) {
            if (isset($jsonData['signature']) && is_string($jsonData['signature'])) {
                $bodySig = $jsonData['signature'];
            }
            $flat = [];
            flatten_params($jsonData, '', $flat);
            $params = $flat;
        }
    } else {
        $params = parse_raw_form_params($rawBody);
        foreach ($params as $pair) {
            if ($pair[0] === 'signature') {
                $bodySig = $pair[1];
                break;
            }
        }
    }

    // 2. Scheme A check (Checkout default: signature inside form body)
    if ($bodySig !== null && $cleanSecretToken !== null) {
        $message = classic_canonical_message($params);
        $expectedHex = hash_hmac('sha256', $message, $cleanSecretToken);
        if (hash_equals(strtolower($expectedHex), strtolower($bodySig))) {
            return ['valid' => true, 'scheme' => 'classic-body'];
        }
    }

    // 3. Scheme B check (Header scheme: x-webhook-signature)
    $headerSig = get_case_insensitive_header($headers, 'x-webhook-signature');
    $timestamp = get_case_insensitive_header($headers, 'x-webhook-timestamp');
    $webhookId = get_case_insensitive_header($headers, 'x-webhook-id');

    if ($headerSig !== null && $cleanWebhookSecret !== null) {
        // Replay protection: reject stale timestamp BEFORE computing HMAC
        $rawTs = trim((string)$timestamp);
        if ($rawTs === '' || !is_numeric($rawTs)) {
            return ['valid' => false, 'reason' => 'stale_timestamp'];
        }

        $tsFloat = (float)$rawTs;
        // Convert 13-digit millisecond timestamps to seconds
        if (strlen($rawTs) === 13) {
            $tsFloat /= 1000.0;
        }

        $now = (float)time();
        if (abs($now - $tsFloat) > $maxAgeSec) {
            return ['valid' => false, 'reason' => 'stale_timestamp'];
        }

        $tsStr = $timestamp ?? '';
        $idStr = $webhookId ?? '';
        $urlStr = $configuredUrl ?? '';
        $message = "{$tsStr}.{$idStr}.{$urlStr}.{$rawBody}";

        $expectedHex = hash_hmac('sha256', $message, $cleanWebhookSecret);
        if (hash_equals(strtolower($expectedHex), strtolower($headerSig))) {
            return ['valid' => true, 'scheme' => 'header-signature'];
        }
    }

    if ($bodySig !== null || $headerSig !== null) {
        return ['valid' => false, 'reason' => 'signature_mismatch'];
    }

    return ['valid' => false, 'reason' => 'missing_signature'];
}
