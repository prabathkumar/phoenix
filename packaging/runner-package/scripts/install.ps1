# Phoenix Runner: one-time setup for Windows. Downloads Node and a browser INTO THIS FOLDER. No admin rights needed.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
Write-Host "Setting up Phoenix Runner. This only has to be done once. Please wait..."
if (-not (Test-Path "node\node.exe")) {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "win-arm64" } else { "win-x64" }
  $base = "https://nodejs.org/dist/latest-v22.x"
  Invoke-WebRequest "$base/SHASUMS256.txt" -OutFile "sums.txt" -UseBasicParsing
  $line = (Get-Content "sums.txt" | Where-Object { $_ -match "node-v[0-9.]+-$arch\.zip$" } | Select-Object -First 1)
  if (-not $line) { throw "Could not find the right Node download." }
  $sum, $file = $line -split "\s+", 2
  Write-Host "Downloading Node ($file)..."
  Invoke-WebRequest "$base/$file" -OutFile "node.zip" -UseBasicParsing
  if ((Get-FileHash "node.zip" -Algorithm SHA256).Hash.ToLower() -ne $sum.ToLower()) { Remove-Item "node.zip"; throw "The download did not match its checksum, so it was thrown away. Run this again." }
  Expand-Archive "node.zip" -DestinationPath "node_tmp" -Force
  Move-Item (Get-ChildItem "node_tmp" | Select-Object -First 1).FullName "node"
  Remove-Item "node_tmp", "node.zip", "sums.txt" -Recurse -Force
}
$env:PATH = "$root\node;$env:PATH"
$env:PLAYWRIGHT_BROWSERS_PATH = "$root\browsers"
Push-Location web
& "$root\node\npm.cmd" install --no-audit --no-fund --omit=dev
if ($LASTEXITCODE -ne 0) { throw "Installing the helper libraries failed." }
& "$root\node\npx.cmd" playwright install chromium
if ($LASTEXITCODE -ne 0) { throw "Installing the browser failed." }
Pop-Location
Write-Host ""
Write-Host "All set. Now double-click Start.bat (connect to the VPN first if your apps need it)."
