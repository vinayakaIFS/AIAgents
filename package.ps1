# Packages the extension into dist\TxPerf-Recorder-<version>.zip
# (upload to the Chrome Web Store / Edge Add-ons, or unzip and "Load unpacked").
$root = $PSScriptRoot
$manifest = Get-Content "$root\manifest.json" -Raw | ConvertFrom-Json
$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null
$zip = Join-Path $dist ("TxPerf-Recorder-" + $manifest.version + ".zip")
if (Test-Path $zip) { Remove-Item $zip -Force }
$items = @('manifest.json', 'background.js', 'lib', 'content', 'popup', 'dashboard', 'icons', 'README.md') | ForEach-Object { Join-Path $root $_ }
Compress-Archive -Path $items -DestinationPath $zip
Write-Host "Created $zip"
