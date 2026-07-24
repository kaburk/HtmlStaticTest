<?php
// SECURITYFIX-162 パストラバーサル検証（webroot 配下に置きブラウザで開く／使用後は手動で削除）
//   例: http://<対象サイト>/files/seccheck162.php
// 全て SAFE ならパッチ適用済み。VULNERABLE があれば未適用。
header('Content-Type: text/plain; charset=UTF-8');

// アプリルートを自動探索（配置場所・パスに依存しない）
$dir = __DIR__;
while (!is_file($dir . '/vendor/autoload.php')) {
    if (dirname($dir) === $dir) { exit("vendor/autoload.php が見つかりません\n"); }
    $dir = dirname($dir);
}
require $dir . '/vendor/autoload.php';
require $dir . '/config/bootstrap.php';

use Laminas\Diactoros\Stream;
use Laminas\Diactoros\UploadedFile;

foreach (['plugins', 'themes', 'restore_db'] as $target) {
    $field   = ($target === 'restore_db') ? 'backup' : 'file';
    $prefix  = ($target === 'restore_db') ? '../../webroot/' : '../webroot/'; // 基準 tmp/ または tmp/schema/
    $marker  = "bcseccheck162_{$target}.txt";
    $escaped = ROOT . DS . 'webroot' . DS . $marker;
    @unlink($escaped);

    // $_FILES ガード通過用のダミー ＋ ストリーム生成の UploadedFile（web SAPI でも書き込み経路を通す）
    $_FILES[$field] = ['tmp_name' => 'dummy', 'name' => $marker, 'error' => 0, 'size' => 1, 'type' => 'application/zip'];
    $stream = new Stream('php://temp', 'wb+');
    // 書き込まれるダミーファイルの中身（無害な証跡マーカー。実行可能コードは含めない）
    $body = "bcseccheck162 PoC marker ({$target})\n"
        . "SECURITYFIX-162 (GHSA-h26f-xjhf-995v) のパストラバーサルにより webroot 直下へ書き込まれた無害な証跡ファイルです。\n"
        . "パッチ未適用のため任意ファイル書き込みが成立しています。確認後は手動で削除してください。\n";
    $stream->write($body);
    $up = new UploadedFile($stream, strlen($body), UPLOAD_ERR_OK, $prefix . $marker, 'application/zip'); // clientFilename に ../ を仕込む

    try {
        match ($target) {
            'plugins'    => (new \BaserCore\Service\PluginsService())->add([$field => $up]),
            'themes'     => (new \BaserCore\Service\ThemesService())->add([$field => $up]),
            'restore_db' => (new \BaserCore\Service\UtilitiesService())->restoreDb([], [$field => $up]),
        };
    } catch (\Throwable $e) { /* ZIP 展開失敗は想定内（書き込みは展開の前） */ }

    if (file_exists($escaped)) {
        // 未適用: 突いて書き込んだダミーファイルを証跡として残す（削除しない）
        printf("%-11s : NG (未適用) — 証跡ダミーファイルを生成: %s\n", $target, $escaped);
    } else {
        printf("%-11s : OK (適用済み)\n", $target);
    }
}

echo "\n※ NG のターゲットは webroot 直下に証跡ダミーファイル（bcseccheck162_*.txt）が残ります。確認後は手動で削除してください。\n";
echo "※ 本スクリプト（seccheck162.php）自体も使用後に必ず削除してください。\n";
