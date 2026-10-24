<?php
/**
 * Upload an orders CSV (and the products CSV) and fill product_id + variant_id
 * from the public Shopify store. Each step does 5 rows, then the page starts
 * the next step by itself.
 *
 * Open: http://localhost/Node-js-CRUD-Generator/fill_shopify_ids.php
 */

declare(strict_types=1);

const DEFAULT_STORE = 'https://nightsuit.pk';
const DEFAULT_BATCH = 5;
const JOB_ROOT = __DIR__ . '/data/shopify_id_jobs';
const EXISTING_ORDERS = __DIR__ . '/data/orders_export_1/orders_export_1.csv';
const EXISTING_PRODUCTS = __DIR__ . '/data/orders_export_1/products_export_1.csv';

function h(string $value): string
{
    return htmlspecialchars($value, ENT_QUOTES, 'UTF-8');
}

function norm(string $value): string
{
    $value = function_exists('mb_strtolower') ? mb_strtolower($value, 'UTF-8') : strtolower($value);
    $value = preg_replace('/\s+/u', ' ', $value) ?? $value;
    return trim($value);
}

function compact_key(string $value): string
{
    return preg_replace('/[^a-z0-9]+/', '', norm($value)) ?? '';
}

function valid_store(string $url): ?string
{
    $url = rtrim(trim($url), '/');
    if (!preg_match('#^https://[a-z0-9.-]+$#i', $url)) {
        return null;
    }
    $host = parse_url($url, PHP_URL_HOST);
    if (!$host || filter_var($host, FILTER_VALIDATE_IP)) {
        return null;
    }
    if (preg_match('/^(localhost|.*\.local)$/i', (string) $host)) {
        return null;
    }
    return $url;
}

function job_id_ok(string $id): bool
{
    return (bool) preg_match('/^[a-f0-9]{16}$/', $id);
}

function job_dir(string $id): string
{
    return JOB_ROOT . '/' . $id;
}

function read_json(string $path): array
{
    if (!is_file($path)) {
        return [];
    }
    $data = json_decode((string) file_get_contents($path), true);
    return is_array($data) ? $data : [];
}

function write_json(string $path, array $data): void
{
    file_put_contents($path, json_encode($data, JSON_UNESCAPED_UNICODE));
}

function http_json(string $url): ?array
{
    $wait = 400000;
    for ($try = 0; $try < 4; $try++) {
        $body = null;
        $code = 0;
        if (function_exists('curl_init')) {
            $ch = curl_init($url);
            curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_FOLLOWLOCATION => true,
                CURLOPT_CONNECTTIMEOUT => 20,
                CURLOPT_TIMEOUT => 30,
                CURLOPT_USERAGENT => 'Mozilla/5.0',
                CURLOPT_HTTPHEADER => ['Accept: application/json'],
            ]);
            $body = curl_exec($ch);
            $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
            curl_close($ch);
            if ($body === false) {
                $body = null;
            }
        } else {
            $context = stream_context_create([
                'http' => [
                    'timeout' => 30,
                    'header' => "User-Agent: Mozilla/5.0\r\nAccept: application/json\r\n",
                    'follow_location' => 1,
                ],
            ]);
            $body = @file_get_contents($url, false, $context);
            if (isset($http_response_header[0]) && preg_match('/\s(\d{3})\s/', $http_response_header[0], $m)) {
                $code = (int) $m[1];
            }
        }
        if ($code === 429) {
            usleep($wait);
            $wait *= 2;
            continue;
        }
        if ($code === 200 && is_string($body) && $body !== '') {
            $json = json_decode($body, true);
            usleep(150000);
            return is_array($json) ? $json : null;
        }
        if ($code === 404) {
            return null;
        }
        usleep($wait);
    }
    return null;
}

function csv_open(string $path)
{
    $fh = fopen($path, 'rb');
    if ($fh === false) {
        throw new RuntimeException('Could not open ' . basename($path));
    }
    return $fh;
}

function csv_row($fh): array|false
{
    $row = fgetcsv($fh, 0, ',', '"', '');
    if ($row === false) {
        return false;
    }
    if (isset($row[0])) {
        $row[0] = preg_replace('/^\xEF\xBB\xBF/', '', (string) $row[0]) ?? (string) $row[0];
    }
    return $row;
}

function column_index(array $header, string $name): int
{
    $index = array_search($name, $header, true);
    return $index === false ? -1 : (int) $index;
}

