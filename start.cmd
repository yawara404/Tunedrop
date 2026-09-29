@echo off
rem Tune drop Windows 起動ラッパー (ダブルクリック / cmd から実行)
rem 実処理は start.py。ここでは Python 3 を見つけて呼び出すだけ。
setlocal
cd /d "%~dp0"

if exist ".venv\Scripts\python.exe" (
    ".venv\Scripts\python.exe" "start.py" %*
    goto :finish
)

where py >nul 2>nul
if %errorlevel%==0 (
    py -3 "start.py" %*
    goto :finish
)

where python >nul 2>nul
if %errorlevel%==0 (
    python "start.py" %*
    goto :finish
)

echo.
echo Python 3 が見つかりません。
echo https://www.python.org/downloads/ からインストールし、PATH に追加してください。
echo.

:finish
if "%ERRORLEVEL%"=="0" goto :eof
echo.
echo 終了コード: %ERRORLEVEL%
pause
