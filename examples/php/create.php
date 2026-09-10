<?php
/**
 * Create Checkout Session & Status Confirmation Endpoint in plain PHP.
 *
 * Actions:
 * - POST / GET (default): Initiates server-side OAuth and creates Checkout V2 session.
 *   Returns ONLY browser-safe identifiers: checkoutId and entityId (semi-public SDK key).
 *   Never exposes secretToken, clientSecret, or OAuth access token.
 * - GET ?status=1&checkoutId=...: Queries GET /v2/checkout/{id}/status, maps the result code,
 *   enforces amount integrity against the stored created amount, and triggers fulfilment on success.
 */

declare(strict_types=1);

require_once __DIR__ . '/peach.php';
require_once __DIR__ . '/result_codes.php';
require_once __DIR__ . '/store.php';

header('Content-Type: application/json');

// Check if this is a status verification request from the frontend widget onCompleted event
$checkoutIdParam = $_GET['checkoutId'] ?? $_GET['cid'] ?? null;
if ($checkoutIdParam !== null && is_string($checkoutIdParam) && trim($checkoutIdParam) !== '') {
    $checkoutId = trim($checkoutIdParam);
    try {
        $statusData = getCheckoutStatus($checkoutId);
        $statusCodeVal = isset($statusData['result.code']) ? (string)$statusData['result.code'] : null;
        $statusCategory = map_result_code($statusCodeVal);
        $amount = isset($statusData['amount']) ? (string)$statusData['amount'] : null;
        $isCaptured = is_success_result_code($statusCodeVal);

        // Enforce amount integrity against stored created amount
        $expectedAmount = get_created_amount($checkoutId);
        $amountMatches = false;
        if ($expectedAmount !== null && $amount !== null) {
            if (function_exists('bccomp')) {
                $amountMatches = (bccomp($amount, $expectedAmount, 2) === 0);
            } else {
                $amountMatches = (number_format((float)$amount, 2, '.', '') === number_format((float)$expectedAmount, 2, '.', ''));
            }
        }

        $fulfilled = false;
        if ($isCaptured && $amountMatches && !is_checkout_processed($checkoutId)) {
            mark_checkout_processed($checkoutId);
            $txId = (string)($statusData['id'] ?? 'unknown');
            $currency = (string)($statusData['currency'] ?? 'ZAR');
            error_log("[FULFILLED] Order confirmed via status API for checkout {$checkoutId} | TxID: {$txId} | Amount: {$amount} {$currency}");
            $fulfilled = true;
        } elseif ($isCaptured && $amountMatches && is_checkout_processed($checkoutId)) {
            $fulfilled = true;
        }

        echo json_encode([
            'checkoutId' => $checkoutId,
            'resultCode' => $statusCodeVal,
            'status' => $statusCategory,
            'amount' => $amount,
            'currency' => $statusData['currency'] ?? 'ZAR',
            'transactionId' => $statusData['id'] ?? null,
            'paymentBrand' => $statusData['paymentBrand'] ?? null,
            'fulfilled' => $fulfilled,
        ]);
        exit;
    } catch (Exception $e) {
        error_log("[STATUS CONFIRM ERROR] Checkout {$checkoutId}: " . $e->getMessage());
        http_response_code(500);
        echo json_encode(['error' => $e->getMessage()]);
        exit;
    }
}

// Otherwise, handle checkout session creation
try {
    // Checkout amounts are major-unit decimal strings ("10.00"), never cents
    $amount = '10.00';
    $currency = getenv('PEACH_CURRENCY') ?: 'ZAR';
    $orderId = 'ORD-' . (int)(microtime(true) * 1000);

    $session = create_checkout_session([
        'amount' => $amount,
        'currency' => $currency,
        'orderId' => $orderId,
    ]);

    $checkoutId = (string)($session['checkoutId'] ?? '');
    if ($checkoutId === '') {
        http_response_code(500);
        echo json_encode(['error' => 'Missing checkoutId in Peach session response']);
        exit;
    }

    // Store created amount keyed by checkoutId for amount integrity checks at fulfillment
    store_created_amount($checkoutId, $amount);

    // Return browser-safe identifiers only: checkoutId and entityId
    echo json_encode([
        'checkoutId' => $checkoutId,
        'entityId' => getenv('PEACH_ENTITY_ID') ?: '',
        'redirectUrl' => $session['redirectUrl'] ?? '',
        'amount' => $amount,
        'currency' => $currency,
    ]);
} catch (Exception $e) {
    error_log("[CHECKOUT CREATE ERROR] " . $e->getMessage());
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
