param(
    [Parameter(Mandatory = $true)]
    [string]$Python,
    [switch]$SkipInstaller
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Test-Path -LiteralPath $Python -PathType Leaf)) {
    throw "Python executable not found: $Python"
}

& $Python (Join-Path $Root 'prepare_desktop_assets.py')
if ($LASTEXITCODE -ne 0) { throw 'Desktop asset preparation failed.' }

& $Python -m PyInstaller --noconfirm --clean `
    --distpath (Join-Path $Root 'dist') `
    --workpath (Join-Path $Root 'build') `
    (Join-Path $Root 'YOLOAutoTag.spec')
if ($LASTEXITCODE -ne 0) { throw 'PyInstaller build failed.' }

$Exe = Join-Path $Root 'dist\YOLOAutoTag\YOLOAutoTag.exe'
if (-not (Test-Path -LiteralPath $Exe)) { throw "Desktop executable was not generated: $Exe" }

$SourceConfig = Join-Path (Split-Path -Parent $Root) 'config.js'
$SourceText = Get-Content -LiteralPath $SourceConfig -Raw -Encoding UTF8
$SecretValues = [regex]::Matches($SourceText, '(?i)key\s*:\s*[''"]([^''"]+)[''"]') |
    ForEach-Object { $_.Groups[1].Value.Trim() } |
    Where-Object { $_.Length -ge 8 } |
    Sort-Object -Unique
$LeakCount = 0
if ($SecretValues.Count -gt 0) {
    Get-ChildItem -LiteralPath (Join-Path $Root 'dist\YOLOAutoTag') -Recurse -File | ForEach-Object {
        $BuildText = [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($_.FullName))
        foreach ($SecretValue in $SecretValues) {
            if ($BuildText.Contains($SecretValue)) {
                $LeakCount++
                break
            }
        }
    }
}
if ($LeakCount -gt 0) {
    throw "Secret scan failed: $LeakCount build file(s) contain a source API key."
}
Write-Host 'Packaged secret scan: passed'
Write-Host "Desktop application generated: $Exe"

if ($SkipInstaller) { exit 0 }

$Candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'),
    'C:\Program Files (x86)\Inno Setup 6\ISCC.exe',
    'C:\Program Files\Inno Setup 6\ISCC.exe'
)
$Iscc = $Candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $Iscc) {
    Write-Warning 'Inno Setup 6 was not found. Installer compilation was skipped.'
    exit 0
}

& $Iscc (Join-Path $Root 'installer\YOLOAutoTag.iss')
if ($LASTEXITCODE -ne 0) { throw 'Inno Setup installer build failed.' }
Write-Host ("Installer generated: " + (Join-Path $Root 'output\YOLO_Auto_Tag_V1.1_Setup.exe'))
