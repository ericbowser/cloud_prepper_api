@echo off
echo ============================================
echo CloudPrepper API - Docker Deployment
echo ============================================
echo.

cd C:\Projects\cloud_prepper_api

echo Checking .env file...
if not exist .env (
    echo ERROR: .env file not found!
    echo Please create .env file with required variables.
    echo See DOCKER_DEPLOYMENT.md for details.
    pause
    exit /b 1
)

echo.
echo Building and starting Docker containers...
echo This includes:
echo   - CloudPrepper API (port 32638)
echo   - PostgreSQL Database (internal)
echo.

docker-compose up --build -d

if errorlevel 1 (
    echo.
    echo ERROR: Docker deployment failed!
    echo Check the error messages above.
    pause
    exit /b 1
)

echo.
echo ============================================
echo Deployment Successful!
echo ============================================
echo.
echo API Server: http://localhost:32638
echo Swagger Docs: http://localhost:32638/api-docs
echo.
echo Checking container status...
docker-compose ps
echo.
echo To view logs: docker-compose logs -f server
echo To stop: docker-compose down
echo.
pause