function remainder_after_title(string $lineName, string $productTitle): ?string
{
    $line = norm($lineName);
    $title = norm($productTitle);
    if ($title === '' || !str_starts_with($line, $title)) {
        return null;
    }
    $rest = trim(substr($line, strlen($title)));
    if ($rest === '') {
        return '';
    }
    if (str_starts_with($rest, '- ')) {
        return trim(substr($rest, 2));
    }
    if (str_starts_with($rest, '| ')) {
        return trim(substr($rest, 2));
    }
    return null;
}

function variant_from_url(string $url): string
{
    if (preg_match('/[?&]variant=(\d+)/', $url, $m)) {
        return $m[1];
    }
    return '';
}

function variant_values(array $variant): array
{
    $values = [];
    foreach (['title', 'option1', 'option2', 'option3'] as $key) {
        if (!isset($variant[$key]) || $variant[$key] === null || $variant[$key] === '') {
            continue;
        }
        $values[] = (string) $variant[$key];
    }
    return $values;
}

function option_fits(array $variant, string $remainder): bool
{
    $rem = compact_key($remainder);
    if ($rem === '') {
        return false;
    }
    foreach (variant_values($variant) as $value) {
        $token = compact_key($value);
        if ($token !== '' && ($rem === $token || str_starts_with($rem, $token) || str_starts_with($token, $rem))) {
            return true;
        }
    }
    return false;
}

function pick_variant(array $product, string $sku, string $remainder, string $hintedId): ?array
{
    $variants = $product['variants'] ?? [];
    if (!is_array($variants)) {
        return null;
    }
    if ($hintedId !== '') {
        foreach ($variants as $variant) {
            if ((string) ($variant['id'] ?? '') === $hintedId && ($sku === '' || (string) ($variant['sku'] ?? '') === $sku)) {
                return $variant;
            }
        }
    }
    if ($sku !== '') {
        $bySku = array_values(array_filter($variants, static fn ($variant) => (string) ($variant['sku'] ?? '') === $sku));
        if (count($bySku) === 1) {
            return $bySku[0];
        }
        if (count($bySku) > 1) {
            $narrowed = array_values(array_filter($bySku, static fn ($variant) => option_fits($variant, $remainder)));
            if (count($narrowed) === 1) {
                return $narrowed[0];
            }
        }
    }
    $byOption = array_values(array_filter($variants, static fn ($variant) => option_fits($variant, $remainder)));
    if (count($byOption) === 1) {
        return $byOption[0];
    }
    return null;
}

function match_product(string $lineName, string $sku, ?array $product, string $hintedId): ?array
{
    if (!$product || !isset($product['title'], $product['id'])) {
        return null;
    }
    $remainder = remainder_after_title($lineName, (string) $product['title']);
    if ($remainder === null) {
        return null;
    }
    $variant = pick_variant($product, $sku, $remainder, $hintedId);
    if (!$variant || !isset($variant['id'])) {
        return null;
    }
    if ($sku !== '' && (string) ($variant['sku'] ?? '') !== $sku) {
        $skuStillThere = false;
        foreach ($product['variants'] ?? [] as $item) {
            if ((string) ($item['sku'] ?? '') === $sku) {
                $skuStillThere = true;
                break;
            }
        }
        if ($skuStillThere || !option_fits($variant, $remainder)) {
            return null;
        }
    }
    return [
        'product_id' => (string) $product['id'],
        'variant_id' => (string) $variant['id'],
        'title' => (string) $product['title'],
        'variant_title' => (string) ($variant['title'] ?? ''),
    ];
}

function search_products(string $store, string $query, string $cacheDir): array
{
    $query = trim($query);
    if ($query === '') {
        return [];
    }
    $file = $cacheDir . '/search_' . md5(norm($query)) . '.json';
    if (is_file($file)) {
        $cached = json_decode((string) file_get_contents($file), true);
        return is_array($cached) ? $cached : [];
    }
    $url = $store . '/search/suggest.json?q=' . rawurlencode($query) . '&resources[type]=product&resources[limit]=10';
    $json = http_json($url);
    if ($json === null) {
        return [];
    }
    $products = $json['resources']['results']['products'] ?? [];
    if (!is_array($products)) {
        $products = [];
    }
    write_json($file, $products);
    return $products;
}

