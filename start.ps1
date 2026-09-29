# Tune drop Windows 起動ラッパー (PowerShell 用)
# 使い方:
#   .\start.ps1           起動
#   .\start.ps1 --setup   初回セットアップ
# 実行ポリシーで止まる場合は:
#   powershell -ExecutionPolicy Bypass -File .\start.ps1
# 実処理は start.py。ここでは Python 3 を見つけて呼び出すだけ。
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

$venv = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (Test-Path -LiteralPath $venv) {
    & $venv 'start.py' @args
    exit $LASTEXITCODE
}
if (Get-Command py -ErrorAction SilentlyContinue) {
    & py -3 'start.py' @args
    exit $LASTEXITCODE
}
if (Get-Command python -ErrorAction SilentlyContinue) {
    & python 'start.py' @args
    exit $LASTEXITCODE
}
Write-Error 'Python 3 が見つかりません。https://www.python.org/downloads/ からインストールしてください。'
exit 1
