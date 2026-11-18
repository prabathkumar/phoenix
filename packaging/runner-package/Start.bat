@echo off
cd /d "%~dp0"
if not exist "node\node.exe" (echo Please double-click Install.bat first. & pause & exit /b 1)
set "PATH=%~dp0node;%PATH%"
set "PLAYWRIGHT_BROWSERS_PATH=%~dp0browsers"
set "PHOENIX_RUNNER_CONFIG=%USERPROFILE%\.phoenix-runner.json"
if not exist "%PHOENIX_RUNNER_CONFIG%" (
  set "SERVER="
  if exist phoenix-server.txt set /p SERVER=<phoenix-server.txt
  if "%SERVER%"=="" set /p SERVER=Phoenix address, for example https://phoenix.yourcompany.com: 
  echo In Phoenix, open "Laptop runners" and click "Get a pairing code".
  set /p CODE=Pairing code: 
  node runner\phoenix-runner.js pair "%SERVER%" "%CODE%"
  if errorlevel 1 (echo Pairing failed. & pause & exit /b 1)
)
echo Phoenix Runner is running. Leave this window open. Close it to stop.
node runner\phoenix-runner.js start
pause
