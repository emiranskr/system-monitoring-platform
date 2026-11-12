#Requires -RunAsAdministrator
<#
.SYNOPSIS
  SysMon Agent'i Windows Service olarak kurar: dusuk yetkili sanal hesap (NT SERVICE\<ad>), kisitli ACL, kurtarma eylemleri.
.DESCRIPTION
  - Program dosyalari InstallDir'e kopyalanir (servis hesabi YAZAMAZ; Users yalnizca okur/calistirir).
  - Veri dizini yalnizca SYSTEM, Administrators ve servis hesabi (Modify) icindir.
  - Servis hesabi parola gerektirmeyen sanal hesaptir (NT SERVICE\SysMonAgent); LocalSystem KULLANILMAZ.
  - Yeni servis DEVRE DISI (Disabled) olusturulur, tum yapilandirma bitip dogrulandiktan sonra EN SON otomatik baslatmaya
    alinir; arada herhangi bir hata olursa servis silinir ve olusturulan dizinler geri alinir. Boylece servis hicbir an
    LocalSystem + Otomatik olarak kalmaz (bagimsiz inceleme M-4).
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

# Girdi dogrulamalari (komut satirina/cmd'ye eklenmeden once)
if ($ServiceName -notmatch '^[A-Za-z0-9_-]{1,64}$') {
    throw "Gecersiz -ServiceName: '$ServiceName' (yalniz harf, rakam, '_' ve '-'; en fazla 64 karakter)"
}
if ($Server) {
    $uri = $null
    # Release agent yalniz https kabul eder (http yalnizca Debug+loopback); kurulum betigi de ayni kurali uygular.
    if (-not [Uri]::TryCreate($Server, [UriKind]::Absolute, [ref]$uri) -or ($uri.Scheme -ne 'https') -or (-not [string]::IsNullOrEmpty($uri.UserInfo))) {
        throw "Gecersiz -Server adresi: $Server (mutlak https URL ve kullanici bilgisiz olmalidir)"
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
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
$createdService = $false
$createdInstallDir = -not (Test-Path $InstallDir)
$createdDataDir = -not (Test-Path $DataDir)
$addedGroup = $false

try {
    # 1) Yukseltme: varsa servisi durdur
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
        & sc.exe config $ServiceName start= disabled | Out-Null   # yapilandirma bitene kadar devre disi
        if ($LASTEXITCODE -ne 0) { throw "sc config start= disabled basarisiz (cikis: $LASTEXITCODE)" }
    } else {
        New-Service -Name $ServiceName -BinaryPathName $bin -DisplayName 'SysMon Agent' `
            -Description 'Sistem izleme platformu agent servisi (dusuk yetkili).' -StartupType Disabled | Out-Null
        $createdService = $true
    }
    # Dusuk yetkili sanal hesap + servis SID'i (sanal hesabin dosya ACL'i icin servis SID'i gerekir)
    & sc.exe config $ServiceName obj= $account | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc config obj= basarisiz (cikis: $LASTEXITCODE)" }
    & sc.exe sidtype $ServiceName unrestricted | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc sidtype basarisiz (cikis: $LASTEXITCODE)" }
    & sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/15000/restart/60000 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc failure basarisiz (cikis: $LASTEXITCODE)" }
    # Sifirdan farkli cikis koduyla zarif durmada (orn. veri dizini kilidi) da SCM yeniden baslatsin (inceleme I-1)
    & sc.exe failureflag $ServiceName 1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc failureflag basarisiz (cikis: $LASTEXITCODE)" }

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
        $addedGroup = $true
    }

    # 6) Yapilandirma dogrulamasi: hesap dusuk yetkili sanal hesap olmali (LocalSystem DEGIL)
    $cfg = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
    if ($cfg.StartName -ne $account) { throw "Servis hesabi beklenen degil: '$($cfg.StartName)' (beklenen '$account')" }

    # 7) EN SON otomatik baslatmaya al (bu noktaya kadar servis Disabled idi)
    & sc.exe config $ServiceName start= delayed-auto | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "sc config start= basarisiz (cikis: $LASTEXITCODE)" }
    $cfg = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
    if ($cfg.StartMode -ne 'Auto' -or $cfg.StartName -ne $account) {
        throw "Kurulum sonu dogrulamasi basarisiz: StartMode=$($cfg.StartMode) StartName=$($cfg.StartName)"
    }

    if ($StartService) {
        Start-Service -Name $ServiceName
        (Get-Service -Name $ServiceName).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
    }
}
catch {
    $err = $_
    # Geri alma: yarim kurulum LocalSystem/Otomatik servis veya artik dizin birakmamali. Temizlik hatalari asil hatayi gizlemez.
    if ($createdService) {
        try { Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue } catch { }
        try { & sc.exe delete $ServiceName | Out-Null } catch { }
    }
    if ($addedGroup) {
        try { $g = Get-LocalGroupNameBySid 'S-1-5-32-558'; & cmd.exe /c "net localgroup ""$g"" ""$account"" /delete >nul 2>&1" } catch { }
    }
    if ($createdDataDir) { try { Remove-Item -Recurse -Force $DataDir -ErrorAction SilentlyContinue } catch { } }
    if ($createdInstallDir) { try { Remove-Item -Recurse -Force $InstallDir -ErrorAction SilentlyContinue } catch { } }
    throw $err
}

Write-Output "Kuruldu: $ServiceName (hesap: $account), program: $InstallDir, veri: $DataDir"
