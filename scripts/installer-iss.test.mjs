import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const iss = readFileSync(new URL("../agent/windows/installer/SysMonAgent.iss", import.meta.url), "utf8");
const install = readFileSync(new URL("../agent/windows/installer/Install-SysMonService.ps1", import.meta.url), "utf8");

test("iss: yonetici yetkisi, sabit AppId, 64-bit, kaldirma betigi kurulu kalir", () => {
  assert.match(iss, /^PrivilegesRequired=admin$/m);
  assert.match(iss, /^AppId=\{\{[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}\}$/m);
  assert.match(iss, /^ArchitecturesInstallIn64BitMode=x64compatible$/m);
  assert.ok(iss.includes('Source: "Uninstall-SysMonService.ps1"; DestDir: "{app}\\installer"'));
});
test("iss: kurulum betigi cagirilir (SourceDir/InstallDir), servisi Inno degil betik kurar; kurulumda servisi KENDILIGINDEN baslatmaz (-StartService yok)", () => {
  assert.match(iss, /Install-SysMonService\.ps1""[^\n]*-SourceDir ""\{tmp\}\\payload""[^\n]*-InstallDir ""\{app\}""/);
  assert.ok(!iss.includes("-StartService"));
  assert.ok(existsSync(new URL("../agent/windows/installer/Install-SysMonService.ps1", import.meta.url)));
  assert.match(install, /param\([\s\S]*\$SourceDir[\s\S]*\$InstallDir[\s\S]*\$Server\b/);        // iss'in verdigi parametreler betikte var
  assert.match(install, /\[string\[\]\]\$ServerPin/);
});
test("iss: komut satirina giren degerler dogrulanir (tirnak/bosluk/kabuk karakteri, https, kimlik bilgisi, pin bicimi), sessiz kurulumda da", () => {
  assert.match(iss, /function SafeText/);
  for (const ch of ["'\"'", "'`'", "'&'", "'|'", "';'"]) assert.ok(iss.includes(`S[I] = ${ch}`), `${ch} reddedilmiyor`);
  assert.match(iss, /Pos\('https:\/\/', LowerCase\(S\)\) = 1/);
  assert.match(iss, /Pos\('@', S\) = 0/);
  assert.match(iss, /Pos\('sha256\/', S\) = 1/);
  assert.match(iss, /function InitializeSetup[\s\S]*ValidServer\(ExpandConstant\('\{param:SERVER\|\}'\)\)/);
});
test("iss: kaldirmada veri dizini VARSAYILAN korunur (Hayir varsayilan; sessizde silinmez)", () => {
  assert.match(iss, /MB_YESNO or MB_DEFBUTTON2/);
  assert.match(iss, /if not UninstallSilent\(\) then/);
  assert.match(iss, /RemoveData := False;/);
  assert.match(iss, /if RemoveData then Result := ' -RemoveData'/);
});
test("iss: paket HICBIR sir icermez (belirec/parola/anahtar yok)", () => {
  assert.ok(!/(password|parola\s*=|secret|token\s*=|api[_-]?key|BEGIN [A-Z ]*PRIVATE)/i.test(iss.replace(/belirec[^\n]*/gi, "").replace(/kayit belirteci[^\n]*/gi, "")));
});
