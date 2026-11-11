#Requires -RunAsAdministrator
<#
.SYNOPSIS
  SysMon Agent servisini kaldirir. Veri dizini (spool, token deposu) yalnizca -RemoveData ile silinir.
#>
param(
    [string]$InstallDir = (Join-Path $env:ProgramFiles 'SysMon\Agent'),
    [string]$DataDir = (Join-Path $env:ProgramData 'SysMon\agent'),
    [string]$ServiceName = 'SysMonAgent',
    [switch]$RemoveData
)
$ErrorActionPreference = 'Stop'
$account = "NT SERVICE\$ServiceName"

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc) {
    if ($svc.Status -ne 'Stopped') {
        Stop-Service -Name $ServiceName -Force
        $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    }
    & sc.exe delete $ServiceName | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'sc delete basarisiz' }
}

# Performance Monitor Users uyeligi (varsa) temizlenir
$grp = ((New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-32-558').Translate([System.Security.Principal.NTAccount]).Value).Split('\')[-1]
& cmd.exe /c "net localgroup ""$grp"" ""$account"" /delete >nul 2>&1"
# uye degilse net hata verir (1377); kaldirma icin onemsiz

if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
$parent = Split-Path $InstallDir -Parent
if ((Test-Path $parent) -and -not (Get-ChildItem $parent -Force)) { Remove-Item -Force $parent }
if ($RemoveData -and (Test-Path $DataDir)) {
    Remove-Item -Recurse -Force $DataDir
    $dparent = Split-Path $DataDir -Parent
    if ((Test-Path $dparent) -and -not (Get-ChildItem $dparent -Force)) { Remove-Item -Force $dparent }
}
Write-Output "Kaldirildi: $ServiceName"