function load_product(string $store, string $handle, string $cacheDir): ?array
{
    $handle = trim($handle);
    if ($handle === '') {
        return null;
    }
    $file = $cacheDir . '/product_' . md5($handle) . '.json';
    if (is_file($file)) {
        $cached = json_decode((string) file_get_contents($file), true);
        if (is_array($cached) && !empty($cached['missing'])) {
            return null;
        }
        return is_array($cached) ? $cached : null;
    }
    $product = http_json($store . '/products/' . rawurlencode($handle) . '.js');
    if (!$product || !isset($product['id'])) {
        write_json($file, ['missing' => true]);
        return null;
    }
    write_json($file, $product);
    return $product;
}

function try_hits(string $lineName, string $sku, array $hits, string $store, string $cacheDir, array &$seen): ?array
{
    $candidates = [];
    foreach ($hits as $hit) {
        $handle = (string) ($hit['handle'] ?? '');
        $title = (string) ($hit['title'] ?? '');
        if ($handle === '' || isset($seen[$handle])) {
            continue;
        }
        if (remainder_after_title($lineName, $title) === null) {
            continue;
        }
        $seen[$handle] = true;
        $candidates[] = $hit;
    }
    usort($candidates, static function ($a, $b) {
        return strlen(norm((string) ($b['title'] ?? ''))) <=> strlen(norm((string) ($a['title'] ?? '')));
    });
    foreach ($candidates as $hit) {
        $matched = match_product(
            $lineName,
            $sku,
            load_product($store, (string) $hit['handle'], $cacheDir),
            variant_from_url((string) ($hit['url'] ?? ''))
        );
        if ($matched) {
            return $matched;
        }
    }
    return null;
}

function resolve_line(string $lineName, string $sku, string $store, string $cacheDir, array $skuIndex): ?array
{
    $seen = [];
    if ($sku !== '') {
        $matched = try_hits($lineName, $sku, search_products($store, $sku, $cacheDir), $store, $cacheDir, $seen);
        if ($matched) {
            return $matched;
        }
    }
    $shortened = $lineName;
    for ($attempt = 0; $attempt < 4; $attempt++) {
        $matched = try_hits($lineName, $sku, search_products($store, $shortened, $cacheDir), $store, $cacheDir, $seen);
        if ($matched) {
            return $matched;
        }
        $cut = strrpos($shortened, ' - ');
        if ($cut === false || $cut <= 0) {
            break;
        }
        $shortened = trim(substr($shortened, 0, $cut));
    }
    $handles = $skuIndex[$sku] ?? [];
    $tried = 0;
    foreach ($handles as $handle) {
        if (isset($seen[$handle])) {
            continue;
        }
        $seen[$handle] = true;
        $tried++;
        if ($tried > 8) {
            break;
        }
        $matched = match_product($lineName, $sku, load_product($store, (string) $handle, $cacheDir), '');
        if ($matched) {
            return $matched;
        }
    }
    return null;
}

function build_sku_index(string $productsPath): array
{
    $fh = csv_open($productsPath);
    $header = csv_row($fh);
    if ($header === false) {
        fclose($fh);
        return [];
    }
    $handleIdx = column_index($header, 'Handle');
    $skuIdx = column_index($header, 'Variant SKU');
    $index = [];
    if ($handleIdx < 0 || $skuIdx < 0) {
        fclose($fh);
        return [];
    }
    while (($row = csv_row($fh)) !== false) {
        $handle = trim((string) ($row[$handleIdx] ?? ''));
        $sku = trim((string) ($row[$skuIdx] ?? ''));
        if ($handle === '' || $sku === '') {
            continue;
        }
        $index[$sku][$handle] = true;
    }
    fclose($fh);
    $out = [];
    foreach ($index as $sku => $handles) {
        $out[$sku] = array_keys($handles);
    }
    return $out;
}

function count_data_rows(string $ordersPath): int
{
    $fh = csv_open($ordersPath);
    $count = 0;
    if (csv_row($fh) === false) {
        fclose($fh);
        return 0;
    }
    while (csv_row($fh) !== false) {
        $count++;
    }
    fclose($fh);
    return $count;
}

