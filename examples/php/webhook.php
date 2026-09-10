<?php
/**
 * Peach Payments Webhook Endpoint in plain PHP (Checkout V2).
 *
 * Core Security Doctrines Enforced:
 * 1. Read the RAW body directly from php://input. NEVER use $_POST, which parses and destroys
 *    the exact byte sequence required for HMAC-SHA256 signature verification.
 * 2. Fail closed: Any unverified signature or missing secret immediately rejects with HTTP 400.
 * 3. The webhook is a wake-up call, not truth. Never fulfill based on the webhook payload alone;
 *    always re-query GET /v2/checkout/{id}/status and confirm both terminal outcome and amount.
 * 4. Compare monetary amounts using bcmath / fixed-point decimals, never native floats.
 * 5. Deduplicate by checkoutId to guarantee idempotent processing across retries (Peach retries up to 30 days).
 */

declare(strict_types=1);

require_once __DIR__ . '/peach.php';
require_once __DIR__ . '/verify_webhook.php';
require_once __DIR__ . '/result_codes.php';
require_once __DIR__ . '/store.php';

/**
 * Gathers incoming HTTP request headers across server environments (CLI, builtin server, Apache/FPM).
 *
 * @return array<string, string>
 */
function get_incoming_headers(): array {
    if (function_exists('getallheaders')) {
        $headers = getallheaders();
        if (is_array($headers)) {
            $normalized = [];
            foreach ($headers as $k => $v) {
                $normalized[strtolower((string)$k)] = (string)$v;
            }
            return $normalized;
        }
    }

    $headers = [];
    foreach ($_SERVER as $name => $value) {
        if (str_starts_with($name, 'HTTP_')) {
            $headerName = strtolower(str_replace('_', '-', substr($name, 5)));
            $headers[$headerName] = (string)$value;
        }
    }
    return $headers;
}

/**
 * Fulfilment stub: invoked strictly AFTER signature verification, terminal /status query,
 * and amount integrity checks succeed.
 *
 * @param string $checkoutId
 * @param array<string, mixed> $statusData
 * @return void
 */
function fulfill_order(string $checkoutId, array $statusData): void {
    $amount = (string)($statusData['amount'] ?? 'unknown');
    $currency = (string)($statusData['currency'] ?? 'ZAR');
    $txId = (string)($statusData['id'] ?? 'unknown');
    error_log("[FULFILLED] Order confirmed for checkout {$checkoutId} | TxID: {$txId} | Amount: {$amount} {$currency}");
}

