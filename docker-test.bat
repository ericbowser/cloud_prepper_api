@echo off
echo ============================================
echo CloudPrepper API - Test Docker Deployment
echo ============================================
echo.

cd C:\Projects\cloud_prepper_api

echo Step 1: Creating test user...
curl -X POST http://localhost:32638/auth/register ^
  -H "Content-Type: application/json" ^
  -d "{\"username\":\"docker-test\",\"email\":\"docker-test@example.com\",\"password\":\"Test123!\"}" ^
  2>nul

echo.
echo Step 2: Logging in to get JWT token...
curl -X POST http://localhost:32638/auth/login ^
  -H "Content-Type: application/json" ^
  -d "{\"username\":\"docker-test\",\"password\":\"Test123!\"}" ^
  -o docker-login-response.json ^
  2>nul

echo.
echo Step 3: Extracting token...
for /f "tokens=2 delims=:," %%a in ('type docker-login-response.json ^| findstr "token"') do (
    set TOKEN=%%a
)
set TOKEN=%TOKEN:"=%
set TOKEN=%TOKEN: =%

echo Token received: %TOKEN:~0,20%...
echo.

echo Step 4: Testing question generation endpoint...
echo (Generating 1 question via Claude AI - this takes 5-10 seconds)
echo.

curl -X POST http://localhost:32638/questions/generate ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer %TOKEN%" ^
  -d "{\"certification_type\":\"CV0-004\",\"domain_name\":\"Cloud Security\",\"cognitive_level\":\"Application\",\"skill_level\":\"Intermediate\",\"count\":1}" ^
  -o docker-question-response.json

echo.
echo ============================================
echo Test Results
echo ============================================
echo.
type docker-question-response.json
echo.
echo.
echo Response saved to: docker-question-response.json
echo.

del docker-login-response.json
pause