function create_job(string $ordersSource, string $productsSource, string $store, int $batch): string
{
    if (!is_dir(JOB_ROOT) && !mkdir(JOB_ROOT, 0775, true) && !is_dir(JOB_ROOT)) {
        throw new RuntimeException('Could not create the jobs folder.');
    }
    $id = bin2hex(random_bytes(8));
    $dir = job_dir($id);
    if (!mkdir($dir, 0775, true) && !is_dir($dir)) {
        throw new RuntimeException('Could not create the job folder.');
    }
    mkdir($dir . '/cache', 0775, true);
    if (!@copy($ordersSource, $dir . '/orders.csv')) {
        throw new RuntimeException('Could not read the orders file. Close it in Excel and try again.');
    }
    $hasProducts = $productsSource !== '' && is_file($productsSource);
    if ($hasProducts && !@copy($productsSource, $dir . '/products.csv')) {
        throw new RuntimeException('Could not read the products file. Close it in Excel and try again.');
    }
    $ordersReal = realpath($ordersSource) ?: '';
    $existingReal = realpath(EXISTING_ORDERS) ?: '';
    write_json($dir . '/state.json', [
        'phase' => $hasProducts ? 'prepare' : 'run',
        'store' => $store,
        'batch' => $batch,
        'pos' => 0,
        'header_done' => false,
        'columns_added' => false,
        'rows_done' => 0,
        'rows_total' => 0,
        'filled' => 0,
        'blank' => 0,
        'already' => 0,
        'has_products' => $hasProducts,
        'publish_to' => ($ordersReal !== '' && $ordersReal === $existingReal) ? EXISTING_ORDERS : '',
        'last_batch' => [],
        'error' => '',
    ]);
    return $id;
}

function prepare_job(string $dir): array
{
    $state = read_json($dir . '/state.json');
    @set_time_limit(0);
    if (!empty($state['has_products']) && is_file($dir . '/products.csv') && !is_file($dir . '/sku_index.json')) {
        write_json($dir . '/sku_index.json', build_sku_index($dir . '/products.csv'));
    }
    if (empty($state['rows_total'])) {
        $state['rows_total'] = count_data_rows($dir . '/orders.csv');
    }
    $state['phase'] = 'run';
    $state['error'] = '';
    write_json($dir . '/state.json', $state);
    return $state;
}

function process_batch(string $dir): array
{
    $state = read_json($dir . '/state.json');
    if (($state['phase'] ?? '') === 'prepare') {
        return prepare_job($dir);
    }
    if (!empty($state['done'])) {
        $state['phase'] = 'done';
        return $state;
    }
    @set_time_limit(180);
    $batch = max(1, (int) ($state['batch'] ?? DEFAULT_BATCH));
    $store = (string) ($state['store'] ?? DEFAULT_STORE);
    $skuIndex = read_json($dir . '/sku_index.json');
    $cacheDir = $dir . '/cache';
    $in = csv_open($dir . '/orders.csv');
    $outMode = !empty($state['header_done']) ? 'ab' : 'wb';
    $out = fopen($dir . '/output.csv', $outMode);
    if ($out === false) {
        fclose($in);
        throw new RuntimeException('Could not write the output file.');
    }
    if (!empty($state['pos'])) {
        fseek($in, (int) $state['pos']);
    }

    $nameIdx = (int) ($state['name_idx'] ?? -1);
    $skuIdx = (int) ($state['sku_idx'] ?? -1);
    $productIdx = (int) ($state['product_idx'] ?? -1);
    $variantIdx = (int) ($state['variant_idx'] ?? -1);

    if (empty($state['header_done'])) {
        $header = csv_row($in);
        if ($header === false) {
            throw new RuntimeException('The orders file has no header.');
        }
        $nameIdx = column_index($header, 'Lineitem name');
        $skuIdx = column_index($header, 'Lineitem sku');
        if ($nameIdx < 0 || $skuIdx < 0) {
            throw new RuntimeException('The orders file needs Lineitem name and Lineitem sku columns.');
        }
        $productIdx = column_index($header, 'product_id');
        $variantIdx = column_index($header, 'variant_id');
        if ($productIdx < 0 || $variantIdx < 0) {
            $header[] = 'product_id';
            $header[] = 'variant_id';
            $productIdx = count($header) - 2;
            $variantIdx = count($header) - 1;
            $state['columns_added'] = true;
        }
        fputcsv($out, $header, ',', '"', '');
        $state['header_done'] = true;
        $state['name_idx'] = $nameIdx;
        $state['sku_idx'] = $skuIdx;
        $state['product_idx'] = $productIdx;
        $state['variant_idx'] = $variantIdx;
    }

    $last = [];
    $processed = 0;
    $finished = false;
    while ($processed < $batch) {
        $row = csv_row($in);
        if ($row === false) {
            $finished = true;
            break;
        }
        $width = max(count($row), $variantIdx + 1, $productIdx + 1);
        $row = array_pad($row, $width, '');
        $lineName = trim((string) ($row[$nameIdx] ?? ''));
        $sku = trim((string) ($row[$skuIdx] ?? ''));
        $productId = trim((string) ($row[$productIdx] ?? ''));
        $variantId = trim((string) ($row[$variantIdx] ?? ''));
        $status = 'blank';
        if ($productId !== '' && $variantId !== '') {
            $state['already'] = (int) ($state['already'] ?? 0) + 1;
            $status = 'already';
        } elseif ($lineName === '') {
            $state['blank'] = (int) ($state['blank'] ?? 0) + 1;
        } else {
            $matched = resolve_line($lineName, $sku, $store, $cacheDir, $skuIndex);
            if ($matched) {
                $row[$productIdx] = $matched['product_id'];
                $row[$variantIdx] = $matched['variant_id'];
                $state['filled'] = (int) ($state['filled'] ?? 0) + 1;
                $status = 'filled';
                $productId = $matched['product_id'];
                $variantId = $matched['variant_id'];
            } else {
                $state['blank'] = (int) ($state['blank'] ?? 0) + 1;
            }
        }
        fputcsv($out, $row, ',', '"', '');
        $processed++;
        $state['rows_done'] = (int) ($state['rows_done'] ?? 0) + 1;
        $last[] = [
            'row' => $state['rows_done'],
            'name' => $lineName,
            'sku' => $sku,
            'product_id' => trim((string) ($row[$productIdx] ?? '')),
            'variant_id' => trim((string) ($row[$variantIdx] ?? '')),
            'status' => $status,
        ];
    }
    $state['pos'] = ftell($in);
    $state['last_batch'] = $last;
    $state['phase'] = $finished ? 'done' : 'run';
    $state['done'] = $finished;
    $state['error'] = '';
    fclose($in);
    fclose($out);
    write_json($dir . '/state.json', $state);
    publish_orders($dir, $state);
    return $state;
}

