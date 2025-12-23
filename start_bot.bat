@echo off
chcp 65001 >nul
echo ========================================
echo Запуск Wildberries Parser Bot
echo ========================================
echo.

REM Переходим в директорию скрипта
cd /d "%~dp0"

REM Проверяем наличие node_modules
if not exist "node_modules" (
    echo [ОШИБКА] Зависимости не установлены!
    echo Пожалуйста, запустите install.bat для установки зависимостей
    echo.
    pause
    exit /b 1
)

REM Проверяем наличие .env файла
if not exist ".env" (
    echo [ПРЕДУПРЕЖДЕНИЕ] Файл .env не найден!
    echo Убедитесь, что файл .env существует и содержит необходимые переменные окружения
    echo.
)

echo [INFO] Запуск бота...
echo.

node index.js

if %errorlevel% neq 0 (
    echo.
    echo [ОШИБКА] Бот завершился с ошибкой
    pause
    exit /b 1
)
