@echo off
echo ============================================
echo CloudPrepper API - Stop Docker Containers
echo ============================================
echo.

cd C:\Projects\cloud_prepper_api

echo Stopping and removing containers...
docker-compose down

echo.
echo Containers stopped successfully.
echo.
echo To remove all data (including database):
echo   docker-compose down -v
echo.
pause