function publish_orders(string $dir, array $state): void
{
    $target = (string) ($state['publish_to'] ?? '');
    if ($target === '' || !is_file($dir . '/output.csv')) {
        return;
    }
    $tmp = $dir . '/publish.tmp';
    $out = fopen($tmp, 'wb');
    if ($out === false) {
        throw new RuntimeException('Could not prepare the orders update.');
    }
    $processed = fopen($dir . '/output.csv', 'rb');
    if ($processed === false) {
        fclose($out);
        throw new RuntimeException('Could not read the finished rows.');
    }
    stream_copy_to_stream($processed, $out);
    fclose($processed);
    if (empty($state['done'])) {
        $pos = (int) ($state['pos'] ?? 0);
        if (!empty($state['columns_added'])) {
            $in = csv_open($dir . '/orders.csv');
            fseek($in, $pos);
            while (($row = csv_row($in)) !== false) {
                $row[] = '';
                $row[] = '';
                fputcsv($out, $row, ',', '"', '');
            }
            fclose($in);
        } else {
            $in = fopen($dir . '/orders.csv', 'rb');
            if ($in === false) {
                fclose($out);
                throw new RuntimeException('Could not read the rest of the orders file.');
            }
            fseek($in, $pos);
            stream_copy_to_stream($in, $out);
            fclose($in);
        }
    }
    fclose($out);
    if (!@copy($tmp, $target)) {
        @unlink($tmp);
        throw new RuntimeException('Could not update data/orders_export_1/orders_export_1.csv. Close it in Excel and refresh this page.');
    }
    @unlink($tmp);
}

function public_state(array $state): array
{
    return [
        'phase' => $state['phase'] ?? 'run',
        'done' => !empty($state['done']) || ($state['phase'] ?? '') === 'done',
        'rows_done' => (int) ($state['rows_done'] ?? 0),
        'rows_total' => (int) ($state['rows_total'] ?? 0),
        'filled' => (int) ($state['filled'] ?? 0),
        'blank' => (int) ($state['blank'] ?? 0),
        'already' => (int) ($state['already'] ?? 0),
        'batch' => (int) ($state['batch'] ?? DEFAULT_BATCH),
        'last_batch' => $state['last_batch'] ?? [],
        'error' => (string) ($state['error'] ?? ''),
    ];
}

function lock_job(string $dir)
{
    $fh = fopen($dir . '/lock', 'c');
    if ($fh === false || !flock($fh, LOCK_EX | LOCK_NB)) {
        if (is_resource($fh)) {
            fclose($fh);
        }
        return null;
    }
    return $fh;
}

