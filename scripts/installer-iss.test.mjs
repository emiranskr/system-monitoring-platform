import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const iss = readFileSync(new URL("../agent/windows/installer/SysMonAgent.iss", import.meta.url), "utf8");
const install = readFileSync(new URL("../agent/windows/installer/Install-SysMonService.ps1", import.meta.url), "utf8");
const code = iss.slice(iss.indexOf("[Code]"));

test("iss: yonetici yetkisi, sabit AppId, 64-bit, betikler paketlenir", () => {
  assert.match(iss, /^PrivilegesRequired=admin$/m);
  assert.match(iss, /^AppId=\{\{[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}\}$/m);
  assert.match(iss, /^ArchitecturesInstallIn64BitMode=x64compatible$/m);
  assert.ok(iss.includes('Source: "Uninstall-SysMonService.ps1"; DestDir: "{app}\\installer"'));
  assert.ok(iss.includes('Source: "Verify-ServiceInstall.ps1"; DestDir: "{app}\\installer"'));
  assert.ok(existsSync(new URL("../agent/windows/installer/Verify-ServiceInstall.ps1", import.meta.url)));
});
test("iss: betik CIKIS KODU denetlenir ([Run]/[UninstallRun] sifirdan farkli cikisi yutar): Exec + ResultCode <> 0 -> RaiseException", () => {
  assert.ok(!/^\[Run\]/m.test(iss) && !/^\[UninstallRun\]/m.test(iss), "[Run]/[UninstallRun] kullanilmamali");
  assert.match(code, /Exec\(ExpandConstant\('\{sys\}\\WindowsPowerShell\\v1\.0\\powershell\.exe'\)[^\n]*ResultCode\)\) or \(ResultCode <> 0\)/);
  assert.match(code, /RaiseException\(/);
  assert.match(code, /CurStep = ssPostInstall[\s\S]*Install-SysMonService\.ps1[\s\S]*-SourceDir[\s\S]*-InstallDir/);
  assert.match(code, /usUninstall[\s\S]*Uninstall-SysMonService\.ps1[\s\S]*-InstallDir/);
  assert.ok(!iss.includes("-StartService"));
});
test("iss: betikte iss'in verdigi parametreler var", () => {
  assert.match(install, /param\([\s\S]*\$SourceDir[\s\S]*\$InstallDir[\s\S]*\$Server\b/);
  assert.match(install, /\[string\[\]\]\$ServerPin/);
});
test("iss: girdi dogrulama (tirnak/ters bolu/bosluk/kabuk karakteri, https + ana makine, kimlik bilgisi, pin bicimi), sessiz kurulumda da; degerler cift tirnakla sarilir ('"' Pascal dizesi)", () => {
  assert.match(code, /function SafeText/);
  for (const ch of ["'\"'", "'\\'", "'`'", "'&'", "'|'", "';'"]) assert.ok(code.includes(`S[I] = ${ch}`), `${ch} reddedilmiyor`);
  assert.match(code, /Pos\('https:\/\/', LowerCase\(S\)\) = 1\) and \(Length\(S\) > 8\)/);
  assert.match(code, /Pos\('@', S\) = 0/);
  assert.match(code, /Pos\('sha256\/', S\) = 1\) and \(Length\(S\) > 7\)/);
  assert.match(code, /function InitializeSetup[\s\S]*ValidServer\(ExpandConstant\('\{param:SERVER\|\}'\)\)/);
  assert.ok(!code.includes('""'), "cift tirnak kacisi (belirsiz) kullanilmamali");
  assert.ok(code.includes(`' -Server "' + ServerValue() + '"'`) && code.includes(`' -ServerPin "' + PinValue() + '"'`));
});
test("iss: kaldirmada veri dizini VARSAYILAN korunur (Hayir varsayilan; sessizde silinmez)", () => {
  assert.match(code, /MB_YESNO or MB_DEFBUTTON2/);
  assert.match(code, /if not UninstallSilent\(\) then/);
  assert.match(code, /RemoveData := False;/);
  assert.match(code, /if RemoveData then Extra := ' -RemoveData'/);
});
test("iss: paket HICBIR sir icermez (belirec/parola/anahtar yok)", () => {
  assert.ok(!/(password|parola\s*=|secret|token\s*=|api[_-]?key|BEGIN [A-Z ]*PRIVATE)/i.test(iss.replace(/belirec[^\n]*/gi, "").replace(/kayit belirteci[^\n]*/gi, "")));
});
