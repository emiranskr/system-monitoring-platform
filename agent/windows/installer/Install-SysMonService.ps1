#Requires -RunAsAdministrator
<#
.SYNOPSIS
  SysMon Agent'i Windows Service olarak kurar: dusuk yetkili sanal hesap (NT SERVICE\<ad>), kisitli ACL, kurtarma eylemleri.
.DESCRIPTION
  - Program dosyalari InstallDir'e kopyalanir (servis hesabi YAZAMAZ; Users yalnizca okur/calistirir).
  - Veri dizini yalnizca SYSTEM, Administrators ve servis hesabi (Modify) icindir.
  - Servis hesabi parola gerektirmeyen sanal hesaptir (NT SERVICE\SysMonAgent); LocalSystem KULLANILMAZ.
  - Sensor yardimcisi/surucu bu betikle kurulmaz (D4: istege bagli).
  Inno Setup bu betigi cagirabilir (bkz. ADR 0001 / proposal 15.1).
#>
param(
    [Parameter(Mandatory)][string]$SourceDir,
    [string]$InstallDir = (Join-Path $env:ProgramFiles 'SysMon\Agent'),
    [string]$DataDir = (Join-Path $env:ProgramData 'SysMon\agent'),
    [string]$ServiceName = 'SysMonAgent',
    [string]$Server,
    [string[]]$ServerPin = @(),
    [switch]$SkipPerfMonUsers,
    [switch]$StartService
)
$ErrorActionPreference = 'Stop'

function Get-LocalGroupNameBySid([string]$sid) {
    # Yerellestirilmis Windows'ta grup adi degisir (orn. "Performans Izleyici Kullanicilari"); SID sabittir.
    $full = (New-Object System.Security.Principal.SecurityIdentifier $sid).Translate([System.Security.Principal.NTAccount]).Value
    return $full.Split('\')[-1]
}

# Yol temizligi: bosluklar ve sondaki ters/duz boluler tirnak kacirma ve komut satiri bozulmalarini onlemek icin temizlenir
$SourceDir = $SourceDir.Trim().TrimEnd('\', '/')
$InstallDir = $InstallDir.Trim().TrimEnd('\', '/')
$DataDir = $DataDir.Trim().TrimEnd('\', '/')

# O9: Sunucu adresi ve SPKI pin bicim dogrulamalari
if ($Server) {
    $uri = $null
    if (-not [Uri]::TryCreate($Server, [UriKind]::Absolute, [ref]$uri) -or ($uri.Scheme -notin 'http', 'https') -or (-not [string]::IsNullOrEmpty($uri.UserInfo))) {
        throw "Gecersiz -Server adresi: $Server (mutlak http/https URL ve kullanici bilgisiz olmalidir)"
    }
}
foreach ($p in $ServerPin) {
    if (-not $p.StartsWith('sha256/')) {
        throw "Gecersiz -ServerPin bicimi ('sha256/' ile baslamali): $p"
    }
    $b64 = $p.Substring(7)
    try {
        $bytes = [Convert]::FromBase64String($b64)
        if ($bytes.Length -ne 32) { throw "32 bayt degil" }
    } catch {
        throw "Gecersiz -ServerPin Base64 SHA-256 degeri: $p"
    }
}

if (-not (Test-Path (Join-Path $SourceDir 'Agent.Service.exe'))) { throw "Agent.Service.exe bulunamadi: $SourceDir" }
$account = "NT SERVICE\$ServiceName"

# 1) Yukseltme: varsa servisi durdur
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing -and $existing.Status -ne 'Stopped') {
    Stop-Service -Name $ServiceName -Force
    $existing.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
}

# 2) Program dosyalari (servis hesabi yazamaz: Program Files varsayilan ACL'i)
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Path (Join-Path $SourceDir '*') -Destination $InstallDir -Recurse -Force
$exe = Join-Path $InstallDir 'Agent.Service.exe'

# 3) Servis: komut satiri
$bin = "`"$exe`" --service --data-dir `"$DataDir`""
if ($Server) { $bin += " --server `"$Server`"" }
foreach ($p in $ServerPin) { $bin += " --server-pin `"$p`"" }

if ($existing) {
    # sc.exe config binPath= PowerShell 5.1'de tirnaklari bozar (sessizce eski komut satiri kalir); ImagePath dogrudan yazilir.
    Set-ItemProperty -Path ('HKLM:\SYSTEM\CurrentControlSet\Services\' + $ServiceName) -Name ImagePath -Value $bin
} else {
    New-Service -Name $ServiceName -BinaryPathName $bin -DisplayName 'SysMon Agent' `
        -Description 'Sistem izleme platformu agent servisi (dusuk yetkili).' -StartupType Automatic | Out-Null
}
# Dusuk yetkili sanal hesap + yalniz kendi SID'i icin kisitlama yok (sanal hesabin dosya ACL'i icin servis SID'i gerekir)
& sc.exe config $ServiceName obj= $account | Out-Null
if ($LASTEXITCODE -ne 0) { throw "sc config obj= basarisiz (cikis: $LASTEXITCODE)" }
& sc.exe sidtype $ServiceName unrestricted | Out-Null
if ($LASTEXITCODE -ne 0) { throw "sc sidtype basarisiz (cikis: $LASTEXITCODE)" }
& sc.exe config $ServiceName start= delayed-auto | Out-Null
if ($LASTEXITCODE -ne 0) { throw "sc config start= basarisiz (cikis: $LASTEXITCODE)" }
& sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/15000/restart/60000 | Out-Null
if ($LASTEXITCODE -ne 0) { throw "sc failure basarisiz (cikis: $LASTEXITCODE)" }

# 4) Veri dizini: miras kapali; SYSTEM + Administrators tam, servis hesabi Modify. Users/Everyone YOK.
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$sysSid = '*S-1-5-18'; $admSid = '*S-1-5-32-544'
& icacls.exe $DataDir /inheritance:r /grant:r "${sysSid}:(OI)(CI)F" "${admSid}:(OI)(CI)F" "${account}:(OI)(CI)M" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'icacls (veri dizini) basarisiz' }

# 5) PDH izni: A5 gercek-Windows olcumu (ADR 0004): uyelik OLMADAN PDH sayaci eklenemiyor (0xC0000BC8) -> varsayilan ACIK
if (-not $SkipPerfMonUsers) {
    $grp = Get-LocalGroupNameBySid 'S-1-5-32-558'
    # cmd /c: PowerShell 5.1, ErrorActionPreference=Stop altinda native stderr satirlarini istisnaya cevirir
    & cmd.exe /c "net localgroup ""$grp"" ""$account"" /add >nul 2>&1"
    # 0 = eklendi, 2 = zaten uye; digerleri hata
    if ($LASTEXITCODE -notin 0, 2) { throw "Performance Monitor Users uyeligi eklenemedi (net cikis $LASTEXITCODE)" }
}

if ($StartService) {
    Start-Service -Name $ServiceName
    (Get-Service -Name $ServiceName).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
}
Write-Output "Kuruldu: $ServiceName (hesap: $account), program: $InstallDir, veri: $DataDir"