function uploaded_path(string $field): string
{
    if (empty($_FILES[$field]['tmp_name']) || !is_uploaded_file($_FILES[$field]['tmp_name'])) {
        return '';
    }
    $name = (string) ($_FILES[$field]['name'] ?? '');
    if (!preg_match('/\.csv$/i', $name)) {
        throw new RuntimeException($name . ' is not a CSV file.');
    }
    if (!empty($_FILES[$field]['error']) && (int) $_FILES[$field]['error'] !== UPLOAD_ERR_OK) {
        throw new RuntimeException('Upload failed for ' . $name . '. The file may be larger than PHP allows (' . ini_get('upload_max_filesize') . ').');
    }
    return (string) $_FILES[$field]['tmp_name'];
}

function lookup_ids(string $name, string $sku, string $store): array
{
    $cacheDir = JOB_ROOT . '/lookup_cache';
    if (!is_dir($cacheDir) && !mkdir($cacheDir, 0775, true) && !is_dir($cacheDir)) {
        throw new RuntimeException('Could not create the lookup cache.');
    }
    $matched = resolve_line($name, $sku, $store, $cacheDir, []);
    if (!$matched) {
        return [
            'found' => false,
            'name' => $name,
            'sku' => $sku,
            'product_id' => '',
            'variant_id' => '',
        ];
    }
    return [
        'found' => true,
        'name' => $name,
        'sku' => $sku,
        'product_id' => $matched['product_id'],
        'variant_id' => $matched['variant_id'],
        'title' => $matched['title'],
        'variant_title' => $matched['variant_title'],
    ];
}

