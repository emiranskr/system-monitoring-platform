; SysMon Agent kurulum paketi (Inno Setup 6). DERLENMEDI/CALISTIRILMADI: kur/yukselt/kaldir ve Defender/SmartScreen testleri
; yonetici (UAC) gerektirir ve KULLANICI onayli ayri kapidadir (docs/kurulum-agent.md). Betik yapisi scripts/installer-iss.test.mjs ile
; statik olarak sinanir.
;
; Derleme:  ISCC.exe /DSourceDir=<dotnet publish ciktisi> /DAppVersion=0.1.0 SysMonAgent.iss
; Tasarim:  Inno yalniz sarmalayicidir; tum servis/ACL/geri alma mantigi Install-SysMonService.ps1 / Uninstall-SysMonService.ps1 icindedir
;           (dusuk yetkili sanal hesap, servis ilk Disabled, hata olursa geri alma).
; Bu paket HICBIR SIR icermez: kayit belirteci (enrollment token) kurulumdan SONRA ayri adimda girilir.

#ifndef SourceDir
  #error SourceDir tanimlayin: /DSourceDir=<dotnet publish ciktisi>
#endif
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{6F1B7A52-3C0E-4B7E-9D55-5A3E2C8D4F10}
AppName=SysMon Agent
AppVersion={#AppVersion}
AppPublisher=SysMon
DefaultDirName={autopf}\SysMon\Agent
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
OutputBaseFilename=SysMonAgent-Setup-{#AppVersion}
UninstallDisplayName=SysMon Agent
; Calisan servisi Inno degil betik durdurur/yeniden yapilandirir
CloseApplications=no
RestartApplications=no

[Files]
; Yuk (publish ciktisi) gecici dizine acilir; betik InstallDir'e kopyalar ve ACL'leri ayarlar (servis hesabi program dizinine YAZAMAZ).
Source: "{#SourceDir}\*"; DestDir: "{tmp}\payload"; Flags: recursesubdirs createallsubdirs ignoreversion deleteafterinstall
Source: "Install-SysMonService.ps1"; DestDir: "{tmp}"; Flags: ignoreversion deleteafterinstall
; Kaldirma betigi kurulu kalir (kaldirmada gerekli); program dizini ile birlikte silinir.
Source: "Uninstall-SysMonService.ps1"; DestDir: "{app}\installer"; Flags: ignoreversion

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{tmp}\Install-SysMonService.ps1"" -SourceDir ""{tmp}\payload"" -InstallDir ""{app}""{code:ServerArgs}"; \
  StatusMsg: "SysMon Agent servisi kuruluyor..."; Flags: runhidden waituntilterminated

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\installer\Uninstall-SysMonService.ps1"" -InstallDir ""{app}""{code:RemoveDataArg}"; \
  RunOnceId: "SysMonUninstall"; Flags: runhidden waituntilterminated

[Code]
var
  Page: TInputQueryWizardPage;
  RemoveData: Boolean;

function ServerValue(): String;
begin
  Result := ExpandConstant('{param:SERVER|}');
  if (Result = '') and (Page <> nil) then Result := Trim(Page.Values[0]);
end;

function PinValue(): String;
begin
  Result := ExpandConstant('{param:PIN|}');
  if (Result = '') and (Page <> nil) then Result := Trim(Page.Values[1]);
end;

{ Komut satirina eklenecek her deger DOGRULANIR: tirnak/bosluk/kontrol karakteri yok (komut enjeksiyonu), sunucu https:// ve kimlik bilgisiz,
  pin sha256/<base64>. Betik de ayni kurallari uygular (savunma derinligi). }
function SafeText(const S: String): Boolean;
var I: Integer;
begin
  Result := True;
  for I := 1 to Length(S) do
    if (S[I] = '"') or (S[I] = ' ') or (S[I] = '`') or (S[I] = '&') or (S[I] = '|') or (S[I] = ';') or (Ord(S[I]) < 32) then Result := False;
end;

function ValidServer(const S: String): Boolean;
begin
  Result := (S = '') or ((Pos('https://', LowerCase(S)) = 1) and SafeText(S) and (Pos('@', S) = 0));
end;

function ValidPin(const S: String): Boolean;
begin
  Result := (S = '') or ((Pos('sha256/', S) = 1) and SafeText(S));
end;

procedure InitializeWizard();
begin
  Page := CreateInputQueryPage(wpWelcome, 'Sunucu', 'Agent hangi sunucuya baglanacak?',
    'Bos birakirsaniz kurulumdan sonra yapilandirabilirsiniz. Adres https:// ile baslamali ve kullanici bilgisi icermemelidir.');
  Page.Add('Sunucu adresi (https://...):', False);
  Page.Add('Sertifika sabitleme (istege bagli, sha256/<base64>):', False);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (Page <> nil) and (CurPageID = Page.ID) then
  begin
    if not ValidServer(Trim(Page.Values[0])) then begin MsgBox('Sunucu adresi gecersiz (https:// ile baslamali, bosluk/tirnak/@ icermemeli).', mbError, MB_OK); Result := False; end
    else if not ValidPin(Trim(Page.Values[1])) then begin MsgBox('Sertifika sabitleme degeri gecersiz (sha256/<base64>).', mbError, MB_OK); Result := False; end;
  end;
end;

function InitializeSetup(): Boolean;
begin
  Result := True;
  { Sessiz kurulumda (/SERVER=, /PIN=) degerler de ayni dogrulamadan gecer }
  if not ValidServer(ExpandConstant('{param:SERVER|}')) then begin Log('SERVER gecersiz'); Result := False; end
  else if not ValidPin(ExpandConstant('{param:PIN|}')) then begin Log('PIN gecersiz'); Result := False; end;
end;

function ServerArgs(Param: String): String;
begin
  Result := '';
  if ServerValue() <> '' then Result := Result + ' -Server ""' + ServerValue() + '""';
  if PinValue() <> '' then Result := Result + ' -ServerPin ""' + PinValue() + '""';
end;

{ Kaldirma: veri dizini (spool, belirec deposu) VARSAYILAN OLARAK KORUNUR. Yalnizca kullanici acikca "Evet" derse silinir (sessiz kaldirma korur). }
function InitializeUninstall(): Boolean;
begin
  Result := True;
  RemoveData := False;
  if not UninstallSilent() then
    RemoveData := MsgBox('Agent veri dizini (kayit belirteci ve bekleyen veriler) de silinsin mi?' + #13#10 + 'Hayir derseniz veriler korunur.', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES;
end;

function RemoveDataArg(Param: String): String;
begin
  if RemoveData then Result := ' -RemoveData' else Result := '';
end;
