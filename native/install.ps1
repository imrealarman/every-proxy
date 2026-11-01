# Registers the native host for Chrome and Edge (current user) and downloads Xray-core.
# Usage:  powershell -ExecutionPolicy Bypass -File install.ps1
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$extId = (Get-Content (Join-Path $here 'extension_id.txt') -Raw).Trim()
$hostName = 'com.everyproxy.host'

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    throw 'Python 3 is required on PATH (the native host is host.py).'
}

# 1. Xray-core
$core = Join-Path $here 'core'
if (-not (Test-Path (Join-Path $core 'xray.exe'))) {
    Write-Host 'Downloading Xray-core...'
    New-Item -ItemType Directory -Force $core | Out-Null
    $zip = Join-Path $env:TEMP 'xray-win64.zip'
    Invoke-WebRequest 'https://github.com/XTLS/Xray-core/releases/latest/download/Xray-windows-64.zip' -OutFile $zip
    Expand-Archive $zip -DestinationPath $core -Force
    Remove-Item $zip
}

# 2. Host manifest
$manifest = Join-Path $here "$hostName.json"
@{
    name            = $hostName
    description     = 'Every Proxy core launcher'
    path            = (Join-Path $here 'host.bat')
    type            = 'stdio'
    allowed_origins = @("chrome-extension://$extId/")
} | ConvertTo-Json | Set-Content -Encoding ascii $manifest

# 3. Registry (Chrome + Edge)
foreach ($root in 'HKCU:\Software\Google\Chrome\NativeMessagingHosts', 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts') {
    $key = Join-Path $root $hostName
    New-Item -Path $key -Force | Out-Null
    Set-ItemProperty -Path $key -Name '(default)' -Value $manifest
}

Write-Host "Done. Extension ID: $extId"
Write-Host 'Now load the "extension" folder via chrome://extensions or edge://extensions (Developer mode > Load unpacked).'
