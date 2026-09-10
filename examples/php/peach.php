<?php
/**
 * Server-side Peach Payments Checkout V2 client library in plain PHP.
 * Zero external dependencies (uses native cURL).
 *
 * Enforces:
 * - Server-side OAuth token retrieval with dynamic expires_in caching (60s early refresh)
 * - 401 mid-flight single retry
 * - BOTH Origin (no trailing slash) and Referer (with trailing slash) headers on checkout creation
 * - Major-unit decimal strings for amounts ("10.00"), never cents
 * - Flat dotted-key status query (GET /v2/checkout/{id}/status)
 * - Defaults hosts to sandbox environments
 */

declare(strict_types=1);

/**
 * Internal helper for executing JSON HTTP requests via native cURL.
 *
 * @param string $url
 * @param string $method
 * @param array<string, string>|array<int, string> $headers
 * @param array<string, mixed>|null $payload
 * @return array{0: int, 1: array<string, mixed>} [httpStatusCode, parsedData]
 */
function peach_request_json(string $url, string $method = 'GET', array $headers = [], ?array $payload = null): array {
    $ch = curl_init();
    if ($ch === false) {
        throw new RuntimeException('Failed to initialize cURL session');
    }

    $reqHeaders = ['Accept: application/json'];
    foreach ($headers as $k => $v) {
        if (is_int($k)) {
            $reqHeaders[] = $v;
        } else {
            $reqHeaders[] = "{$k}: {$v}";
        }
    }

    curl_setopt($ch, CURLOPT_URL, $url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $method);
    curl_setopt($ch, CURLOPT_TIMEOUT, 30);
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
    curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, 2);

    if ($payload !== null) {
        $body = json_encode($payload, JSON_UNESCAPED_SLASHES);
        $reqHeaders[] = 'Content-Type: application/json';
        curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
    }

    curl_setopt($ch, CURLOPT_HTTPHEADER, $reqHeaders);

    $response = curl_exec($ch);
    $httpCode = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlErr = curl_error($ch);
    curl_close($ch);

    if ($response === false) {
        throw new RuntimeException("cURL request error: {$curlErr}");
    }

    $data = json_decode((string)$response, true);
    if (!is_array($data)) {
        $data = ['error' => (string)$response];
    }

    return [$httpCode, $data];
}

/**
 * Server-side OAuth token retrieval with dynamic caching.
 * Caches token based on Peach's returned expires_in value (sandbox observed at 14400s / 4h).
 * Refreshes ~60s before expiration. Does NOT hardcode a fixed token lifetime.
 *
 * @param bool $forceRefresh
 * @return string Bearer access token
 */
function get_access_token(bool $forceRefresh = false): string {
    static $cachedToken = null;
    static $tokenExpiresAt = 0;

    $now = time();
    $clientId = getenv('PEACH_CLIENT_ID') ?: '';
    $cacheFile = sys_get_temp_dir() . '/peach_token_cache_' . md5($clientId) . '.json';

    if (!$forceRefresh) {
        if ($cachedToken !== null && $now < ($tokenExpiresAt - 60)) {
            return $cachedToken;
        }
        if ($clientId !== '' && file_exists($cacheFile)) {
            $content = @file_get_contents($cacheFile);
            if ($content !== false) {
                $cacheData = json_decode($content, true);
                if (is_array($cacheData) && isset($cacheData['token'], $cacheData['expires_at'])) {
                    if ($now < ((int)$cacheData['expires_at'] - 60)) {
                        $cachedToken = (string)$cacheData['token'];
                        $tokenExpiresAt = (int)$cacheData['expires_at'];
                        return $cachedToken;
                    }
                }
            }
        }
    }

    $authHost = rtrim(getenv('PEACH_AUTH_HOST') ?: 'https://sandbox-dashboard.peachpayments.com', '/');
    $clientSecret = getenv('PEACH_CLIENT_SECRET') ?: '';
    $merchantId = getenv('PEACH_MERCHANT_ID') ?: '';

    if ($clientId === '' || $clientSecret === '' || $merchantId === '') {
        throw new RuntimeException('Missing required Peach credentials: PEACH_CLIENT_ID, PEACH_CLIENT_SECRET, PEACH_MERCHANT_ID');
    }

    [$status, $data] = peach_request_json(
        "{$authHost}/api/oauth/token",
        'POST',
        [],
        [
            'clientId' => $clientId,
            'clientSecret' => $clientSecret,
            'merchantId' => $merchantId,
        ]
    );

    if ($status >= 400 || empty($data['access_token'])) {
        $err = json_encode($data);
        throw new RuntimeException("Failed to obtain Peach access token (HTTP {$status}): {$err}");
    }

    $cachedToken = (string)$data['access_token'];
    $expiresIn = isset($data['expires_in']) ? (int)$data['expires_in'] : 14400;
    $tokenExpiresAt = $now + $expiresIn;

    if ($clientId !== '') {
        // The cache holds a live bearer token — it must not be world-readable on shared hosting.
        // Create the file 0600 BEFORE writing so it is never briefly 0644. (Demo convenience; a
        // real app should cache in its own process memory or a secret store, not a shared /tmp file.)
        $payload = json_encode([
            'token' => $cachedToken,
            'expires_at' => $tokenExpiresAt,
        ]);
        if (!file_exists($cacheFile)) {
            @touch($cacheFile);
        }
        @chmod($cacheFile, 0600);
        @file_put_contents($cacheFile, $payload, LOCK_EX);
    }

    return $cachedToken;
}

