<?php
/**
 * Shared in-memory / file demo store for idempotency deduplication and per-checkout created amounts.
 *
 * PRODUCTION NOTE:
 * This is a DEMO file store. Replace it with a DURABLE ACID database (e.g. MySQL, PostgreSQL) in
 * production. Peach Payments retries webhooks for up to 30 days, and server restarts or multiple
 * PHP-FPM worker processes must never allow double-fulfillment. Store the created amount in your DB
 * keyed by checkoutId and read it back inside a database transaction during payment confirmation.
 *
 * DEDUPE ATOMICITY: use claim_checkout() for the fulfilment gate — it holds LOCK_EX across the
 * read-check-set-write, so under concurrent workers exactly ONE caller wins. Calling
 * is_checkout_processed() and then mark_checkout_processed() as two separate steps is NOT atomic
 * (two workers can both pass the check and both fulfil); those two are only a read/write used for
 * the cheap fast-path short-circuit and for tests, never as the concurrency guard.
 */

declare(strict_types=1);

/**
 * Returns the path to the temporary JSON store file.
 *
 * @return string
 */
function _store_file_path(): string {
    return sys_get_temp_dir() . '/peach_checkout_demo_store.json';
}

/**
 * Reads the current store contents.
 *
 * @return array{created_amounts: array<string, string>, processed_checkouts: array<string, bool>}
 */
function _read_store(): array {
    $filePath = _store_file_path();
    if (!file_exists($filePath)) {
        return [
            'created_amounts' => [],
            'processed_checkouts' => [],
        ];
    }

    $content = @file_get_contents($filePath);
    if ($content === false || $content === '') {
        return [
            'created_amounts' => [],
            'processed_checkouts' => [],
        ];
    }

    $data = json_decode($content, true);
    if (!is_array($data)) {
        return [
            'created_amounts' => [],
            'processed_checkouts' => [],
        ];
    }

    return [
        'created_amounts' => is_array($data['created_amounts'] ?? null) ? $data['created_amounts'] : [],
        'processed_checkouts' => is_array($data['processed_checkouts'] ?? null) ? $data['processed_checkouts'] : [],
    ];
}

/**
 * Writes data to the store file using exclusive file locking.
 *
 * @param array{created_amounts: array<string, string>, processed_checkouts: array<string, bool>} $data
 * @return void
 */
function _write_store(array $data): void {
    $filePath = _store_file_path();
    $fp = fopen($filePath, 'c+');
    if ($fp === false) {
        return;
    }

    if (flock($fp, LOCK_EX)) {
        ftruncate($fp, 0);
        rewind($fp);
        fwrite($fp, (string)json_encode($data, JSON_PRETTY_PRINT));
        fflush($fp);
        flock($fp, LOCK_UN);
    }
    fclose($fp);
}

/**
 * Stores the expected major-unit decimal amount created for a given checkoutId.
 *
 * @param string $checkoutId
 * @param string $amount e.g. "10.00"
 * @return void
 */
function store_created_amount(string $checkoutId, string $amount): void {
    $data = _read_store();
    $data['created_amounts'][$checkoutId] = $amount;
    _write_store($data);
}

/**
 * Retrieves the stored created amount for a given checkoutId.
 *
 * @param string $checkoutId
 * @return string|null
 */
function get_created_amount(string $checkoutId): ?string {
    $data = _read_store();
    return $data['created_amounts'][$checkoutId] ?? null;
}

/**
 * Checks whether a given checkoutId has already been fulfilled/processed.
 *
 * @param string $checkoutId
 * @return bool
 */
function is_checkout_processed(string $checkoutId): bool {
    $data = _read_store();
    return !empty($data['processed_checkouts'][$checkoutId]);
}

/**
 * Marks a checkoutId as fulfilled/processed to prevent duplicate fulfillment.
 *
 * @param string $checkoutId
 * @return void
 */
function mark_checkout_processed(string $checkoutId): void {
    $data = _read_store();
    $data['processed_checkouts'][$checkoutId] = true;
    _write_store($data);
}

/**
 * ATOMICALLY claim a checkoutId for fulfilment. Holds LOCK_EX across the read-check-set-write, so
 * under concurrent PHP-FPM workers exactly ONE caller gets true. Returns true if THIS call claimed
 * it (the caller should fulfil), false if it was already claimed (the caller must NOT fulfil). This
 * is the real dedupe primitive — fails closed (returns false) if the store can't be opened/locked.
 *
 * @param string $checkoutId
 * @return bool
 */
function claim_checkout(string $checkoutId): bool {
    $filePath = _store_file_path();
    $fp = fopen($filePath, 'c+');
    if ($fp === false) {
        return false; // fail closed: cannot lock => do not fulfil
    }

    $claimed = false;
    if (flock($fp, LOCK_EX)) {
        $content = stream_get_contents($fp);
        $data = json_decode($content !== false ? $content : '', true);
        if (!is_array($data)) {
            $data = ['created_amounts' => [], 'processed_checkouts' => []];
        }
        if (!is_array($data['created_amounts'] ?? null)) {
            $data['created_amounts'] = [];
        }
        if (!is_array($data['processed_checkouts'] ?? null)) {
            $data['processed_checkouts'] = [];
        }
        if (empty($data['processed_checkouts'][$checkoutId])) {
            $data['processed_checkouts'][$checkoutId] = true;
            ftruncate($fp, 0);
            rewind($fp);
            fwrite($fp, (string)json_encode($data, JSON_PRETTY_PRINT));
            fflush($fp);
            $claimed = true;
        }
        flock($fp, LOCK_UN);
    }
    fclose($fp);
    return $claimed;
}

/**
 * Clears demo store data (used for self-tests and local resets).
 *
 * @return void
 */
function reset_demo_store(): void {
    _write_store([
        'created_amounts' => [],
        'processed_checkouts' => [],
    ]);
}
