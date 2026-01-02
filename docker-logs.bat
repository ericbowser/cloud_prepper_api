@echo off
echo ============================================
echo CloudPrepper API - View Docker Logs
echo ============================================
echo.

cd C:\Projects\cloud_prepper_api

echo Streaming API server logs...
echo Press Ctrl+C to stop viewing logs
echo.

docker-compose logs -f server
