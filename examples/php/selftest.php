<?php
/**
 * CLI Self-Test for Peach Payments PHP Reference Integration.
 *
 * Verifies:
 * - verify_webhook.php: validates a correctly-signed classic sample
 * - verify_webhook.php: REJECTS a tampered classic sample
 * - verify_webhook.php: header scheme fresh-valid TRUE
 * - verify_webhook.php: header scheme stale FALSE (> 5 min)
 * - verify_webhook.php: no-secret fails closed FALSE
 * - result_codes.php: 000.000.000 -> captured
 * - result_codes.php: 000.400.101 -> error (3DS intermediate code, NOT success)
 * - result_codes.php: junk / whitespace / invalid -> error
 * - result_codes.php: 000.100.201 -> error (chargeback)
 * - store.php: created amount storage and idempotency deduplication
 *
 * Prints "N/N passed" and exits 1 on failure, 0 on full success.
 */

declare(strict_types=1);

require_once __DIR__ . '/verify_webhook.php';
require_once __DIR__ . '/result_codes.php';
require_once __DIR__ . '/store.php';

$tests = [];
$passed = 0;
$failed = 0;

/**
 * Registers a test case.
 *
 * @param string $name
 * @param callable $fn
 * @return void
 */
function test(string $name, callable $fn): void {
    global $tests;
    $tests[] = ['name' => $name, 'fn' => $fn];
}

/**
 * Asserts condition is true.
 *
 * @param bool $condition
 * @param string $message
 * @return void
 */
function assert_true(bool $condition, string $message = 'Assertion failed'): void {
    if (!$condition) {
        throw new RuntimeException($message);
    }
}

/**
 * Asserts two values are identical.
 *
 * @param mixed $actual
 * @param mixed $expected
 * @param string $message
 * @return void
 */
function assert_same(mixed $actual, mixed $expected, string $message = ''): void {
    if ($actual !== $expected) {
        $actStr = var_export($actual, true);
        $expStr = var_export($expected, true);
        throw new RuntimeException(($message ? "{$message}: " : '') . "Expected {$expStr}, got {$actStr}");
    }
}

// ── Webhook Scheme A Tests ──

test('verify_webhook: validates a correctly-signed classic sample', function () {
    $secret = 'test_secret_token_xyz789';
    $fields = [
        'amount' => '10.00',
        'authentication.entityId' => 'ENTITY00TEST',
        'currency' => 'ZAR',
        'id' => 'TXN00000000TEST',
        'merchantTransactionId' => 'TX1234567890',
        'paymentType' => 'DB',
        'result.code' => '000.000.000',
    ];

    $pairs = [];
    foreach ($fields as $k => $v) {
        $pairs[] = [$k, $v];
    }
    $message = classic_canonical_message($pairs);
    $sig = hash_hmac('sha256', $message, $secret);

    // Build raw form-urlencoded body
    $urlParams = [];
    foreach ($fields as $k => $v) {
        $urlParams[] = urlencode($k) . '=' . urlencode($v);
    }
    $urlParams[] = 'signature=' . $sig;
    $rawBody = implode('&', $urlParams);

    $res = verify_webhook_signature(
        rawBody: $rawBody,
        secretToken: $secret
    );

    assert_true($res['valid'] === true, 'Signature should be valid');
    assert_same($res['scheme'] ?? null, 'classic-body');
});