// Ensure execution runs only for HTTP requests (skip direct CLI execution unless testing)
if (php_sapi_name() !== 'cli' || !empty($_SERVER['REQUEST_METHOD'])) {
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
        http_response_code(405);
        header('Content-Type: application/json');
        echo json_encode(['error' => 'Method not allowed. Peach webhooks require POST.']);
        exit;
    }

    // 1. Read the EXACT raw request body bytes via php://input
    $rawBody = (string)file_get_contents('php://input');
    $headers = get_incoming_headers();

    $secretToken = getenv('PEACH_SECRET_TOKEN') ?: null;
    $webhookSecret = getenv('PEACH_WEBHOOK_SECRET') ?: null;
    $configuredUrl = getenv('PEACH_WEBHOOK_URL') ?: null;

    // 2. Verify webhook signature (fail closed)
    $verification = verify_webhook_signature(
        $rawBody,
        $headers,
        $secretToken,
        $webhookSecret,
        $configuredUrl
    );

    if (!$verification['valid']) {
        $reason = $verification['reason'] ?? 'unknown';
        error_log("[WEBHOOK REJECTED] Signature verification failed ({$reason})");
        http_response_code(400);
        header('Content-Type: application/json');
        echo json_encode(['error' => 'Invalid webhook signature', 'reason' => $reason]);
        return;
    }

    // 3. Extract checkoutId and result.code from verified raw payload
    $checkoutId = null;
    $webhookResultCode = null;

    $stripped = trim($rawBody);
    if (str_starts_with($stripped, '{')) {
        $jsonData = json_decode($stripped, true);
        if (is_array($jsonData)) {
            $checkoutId = isset($jsonData['checkoutId']) ? (string)$jsonData['checkoutId'] : null;
            $webhookResultCode = isset($jsonData['result.code']) ? (string)$jsonData['result.code'] : null;
        }
    } else {
        $params = parse_raw_form_params($rawBody);
        foreach ($params as $pair) {
            if ($pair[0] === 'checkoutId') {
                $checkoutId = $pair[1];
            } elseif ($pair[0] === 'result.code') {
                $webhookResultCode = $pair[1];
            }
        }
    }

    if ($checkoutId === null || $checkoutId === '') {
        // Ping or payload with no checkoutId: acknowledge with 200 without action
        http_response_code(200);
        header('Content-Type: application/json');
        echo json_encode(['message' => 'No checkoutId present, acknowledged']);
        exit;
    }

    // 4. Idempotency deduplication by checkoutId
    if (is_checkout_processed($checkoutId)) {
        // Fast-path short-circuit ONLY (not the atomicity guarantee): a cheap read to skip
        // already-fulfilled checkouts before the /status call. The real concurrency guard is the
        // atomic claim_checkout() at fulfilment below, which holds a lock across check-and-set.
        error_log("[WEBHOOK DEDUPE] Checkout {$checkoutId} already processed, skipping");
        http_response_code(200);
        header('Content-Type: application/json');
        echo json_encode(['status' => 'already_processed']);
        exit;
    }

    // 5. Check whether the webhook signals terminal capture
    // (Pending codes like 000.200.* must NOT trigger fulfilment)
    $webhookStatus = map_result_code($webhookResultCode);
    if ($webhookStatus !== 'captured') {
        error_log("[WEBHOOK IGNORED] Non-terminal code: {$webhookResultCode} ({$webhookStatus})");
        http_response_code(200);
        header('Content-Type: application/json');
        echo json_encode(['status' => 'acknowledged_non_terminal']);
        exit;
    }

    // 6. Wake-up doctrine: re-fetch GET /v2/checkout/{id}/status to confirm truth
    try {
        $statusData = getCheckoutStatus($checkoutId);
    } catch (Exception $e) {
        error_log("[WEBHOOK ERROR] Failed to fetch /v2/checkout/{$checkoutId}/status: " . $e->getMessage());
        // Return 500 to request Peach retry via exponential backoff
        http_response_code(500);
        header('Content-Type: application/json');
        echo json_encode(['error' => 'Failed to verify status']);
        exit;
    }

    $confirmedCode = isset($statusData['result.code']) ? (string)$statusData['result.code'] : null;
    $confirmedStatus = map_result_code($confirmedCode);
    $confirmedAmount = isset($statusData['amount']) ? (string)$statusData['amount'] : null;

    // 7. Enforce amount integrity: confirm amount matches stored created amount using bcmath
    $expectedAmount = get_created_amount($checkoutId);
    $amountMatches = false;

    if ($expectedAmount !== null && $confirmedAmount !== null) {
        if (function_exists('bccomp')) {
            $amountMatches = (bccomp($confirmedAmount, $expectedAmount, 2) === 0);
        } else {
            $amountMatches = (number_format((float)$confirmedAmount, 2, '.', '') === number_format((float)$expectedAmount, 2, '.', ''));
        }
    }

    // 8. Fulfil only if confirmed status is captured AND amount matches exactly
    if ($confirmedStatus === 'captured' && $amountMatches) {
        // ATOMIC claim-then-fulfil: claim_checkout() holds LOCK_EX across check-and-set, so under
        // concurrent PHP-FPM workers exactly ONE wins the claim and fulfils; the others get false
        // and must not re-fulfil. This is what makes fulfilment safe across processes.
        if (claim_checkout($checkoutId)) {
            fulfill_order($checkoutId, $statusData);
            http_response_code(200);
            header('Content-Type: application/json');
            echo json_encode(['status' => 'fulfilled']);
        } else {
            error_log("[WEBHOOK DEDUPE] Checkout {$checkoutId} claimed by a concurrent worker — not re-fulfilling");
            http_response_code(200);
            header('Content-Type: application/json');
            echo json_encode(['status' => 'already_processed']);
        }
        exit;
    }

    error_log("[WEBHOOK FULFIL REJECTED] Verification mismatch on /status. Code: {$confirmedCode}, Amount: {$confirmedAmount}, Expected: {$expectedAmount}");
    http_response_code(200);
    header('Content-Type: application/json');
    echo json_encode(['status' => 'verification_failed']);
    exit;
}