/**
 * Creates a Checkout V2 session on Peach Payments.
 * Enforces:
 * - BOTH Origin (no trailing slash) and Referer (with trailing slash) headers.
 * - Major-unit decimal string amount ("10.00"), never cents.
 * - Server-side execution only.
 * - 401 mid-flight retry once.
 *
 * @param array<string, mixed> $params
 * @return array<string, mixed>
 */
function create_checkout_session(array $params = []): array {
    $checkoutHost = rtrim(getenv('PEACH_CHECKOUT_HOST') ?: 'https://testsecure.peachpayments.com', '/');
    $entityId = getenv('PEACH_ENTITY_ID') ?: '';

    if ($entityId === '') {
        throw new RuntimeException('Missing required PEACH_ENTITY_ID in environment');
    }

    $appUrl = rtrim(getenv('APP_URL') ?: 'http://localhost:8000', '/');
    // Verified requirement: BOTH Origin (NO trailing slash) and Referer (WITH trailing slash)
    $originHeader = $appUrl;
    $refererHeader = "{$appUrl}/";

    $merchantTxId = 'TX' . strtoupper(bin2hex(random_bytes(6)));
    $nonce = sprintf(
        '%04x%04x-%04x-%04x-%04x-%04x%04x%04x',
        mt_rand(0, 0xffff),
        mt_rand(0, 0xffff),
        mt_rand(0, 0xffff),
        mt_rand(0, 0x0fff) | 0x4000,
        mt_rand(0, 0x3fff) | 0x8000,
        mt_rand(0, 0xffff),
        mt_rand(0, 0xffff),
        mt_rand(0, 0xffff)
    );

    // Checkout amounts are major-unit decimal strings ("10.00"), never cents
    $amount = isset($params['amount']) ? (string)$params['amount'] : '10.00';
    $currency = isset($params['currency']) ? (string)$params['currency'] : (getenv('PEACH_CURRENCY') ?: 'ZAR');
    $shopperResultUrl = isset($params['shopperResultUrl'])
        ? strtolower((string)$params['shopperResultUrl'])
        : strtolower("{$appUrl}/");
    $orderId = isset($params['orderId']) ? (string)$params['orderId'] : ('ORD-' . (int)(microtime(true) * 1000));

    $payload = [
        'authentication.entityId' => $entityId,
        'merchantTransactionId' => $merchantTxId,
        'amount' => $amount,
        'currency' => $currency,
        'nonce' => $nonce,
        'shopperResultUrl' => $shopperResultUrl,
        'defaultPaymentMethod' => 'CARD',
        'forceDefaultMethod' => true,
        'paymentType' => 'DB',
        'customer' => [
            'givenName' => 'Jane',
            'surname' => 'Doe',
            'email' => 'jane.doe@example.com',
        ],
        'customParameters' => [
            'orderId' => $orderId,
            'createdAmount' => $amount,
        ],
    ];

    $token = get_access_token();
    $headers = [
        'Authorization' => "Bearer {$token}",
        'Origin' => $originHeader,
        'Referer' => $refererHeader,
    ];

    [$status, $data] = peach_request_json(
        "{$checkoutHost}/v2/checkout",
        'POST',
        $headers,
        $payload
    );

    // On 401 mid-flight: clear token, re-auth once, retry once
    if ($status === 401) {
        $token = get_access_token(true);
        $headers['Authorization'] = "Bearer {$token}";
        [$status, $data] = peach_request_json(
            "{$checkoutHost}/v2/checkout",
            'POST',
            $headers,
            $payload
        );
    }

    if ($status >= 400) {
        $err = json_encode($data);
        throw new RuntimeException("Failed to create checkout (HTTP {$status}): {$err}");
    }

    return $data;
}

/**
 * Fetches status of a Checkout V2 session.
 * Response is a FLAT object with dotted string keys: obj["result.code"], obj["amount"], etc.
 *
 * @param string $checkoutId
 * @return array<string, mixed>
 */
function get_checkout_status(string $checkoutId): array {
    $checkoutHost = rtrim(getenv('PEACH_CHECKOUT_HOST') ?: 'https://testsecure.peachpayments.com', '/');
    $token = get_access_token();
    $headers = [
        'Authorization' => "Bearer {$token}",
    ];

    $encodedId = rawurlencode($checkoutId);
    $url = "{$checkoutHost}/v2/checkout/{$encodedId}/status";

    [$status, $data] = peach_request_json($url, 'GET', $headers);

    // On 401 mid-flight: clear token, re-auth once, retry once
    if ($status === 401) {
        $token = get_access_token(true);
        $headers['Authorization'] = "Bearer {$token}";
        [$status, $data] = peach_request_json($url, 'GET', $headers);
    }

    if ($status >= 400) {
        $err = json_encode($data);
        throw new RuntimeException("Failed to fetch checkout status (HTTP {$status}): {$err}");
    }

    return $data;
}

// Aliases matching SDK conventions
function getCheckoutStatus(string $checkoutId): array {
    return get_checkout_status($checkoutId);
}

function createCheckoutSession(array $params = []): array {
    return create_checkout_session($params);
}

function getAccessToken(bool $forceRefresh = false): string {
    return get_access_token($forceRefresh);
}