test('verify_webhook: REJECTS a tampered classic sample', function () {
    $secret = 'test_secret_token_xyz789';
    $fields = [
        'amount' => '10.00',
        'authentication.entityId' => 'ENTITY00TEST',
        'currency' => 'ZAR',
        'id' => 'TXN00000000TEST',
        'paymentType' => 'DB',
        'result.code' => '000.000.000',
    ];

    $pairs = [];
    foreach ($fields as $k => $v) {
        $pairs[] = [$k, $v];
    }
    $message = classic_canonical_message($pairs);
    $sig = hash_hmac('sha256', $message, $secret);

    // Tamper: alter amount after signing
    $tamperedFields = $fields;
    $tamperedFields['amount'] = '9999.00';

    $urlParams = [];
    foreach ($tamperedFields as $k => $v) {
        $urlParams[] = urlencode($k) . '=' . urlencode($v);
    }
    $urlParams[] = 'signature=' . $sig;
    $rawBody = implode('&', $urlParams);

    $res = verify_webhook_signature(
        rawBody: $rawBody,
        secretToken: $secret
    );

    assert_true($res['valid'] === false, 'Tampered body must fail verification');
    assert_same($res['reason'] ?? null, 'signature_mismatch');
});

test('verify_webhook: REJECTS classic sample signed with wrong secret', function () {
    $fields = ['amount' => '10.00', 'currency' => 'ZAR', 'id' => 'TXN123'];
    $pairs = [];
    foreach ($fields as $k => $v) {
        $pairs[] = [$k, $v];
    }
    $sig = hash_hmac('sha256', classic_canonical_message($pairs), 'wrong_secret');
    $rawBody = "amount=10.00&currency=ZAR&id=TXN123&signature={$sig}";

    $res = verify_webhook_signature(
        rawBody: $rawBody,
        secretToken: 'correct_secret'
    );

    assert_true($res['valid'] === false, 'Wrong secret must fail verification');
    assert_same($res['reason'] ?? null, 'signature_mismatch');
});

// ── Webhook Scheme B Tests ──

test('verify_webhook: header scheme fresh-valid TRUE', function () {
    $webhookSecret = 'whsec_test_secret_header_123';
    $ts = (string)time();
    $webhookId = 'wh_unique_id_456';
    $url = 'http://localhost:8000/webhook.php';
    $rawBody = 'result.code=000.000.000&checkoutId=CHK123&amount=10.00';

    $message = "{$ts}.{$webhookId}.{$url}.{$rawBody}";
    $headerSig = hash_hmac('sha256', $message, $webhookSecret);

    $headers = [
        'x-webhook-signature' => $headerSig,
        'x-webhook-timestamp' => $ts,
        'x-webhook-id' => $webhookId,
    ];

    $res = verify_webhook_signature(
        rawBody: $rawBody,
        headers: $headers,
        webhookSecret: $webhookSecret,
        configuredUrl: $url
    );

    assert_true($res['valid'] === true, 'Fresh header signature should be valid');
    assert_same($res['scheme'] ?? null, 'header-signature');
});

test('verify_webhook: header scheme stale FALSE (> 5 min)', function () {
    $webhookSecret = 'whsec_test_secret_header_123';
    // Stale timestamp: 6 minutes (360 seconds) in the past
    $staleTs = (string)(time() - 360);
    $webhookId = 'wh_stale_id_789';
    $url = 'http://localhost:8000/webhook.php';
    $rawBody = 'result.code=000.000.000&checkoutId=CHK123';

    $message = "{$staleTs}.{$webhookId}.{$url}.{$rawBody}";
    $headerSig = hash_hmac('sha256', $message, $webhookSecret);

    $headers = [
        'x-webhook-signature' => $headerSig,
        'x-webhook-timestamp' => $staleTs,
        'x-webhook-id' => $webhookId,
    ];

    $res = verify_webhook_signature(
        rawBody: $rawBody,
        headers: $headers,
        webhookSecret: $webhookSecret,
        configuredUrl: $url
    );

    assert_true($res['valid'] === false, 'Stale timestamp must fail verification');
    assert_same($res['reason'] ?? null, 'stale_timestamp');
});

test('verify_webhook: no-secret fails closed FALSE', function () {
    $rawBody = 'amount=10.00&signature=deadbeef';
    $res = verify_webhook_signature(
        rawBody: $rawBody,
        headers: [],
        secretToken: null,
        webhookSecret: null
    );

    assert_true($res['valid'] === false, 'Empty secret must fail closed');
    assert_same($res['reason'] ?? null, 'no_secret_configured');
});

