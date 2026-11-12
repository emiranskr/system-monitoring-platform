#Requires -RunAsAdministrator
<#
.SYNOPSIS
  A5 dogrulamasi: servisi GERCEK Windows'ta kurar, dusuk yetkili hesapta calistigini, PDH izin matrisini,
  token deposu ACL'ini, kurtarma eylemini kanitlar; sonra her seyi siler. Cikti $LogPath dosyasina yazilir.
#>
param(
    [Parameter(Mandatory)][string]$PublishDir,
    [Parameter(Mandatory)][string]$LogPath
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$svcName = 'SysMonAgentVerify'
$account = "NT SERVICE\$svcName"
$installDir = Join-Path $env:ProgramFiles 'SysMon-verify\Agent'
$dataDir = Join-Path $env:ProgramData 'SysMon-verify\agent'
$script:ok = $true

function Log([string]$m) { Add-Content -Path $LogPath -Value ("[{0:HH:mm:ss}] {1}" -f (Get-Date), $m) -Encoding UTF8 }
# Performance Monitor Users uyelik sayisi: bastaki ve sondaki deger esit olmali (yetim SID/sizinti yok). Ad yerellestirilmis olabilir: SID'den.
$perfGroup = ((New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-32-558').Translate([System.Security.Principal.NTAccount]).Value).Split([char]92)[-1]
function GroupLineCount { @(& cmd.exe /c "net localgroup ""$perfGroup"" 2>nul").Count }
$groupBefore = GroupLineCount
function Check([string]$name, [bool]$cond, [string]$detail = '') {
    if (-not $cond) { $script:ok = $false }
    Log ("{0,-6} {1} {2}" -f ($(if ($cond) { 'GECTI' } else { 'KALDI' }), $name, $detail))
}
function Read-Spool([string]$dir) {
    $metrics = @{}
    $files = Get-ChildItem (Join-Path $dir 'spool') -Filter 'seg-*' -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch '\.tmp$' }
    foreach ($f in $files) {
        if ($f.Name -like '*.gz') {
            $fs = [IO.File]::OpenRead($f.FullName); $gz = New-Object IO.Compression.GZipStream($fs, [IO.Compression.CompressionMode]::Decompress)
            $sr = New-Object IO.StreamReader($gz); $lines = @(); while ($null -ne ($l = $sr.ReadLine())) { $lines += $l }; $sr.Dispose()
        } else {
            $fs = New-Object IO.FileStream($f.FullName, 'Open', 'Read', 'ReadWrite'); $sr = New-Object IO.StreamReader($fs)
            $lines = @(); while ($null -ne ($l = $sr.ReadLine())) { $lines += $l }; $sr.Dispose()
        }
        foreach ($line in $lines) {
            try { $b = $line | ConvertFrom-Json } catch { continue }
            foreach ($s in $b.Samples) { foreach ($p in $s.M.PSObject.Properties) {
                if (-not $metrics.ContainsKey($p.Name)) { $metrics[$p.Name] = @{ dolu = 0; bos = 0 } }
                if ($null -eq $p.Value) { $metrics[$p.Name].bos++ } else { $metrics[$p.Name].dolu++ }
            } }
        }
    }
    return $metrics
}
function Summarize($m) { ($m.Keys | Sort-Object | ForEach-Object { "{0}=dolu{1}/bos{2}" -f $_, $m[$_].dolu, $m[$_].bos }) -join '; ' }
function Install([switch]$Perf, [string]$Server) {
    $a = @{ SourceDir = $PublishDir; InstallDir = $installDir; DataDir = $dataDir; ServiceName = $svcName; StartService = $true }
    if (-not $Perf) { $a.SkipPerfMonUsers = $true }
    if ($Server) { $a.Server = $Server }
    & (Join-Path $here 'Install-SysMonService.ps1') @a | Out-Null
}

Set-Content -Path $LogPath -Value "A5 dogrulamasi basladi $(Get-Date -Format o) | yonetici=$(([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))" -Encoding UTF8
try {
    # --- Asama 1: PDH, performans grubu OLMADAN ---
    Install
    Start-Sleep -Seconds 25
    $svc = Get-CimInstance Win32_Service -Filter "Name='$svcName'"
    Check 'Servis calisiyor' ($svc.State -eq 'Running') "durum=$($svc.State)"
    Check 'Servis hesabi sanal hesap (LocalSystem DEGIL)' ($svc.StartName -eq $account) "StartName=$($svc.StartName)"
    $proc = Get-Process -Id $svc.ProcessId -IncludeUserName
    Check 'Surec kullanicisi servis hesabi' ($proc.UserName -eq $account) "UserName=$($proc.UserName)"
    $m1 = Read-Spool $dataDir
    Log "Spool (grupsuz): $(Summarize $m1)"
    $cpuOk1 = $m1.ContainsKey('cpu.total') -and $m1['cpu.total'].dolu -gt 0
    Log "BILGI PDH CPU, Performance Monitor Users uyeligi OLMADAN okunuyor mu: $cpuOk1"
    $agentLog1 = Get-Content (Join-Path $dataDir 'logs' | Join-Path -ChildPath 'agent.log') -ErrorAction SilentlyContinue
    foreach ($l in ($agentLog1 | Select-Object -First 6)) { Log "AGENTLOG $l" }
    if (-not $cpuOk1) {
        Check 'Grupsuz PDH basarisizsa servis yine de CALISIYOR (bozulmus mod) ve uyari gunlukte' ($svc.State -eq 'Running' -and [bool]($agentLog1 | Select-String 'Collector cpu calismiyor'))
    }
    Check 'Bellek ve disk metrikleri dolu' ($m1.ContainsKey('mem.used_pct') -and $m1['mem.used_pct'].dolu -gt 0 -and $m1.ContainsKey('disk.C.used_pct') -and $m1['disk.C.used_pct'].dolu -gt 0)

    # --- ACL: servis hesabi program dizinine yazamamali ---
    $instAcl = (Get-Acl $installDir).Access | ForEach-Object { "{0}:{1}:{2}" -f $_.IdentityReference, $_.AccessControlType, $_.FileSystemRights }
    Log "Program dizini ACL: $($instAcl -join ' | ')"
    Check 'Program dizininde servis hesabi icin acik yazma kurali yok' (-not ($instAcl | Where-Object { $_ -like "*$svcName*" }))
    $dataAcl = (Get-Acl $dataDir).Access | ForEach-Object { "{0}:{1}" -f $_.IdentityReference, $_.FileSystemRights }
    Log "Veri dizini ACL: $($dataAcl -join ' | ')"
    Check 'Veri dizininde Users/Everyone yok' (-not ($dataAcl | Where-Object { $_ -match 'Everyone|BUILTIN\\Users|Herkes|Kullan' -and $_ -notmatch 'Performans' }))
    $qf = (& sc.exe qfailure $svcName) -join ' '
    Log "Kurtarma: $(($qf -replace '\s+', ' '))"
    Check 'Kurtarma eylemi tanimli (RESTART)' ($qf -match 'RESTART')

    # --- Kurtarma: sureci oldur, servis yeniden baslamali ---
    $oldPid = $svc.ProcessId
    Stop-Process -Id $oldPid -Force
    Start-Sleep -Seconds 15
    $svc2 = Get-CimInstance Win32_Service -Filter "Name='$svcName'"
    Check 'Surec oldurulunca servis otomatik yeniden basladi' ($svc2.State -eq 'Running' -and $svc2.ProcessId -ne $oldPid -and $svc2.ProcessId -ne 0) "eskiPid=$oldPid yeniPid=$($svc2.ProcessId)"

    # --- Asama 2: PDH, performans grubu ILE (karsilastirma) ---
    Stop-Service $svcName -Force; (Get-Service $svcName).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    Remove-Item (Join-Path $dataDir 'spool') -Recurse -Force
    Install -Perf
    Start-Sleep -Seconds 25
    $m2 = Read-Spool $dataDir
    Log "Spool (grup ile): $(Summarize $m2)"
    $cpuOk2 = $m2.ContainsKey('cpu.total') -and $m2['cpu.total'].dolu -gt 0
    Check 'PDH CPU, Performance Monitor Users uyeligi ILE okunuyor' $cpuOk2
    Log "PDH IZIN SONUCU: gruba uyelik $(if ($cpuOk1) { 'GEREKMIYOR (grupsuz de calisti)' } else { 'GEREKLI (grupsuz null, grupla dolu)' })"

    # --- Asama 3: token deposu: DPAPI + ACL + servis hesabi okuyabiliyor mu ---
    Stop-Service $svcName -Force; (Get-Service $svcName).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))

    # Negatif kontrol (I-4): token HENUZ aktarilmadi. Servis --server ile baslarsa gunluk "token deposu yok" demeli ve
    # "Token yuklendi" ASLA yazmamali. Bu, asagidaki olumlu kontrolun bos (vacuous) olmadigini kanitlar.
    $logFile = Join-Path $dataDir 'logs' | Join-Path -ChildPath 'agent.log'
    $markNeg = @(Get-Content $logFile -ErrorAction SilentlyContinue).Count
    Install -Perf -Server 'https://127.0.0.1:59999'
    Start-Sleep -Seconds 20
    $negLines = @(Get-Content $logFile -ErrorAction SilentlyContinue | Select-Object -Skip $markNeg)
    Check 'Negatif kontrol: token yokken gunluk "Korumali token deposu yok" diyor' ([bool]($negLines | Select-String 'Korumali token deposu yok'))
    Check 'Negatif kontrol: token yokken "Token yuklendi" YAZILMIYOR' (-not [bool]($negLines | Select-String 'Token yuklendi'))
    Stop-Service $svcName -Force; (Get-Service $svcName).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))

    $plain = Join-Path $env:TEMP "sysmon-bootstrap-$([guid]::NewGuid().ToString('N')).txt"
    $secret = 'tok_' + [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
    Set-Content -Path $plain -Value $secret -Encoding ASCII
    $exe = Join-Path $installDir 'Agent.Service.exe'
    $imp = & $exe --import-token $plain --token-reader $account --data-dir $dataDir 2>&1
    Log "Import cikti: $imp (cikis=$LASTEXITCODE)"
    Check 'Import basarili' ($LASTEXITCODE -eq 0)
    Check 'Duz metin bootstrap dosyasi silindi' (-not (Test-Path $plain))
    $tok = Join-Path $dataDir 'identity\token.bin'
    $bytes = [IO.File]::ReadAllBytes($tok)
    $needle = [Text.Encoding]::UTF8.GetBytes($secret)
    $found = $false; for ($i = 0; $i + $needle.Length -le $bytes.Length; $i++) { $same = $true; for ($j = 0; $j -lt $needle.Length; $j++) { if ($bytes[$i + $j] -ne $needle[$j]) { $same = $false; break } }; if ($same) { $found = $true; break } }
    Check 'token.bin duz metin token icermiyor' (-not $found)
    $tokAcl = (Get-Acl $tok).Access | ForEach-Object { "{0}:{1}" -f $_.IdentityReference, $_.FileSystemRights }
    Log "token.bin ACL: $($tokAcl -join ' | ')"
    Check 'token.bin ACL: servis hesabi var, Users/Everyone yok' (($tokAcl | Where-Object { $_ -like "*$svcName*" }) -and -not ($tokAcl | Where-Object { $_ -match 'Everyone|BUILTIN\\Users|Herkes' }))

    # Servis hesabi token'i okuyabiliyor mu? --server ile baslat (dinleyen sunucu yok: baglanti reddi = gecici hata beklenir)
    # Yalniz BU yeniden baslatmadan sonra yazilan satirlar degerlendirilir (eski satirlar sonucu etkilemesin).
    $markPos = @(Get-Content $logFile -ErrorAction SilentlyContinue).Count
    Install -Perf -Server 'https://127.0.0.1:59999'
    Start-Sleep -Seconds 25
    $agentLog3 = @(Get-Content $logFile -ErrorAction SilentlyContinue | Select-Object -Skip $markPos)
    foreach ($l in ($agentLog3 | Select-Object -Last 8)) { Log "AGENTLOG $l" }
    $tokenLoaded = [bool]($agentLog3 | Select-String 'Token yuklendi')
    $tokenMissing = [bool]($agentLog3 | Select-String 'Korumali token (deposu yok|okunamadi)')
    $hasRetryWarn = [bool]($agentLog3 | Select-String 'Yukleme basarisiz')
    Check 'Servis hesabi korumali token deposunu OKUYABILIYOR (olumlu sinyal: "Token yuklendi" satiri var, "yok/okunamadi" yok)' ($tokenLoaded -and -not $tokenMissing)
    Check 'Yukleme dongusu calisiyor (sunucu yok: baglanti hatasi uyarisi var)' $hasRetryWarn

    # --- Asama 4 (M-4): BILEREK basarisiz kurulum. Servis olusturulduktan SONRA hata cikarsa (mevcut olmayan surucude veri dizini)
    # servis LocalSystem/Otomatik olarak KALMAMALI, dizinler geri alinmali, ayni ad sonra yeniden kurulabilmeli.
    $failName = 'SysMonAgentVerifyFail'
    $failInstall = Join-Path $env:ProgramFiles 'SysMon-verify-fail\Agent'
    $usedDrives = @((Get-PSDrive -PSProvider FileSystem).Name)
    $badDrive = @('Z','Y','X','W','V','U','T','S','R','Q') | Where-Object { $_ -notin $usedDrives } | Select-Object -First 1
    $threw = $false
    try {
        & (Join-Path $here 'Install-SysMonService.ps1') -SourceDir $PublishDir -InstallDir $failInstall `
            -DataDir ("{0}:\sysmon-yok\agent" -f $badDrive) -ServiceName $failName | Out-Null
    } catch { $threw = $true; Log "BILGI beklenen kurulum hatasi: $($_.Exception.Message)" }
    Check 'Basarisiz kurulum hata verdi' $threw
    Check 'Basarisiz kurulum: servis KALMADI (LocalSystem/Otomatik birakilmadi)' (-not (Get-Service $failName -ErrorAction SilentlyContinue))
    Check 'Basarisiz kurulum: program dizini geri alindi' (-not (Test-Path $failInstall))
    $grpNow = (& cmd.exe /c "net localgroup ""$perfGroup"" 2>nul") -join ' '
    Check 'Basarisiz kurulum: Performance Monitor Users uyeligi geri alindi' ($grpNow -notmatch $failName)

    $failData = Join-Path $env:ProgramData 'SysMon-verify-fail\agent'
    & (Join-Path $here 'Install-SysMonService.ps1') -SourceDir $PublishDir -InstallDir $failInstall -DataDir $failData -ServiceName $failName | Out-Null
    $re = Get-CimInstance Win32_Service -Filter "Name='$failName'"
    Check 'Yeniden kurulum mumkun: servis var, sanal hesap, Otomatik (gecikmeli)' ($re -and $re.StartName -eq "NT SERVICE\$failName" -and $re.StartMode -eq 'Auto')
    $ff = (& sc.exe qfailureflag $failName) -join ' '
    Check 'Failure flag aktif (zarif durmada da yeniden baslatma)' ($ff -match 'TRUE|1')
    & (Join-Path $here 'Uninstall-SysMonService.ps1') -InstallDir $failInstall -DataDir $failData -ServiceName $failName -RemoveData | Out-Null
}
catch {
    $script:ok = $false
    Log "HATA: $($_.Exception.Message) @ $($_.InvocationInfo.ScriptLineNumber)"
}
finally {
    try {
        & (Join-Path $here 'Uninstall-SysMonService.ps1') -InstallDir $installDir -DataDir $dataDir -ServiceName $svcName -RemoveData | Out-Null
        Check 'Temizlik: servis silindi' (-not (Get-Service $svcName -ErrorAction SilentlyContinue))
        # Asama 4'un artiklari (hata sirasinda kalmis olabilir)
        if (Get-Service 'SysMonAgentVerifyFail' -ErrorAction SilentlyContinue) {
            & (Join-Path $here 'Uninstall-SysMonService.ps1') -InstallDir (Join-Path $env:ProgramFiles 'SysMon-verify-fail\Agent') `
                -DataDir (Join-Path $env:ProgramData 'SysMon-verify-fail\agent') -ServiceName 'SysMonAgentVerifyFail' -RemoveData | Out-Null
        }
        foreach ($d in @((Join-Path $env:ProgramFiles 'SysMon-verify-fail'), (Join-Path $env:ProgramData 'SysMon-verify-fail'))) {
            if (Test-Path $d) { Remove-Item -Recurse -Force $d }
        }
        Check 'Temizlik: asama 4 servisi/dizinleri kalmadi' (-not (Get-Service 'SysMonAgentVerifyFail' -ErrorAction SilentlyContinue) -and -not (Test-Path (Join-Path $env:ProgramFiles 'SysMon-verify-fail')) -and -not (Test-Path (Join-Path $env:ProgramData 'SysMon-verify-fail')))
        Check 'Temizlik: dizinler silindi' (-not (Test-Path $installDir) -and -not (Test-Path $dataDir))
        $groupAfter = GroupLineCount
        Check 'Temizlik: Performance Monitor Users grubu basa dondu (yetim SID/sizinti yok)' ($groupAfter -eq $groupBefore) "once=$groupBefore sonra=$groupAfter"
    } catch { Log "TEMIZLIK HATASI: $($_.Exception.Message)"; $script:ok = $false }
    Log "BITTI sonuc=$(if ($script:ok) { 'BASARILI' } else { 'BASARISIZ' })"
}
