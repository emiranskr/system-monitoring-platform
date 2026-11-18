import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CSP, SECURITY_HEADERS } from "../deploy/security-headers.mjs";

const nginx = readFileSync(new URL("../deploy/nginx.example.conf", import.meta.url), "utf8");
const envEx = readFileSync(new URL("../deploy/api.env.example", import.meta.url), "utf8");

test("nginx ornegi: her guvenlik basligi deploy/security-headers.mjs ile AYNI degerle bulunur", () => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    assert.ok(nginx.includes(`add_header ${name} "${value}" always;`), `nginx ornegi ${name} basligini ayni degerle icermiyor`);
  }
});
test("nginx ornegi: /assets/ blogu da CSP/HSTS/nosniff'i tekrarlar (nginx add_header miras almaz)", () => {
  const block = nginx.slice(nginx.indexOf("location /assets/"), nginx.indexOf("# --- API"));
  for (const n of ["Content-Security-Policy", "Strict-Transport-Security", "X-Content-Type-Options"]) assert.ok(block.includes(`add_header ${n} `), `/assets/ blogunda ${n} yok`);
  assert.ok(block.includes(CSP));
});
test("nginx ornegi: SSE tamponlamasi kapali, HTTPS yonlendirmesi ve TLS >= 1.2, X-Forwarded-For uzerine yazilir", () => {
  assert.match(nginx, /location = \/api\/v1\/stream[\s\S]*proxy_buffering off;/);
  assert.match(nginx, /return 301 https:\/\//);
  assert.match(nginx, /ssl_protocols\s+TLSv1\.2 TLSv1\.3;/);
  assert.ok(!/TLSv1[ ;]|TLSv1\.1/.test(nginx));
  assert.ok(nginx.includes("proxy_set_header X-Forwarded-For $remote_addr;"));
  assert.ok(!nginx.includes("$proxy_add_x_forwarded_for"));
});
test("CSP: unsafe-eval ve unsafe-inline (script) YOK; yalniz style-src-attr satir ici izni var", () => {
  assert.ok(!CSP.includes("unsafe-eval"));
  const script = CSP.split("; ").find((d) => d.startsWith("script-src "));
  assert.equal(script, "script-src 'self'");
  assert.ok(CSP.includes("frame-ancestors 'none'") && CSP.includes("object-src 'none'") && CSP.includes("default-src 'none'"));
});
test("env ornegi: uretim, gelistirme bayraklari yorum satirinda, sir DEGERI yok, gereken degiskenler var", () => {
  assert.match(envEx, /^NODE_ENV=production$/m);
  for (const v of ["DATABASE_URL", "CREDENTIAL_KEY", "CHANNEL_KEY", "TRUST_PROXY", "ALLOWED_ORIGINS"]) assert.match(envEx, new RegExp(`^${v}=`, "m"), `${v} yok`);
  assert.ok(!/^ALERT_ALLOW_/m.test(envEx), "gelistirme bayraklari etkin olamaz");
  assert.match(envEx, /^CHANNEL_KEY=<[^>]+>$/m);   // yer tutucu, gercek anahtar degil
  assert.match(envEx, /^CREDENTIAL_KEY=<[^>]+>$/m);
  assert.match(envEx, /^TRUST_PROXY=127\.0\.0\.1$/m);
});