test('verify_webhook: missing signature fails closed FALSE', function () {
    $rawBody = 'amount=10.00&currency=ZAR';
    $res = verify_webhook_signature(
        rawBody: $rawBody,
        headers: [],
        secretToken: 'some_secret'
    );

    assert_true($res['valid'] === false, 'Missing signature must fail');
    assert_same($res['reason'] ?? null, 'missing_signature');
});

// ── Result Code Mapper Tests ──

test('result_codes: 000.000.000 -> captured', function () {
    assert_same(map_result_code('000.000.000'), 'captured');
    assert_true(is_success_result_code('000.000.000'));
});

test('result_codes: 000.100.110 -> captured (sandbox mode test code)', function () {
    assert_same(map_result_code('000.100.110'), 'captured');
    assert_true(is_success_result_code('000.100.110'));
});

test('result_codes: 000.400.101 -> error (3DS intermediate, NOT success)', function () {
    assert_same(map_result_code('000.400.101'), 'error');
    assert_true(!is_success_result_code('000.400.101'));
});

test('result_codes: 000.400.102 -> error (user not enrolled, NOT success)', function () {
    assert_same(map_result_code('000.400.102'), 'error');
    assert_true(!is_success_result_code('000.400.102'));
});

test('result_codes: 000.100.201 -> error (chargeback/reversal family)', function () {
    assert_same(map_result_code('000.100.201'), 'error');
    assert_same(map_result_code('000.100.220'), 'error');
    assert_same(map_result_code('000.100.230'), 'error');
    assert_true(!is_success_result_code('000.100.201'));
});

test('result_codes: junk -> error (trailing chars, whitespace, non-digits)', function () {
    assert_same(map_result_code('000.000.000extra'), 'error');
    assert_same(map_result_code(' 000.000.000'), 'error');
    assert_same(map_result_code("000.000.000\n"), 'error');
    assert_same(map_result_code('000.400.0X'), 'error');
    assert_same(map_result_code('junk_value'), 'error');
    assert_same(map_result_code('800.100.150'), 'error');
});

test('result_codes: cancelled, pending, review, and empty mappings', function () {
    assert_same(map_result_code('100.396.101'), 'canceled');
    assert_same(map_result_code('100.396.104'), 'canceled');
    assert_same(map_result_code('000.200.000'), 'pending');
    assert_same(map_result_code('000.200.100'), 'pending');
    assert_same(map_result_code('000.400.100'), 'review');
    assert_same(map_result_code('000.400.000'), 'review');
    assert_same(map_result_code('300.100.100'), 'requires_more');
    assert_same(map_result_code(null), 'pending');
    assert_same(map_result_code(''), 'pending');
});

// ── Store Tests ──

test('store: saves created amount and deduplicates checkouts', function () {
    reset_demo_store();
    $cid = 'CHK_' . bin2hex(random_bytes(8));

    assert_true(get_created_amount($cid) === null, 'Init amount should be null');
    assert_true(!is_checkout_processed($cid), 'Should not be processed initially');

    store_created_amount($cid, '10.00');
    assert_same(get_created_amount($cid), '10.00', 'Stored amount should match');

    mark_checkout_processed($cid);
    assert_true(is_checkout_processed($cid), 'Should be marked as processed');
});

// ── Runner ──

$total = count($tests);
foreach ($tests as $t) {
    $name = $t['name'];
    try {
        ($t['fn'])();
        echo "PASS  {$name}\n";
        $passed++;
    } catch (Throwable $e) {
        echo "FAIL  {$name} — " . $e->getMessage() . "\n";
        $failed++;
    }
}

echo "\n{$passed}/{$total} passed\n";

if ($failed > 0) {
    exit(1);
}
exit(0);