function handle_request(): void
{
    $action = (string) ($_GET['action'] ?? $_POST['action'] ?? '');
    $job = (string) ($_GET['job'] ?? $_POST['job'] ?? '');

    if ($action === 'lookup') {
        header('Content-Type: application/json');
        $body = [];
        $raw = file_get_contents('php://input');
        if (is_string($raw) && $raw !== '') {
            $decoded = json_decode($raw, true);
            if (is_array($decoded)) {
                $body = $decoded;
            }
        }
        $name = trim((string) ($body['name'] ?? $_GET['name'] ?? $_POST['name'] ?? ''));
        $sku = trim((string) ($body['sku'] ?? $_GET['sku'] ?? $_POST['sku'] ?? ''));
        $store = valid_store((string) ($body['store'] ?? $_GET['store'] ?? $_POST['store'] ?? DEFAULT_STORE));
        if ($name === '') {
            http_response_code(400);
            echo json_encode(['found' => false, 'error' => 'Pass name, for example Women Chocolate Brown Long Fleece Winter Coat - xl']);
            return;
        }
        if ($store === null) {
            http_response_code(400);
            echo json_encode(['found' => false, 'error' => 'Store must look like https://nightsuit.pk']);
            return;
        }
        try {
            $result = lookup_ids($name, $sku, $store);
            if (!$result['found']) {
                http_response_code(404);
            }
            echo json_encode($result, JSON_UNESCAPED_UNICODE);
        } catch (Throwable $e) {
            http_response_code(500);
            echo json_encode(['found' => false, 'error' => $e->getMessage()]);
        }
        return;
    }

    if ($action === 'step' || $action === 'status' || $action === 'download') {
        if (!job_id_ok($job) || !is_file(job_dir($job) . '/state.json')) {
            http_response_code(404);
            header('Content-Type: application/json');
            echo json_encode(['error' => 'That job was not found.']);
            return;
        }
        $dir = job_dir($job);
        if ($action === 'download') {
            $file = $dir . '/output.csv';
            if (!is_file($file)) {
                http_response_code(404);
                echo 'Nothing to download yet.';
                return;
            }
            header('Content-Type: text/csv');
            header('Content-Disposition: attachment; filename="orders_with_ids.csv"');
            header('Content-Length: ' . (string) filesize($file));
            readfile($file);
            return;
        }
        if ($action === 'status') {
            header('Content-Type: application/json');
            echo json_encode(public_state(read_json($dir . '/state.json')));
            return;
        }
        header('Content-Type: application/json');
        $lock = lock_job($dir);
        if ($lock === null) {
            echo json_encode(['busy' => true] + public_state(read_json($dir . '/state.json')));
            return;
        }
        try {
            $state = process_batch($dir);
            echo json_encode(['busy' => false] + public_state($state));
        } catch (Throwable $e) {
            $state = read_json($dir . '/state.json');
            $state['error'] = $e->getMessage();
            write_json($dir . '/state.json', $state);
            http_response_code(500);
            echo json_encode(['busy' => false, 'error' => $e->getMessage()] + public_state($state));
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
        return;
    }

    if ($action === 'start' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        header('Content-Type: application/json');
        try {
            $store = valid_store((string) ($_POST['store'] ?? DEFAULT_STORE));
            if ($store === null) {
                throw new RuntimeException('Enter the store as https://your-store.com');
            }
            $batch = (int) ($_POST['batch'] ?? DEFAULT_BATCH);
            if (!in_array($batch, [5, 20], true)) {
                $batch = DEFAULT_BATCH;
            }
            $ordersUpload = uploaded_path('orders');
            $productsUpload = uploaded_path('products');
            $orders = $ordersUpload !== '' ? $ordersUpload : EXISTING_ORDERS;
            $products = $productsUpload !== '' ? $productsUpload : EXISTING_PRODUCTS;
            if (!is_file($orders)) {
                throw new RuntimeException('Orders file was not found: data/orders_export_1/orders_export_1.csv');
            }
            if (!is_file($products)) {
                throw new RuntimeException('Products file was not found: data/orders_export_1/products_export_1.csv');
            }
            $id = create_job($orders, $products, $store, $batch);
            echo json_encode(['job' => $id]);
        } catch (Throwable $e) {
            http_response_code(400);
            echo json_encode(['error' => $e->getMessage()]);
        }
        return;
    }

    if ($job !== '' && job_id_ok($job) && is_file(job_dir($job) . '/state.json')) {
        render_run($job);
        return;
    }
    render_form();
}

function render_form(): void
{
    $ordersReady = is_file(EXISTING_ORDERS);
    $productsReady = is_file(EXISTING_PRODUCTS);
    $ordersSize = $ordersReady ? (int) filesize(EXISTING_ORDERS) : 0;
    $productsSize = $productsReady ? (int) filesize(EXISTING_PRODUCTS) : 0;
    ?>
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Add Shopify ids</title>
  <style>
    body { font-family: Georgia, serif; margin: 40px auto; max-width: 760px; color: #1c1915; background: #f6f3ec; }
    h1 { font-size: 28px; font-weight: normal; margin-bottom: 8px; }
    p, li { line-height: 1.45; }
    form { background: #fff; border: 1px solid #ddd4c4; padding: 20px; }
    label { display: block; margin: 14px 0 6px; }
    input[type="text"], input[type="file"] { width: 100%; box-sizing: border-box; }
    button { margin-top: 18px; background: #1c1915; color: #fff; border: 0; padding: 10px 16px; cursor: pointer; }
    .note { color: #5c564c; font-size: 14px; }
    .choice { margin: 6px 0; }
    #message { min-height: 1.2em; }
  </style>
</head>
<body>
  <h1>Add product and variant ids</h1>
  <p>These two files are already selected. Each step looks up <strong>5 order rows</strong>, then writes those ids into <code>orders_export_1.csv</code> and starts the next 5.</p>
  <ul>
    <li>Orders: <code>data/orders_export_1/orders_export_1.csv</code><?php if ($ordersReady): ?> (<?= h(number_format($ordersSize / 1048576, 1)) ?> MB)<?php else: ?> — file is missing<?php endif; ?></li>
    <li>Products: <code>data/orders_export_1/products_export_1.csv</code><?php if ($productsReady): ?> (<?= h(number_format($productsSize / 1048576, 1)) ?> MB)<?php else: ?> — file is missing<?php endif; ?></li>
  </ul>
  <p class="note">Five rows is the step size. Twenty rows in one step is more likely to stop when Shopify or PHP runs out of time. The whole file still gets done, one step after another.</p>
  <form id="start" enctype="multipart/form-data">
    <input type="hidden" name="action" value="start">
    <label>Store</label>
    <input type="text" name="store" value="<?= h(DEFAULT_STORE) ?>">
    <label>Different orders CSV <span class="note">(optional)</span></label>
    <input type="file" name="orders" accept=".csv,text/csv">
    <label>Different products CSV <span class="note">(optional)</span></label>
    <input type="file" name="products" accept=".csv,text/csv">
    <label>Rows per step</label>
    <label class="choice"><input type="radio" name="batch" value="5" checked> 5 rows, then continue (recommended)</label>
    <label class="choice"><input type="radio" name="batch" value="20"> 20 rows, then continue</label>
    <p class="note">Leave both file fields empty to use the two files above. PHP upload limit is <?= h((string) ini_get('upload_max_filesize')) ?> per file.</p>
    <button type="submit">Start</button>
    <p id="message"></p>
  </form>
  <script>
    document.getElementById('start').addEventListener('submit', async (event) => {
      event.preventDefault();
      const message = document.getElementById('message');
      const button = event.target.querySelector('button');
      button.disabled = true;
      message.textContent = 'Using the two CSV files. The next page reads the product export, then starts the order rows.';
      try {
        const response = await fetch('fill_shopify_ids.php?action=start', { method: 'POST', body: new FormData(event.target) });
        const data = await response.json();
        if (!response.ok || data.error) throw new Error(data.error || 'Could not start');
        location.href = 'fill_shopify_ids.php?job=' + encodeURIComponent(data.job);
      } catch (error) {
        message.textContent = error.message;
        button.disabled = false;
      }
    });
  </script>
</body>
</html>
    <?php
}

function render_run(string $job): void
{
    $state = public_state(read_json(job_dir($job) . '/state.json'));
    ?>
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Filling Shopify ids</title>
  <style>
    body { font-family: Georgia, serif; margin: 40px auto; max-width: 860px; color: #1c1915; background: #f6f3ec; }
    h1 { font-size: 28px; font-weight: normal; }
    .bar { height: 14px; background: #e4dccb; margin: 12px 0; }
    .bar span { display: block; height: 100%; background: #2f6f4e; width: 0; }
    table { width: 100%; border-collapse: collapse; background: #fff; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eee; font-size: 14px; vertical-align: top; }
    a.button, button { display: inline-block; margin-right: 8px; background: #1c1915; color: #fff; text-decoration: none; border: 0; padding: 8px 12px; cursor: pointer; }
    .note { color: #5c564c; }
  </style>
</head>
<body>
  <h1>Filling ids</h1>
  <p id="status">Starting.</p>
  <div class="bar"><span id="meter"></span></div>
  <p class="note" id="counts"></p>
  <p>
    <button id="stop" type="button">Stop after this step</button>
    <a class="button" id="download" href="fill_shopify_ids.php?job=<?= h($job) ?>&action=download">Download CSV</a>
  </p>
  <table>
    <thead><tr><th>Row</th><th>Line</th><th>product_id</th><th>variant_id</th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
  <script>
    const job = <?= json_encode($job) ?>;
    const batch = <?= (int) $state['batch'] ?>;
    let stop = false;
    document.getElementById('stop').addEventListener('click', () => {
      stop = true;
      document.getElementById('stop').disabled = true;
    });
    function paint(data) {
      const total = data.rows_total || 0;
      const done = data.rows_done || 0;
      const pct = total ? Math.min(100, Math.round(done / total * 100)) : 0;
      document.getElementById('meter').style.width = pct + '%';
      let status = 'Step of ' + batch + ' rows.';
      if (data.phase === 'prepare') status = 'Reading the product file.';
      if (data.done) status = 'Finished.';
      if (data.busy) status = 'This step is still running.';
      if (data.error) status = data.error;
      if (stop && !data.done) status = 'Stopped. orders_export_1.csv has the finished rows. Refresh this page to continue at the next row.';
      document.getElementById('status').textContent = status + ' ' + done + (total ? ' / ' + total : '') + ' rows.';
      document.getElementById('counts').textContent = 'Filled ' + (data.filled || 0) + '. Left blank ' + (data.blank || 0) + '. Already had both ids ' + (data.already || 0) + '.';
      const body = document.getElementById('rows');
      body.innerHTML = '';
      (data.last_batch || []).forEach((item) => {
        const tr = document.createElement('tr');
        [item.row, item.name || '', item.product_id || '', item.variant_id || ''].forEach((value) => {
          const td = document.createElement('td');
          td.textContent = value;
          tr.appendChild(td);
        });
        body.appendChild(tr);
      });
    }
    async function loop() {
      while (!stop) {
        let response;
        try {
          response = await fetch('fill_shopify_ids.php?job=' + encodeURIComponent(job) + '&action=step');
        } catch (error) {
          document.getElementById('status').textContent = 'The step did not answer. Retrying.';
          await new Promise((resolve) => setTimeout(resolve, 2000));
          continue;
        }
        const data = await response.json();
        paint(data);
        if (data.error) return;
        if (data.done) return;
        if (data.busy) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          continue;
        }
      }
    }
    loop();
  </script>
</body>
</html>
    <?php
}

if (PHP_SAPI !== 'cli') {
    handle_request();
}
