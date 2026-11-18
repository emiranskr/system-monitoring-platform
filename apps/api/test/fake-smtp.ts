import net from "node:net";
import tls from "node:tls";
import type { AddressInfo } from "node:net";

export interface SmtpMessage { from: string; to: string[]; data: string; authUser?: string; authPass?: string }
export interface FakeSmtpOptions {
  /** Implicit TLS (465 tarzi): tls.createServer. */
  tls?: { key: string; cert: string };
  user?: string;
  pass?: string;
  /** Davranis: ok | authFail (535) | rcptTemp (451) | rcptPerm (550) | hang (selamlama yok) */
  mode?: "ok" | "authFail" | "rcptTemp" | "rcptPerm" | "hang";
}

/** Test icin asgari SMTP sunucusu (selamlama, EHLO, AUTH PLAIN/LOGIN, MAIL, RCPT, DATA, QUIT). STARTTLS ilan etmez. */
export class FakeSmtp {
  messages: SmtpMessage[] = [];
  /** Alinan HAM satirlar (parola sizintisi testleri icin degil; sunucu tarafi gozlem). */
  connections = 0;
  mode: NonNullable<FakeSmtpOptions["mode"]>;
  private server: net.Server;
  port = 0;

  constructor(private readonly opts: FakeSmtpOptions = {}) {
    this.mode = opts.mode ?? "ok";
    const onConn = (sock: net.Socket) => this.handle(sock);
    this.server = opts.tls ? tls.createServer({ key: opts.tls.key, cert: opts.tls.cert }, onConn) : net.createServer(onConn);
  }

  async start(host = "127.0.0.1"): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, host, r));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    (this.server as net.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise((r) => this.server.close(r));
  }

  private handle(sock: net.Socket): void {
    this.connections++;
    sock.on("error", () => undefined);
    if (this.mode === "hang") return;
    const send = (s: string) => sock.write(s + "\r\n");
    let buf = "";
    let inData = false;
    let dataBuf = "";
    let from = "";
    let to: string[] = [];
    let authUser: string | undefined;
    let authPass: string | undefined;
    let loginStep: "user" | "pass" | null = null;
    send("220 fake.smtp ESMTP");
    sock.on("data", (chunk) => {
      buf += chunk.toString("latin1");
      for (;;) {
        if (inData) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end < 0) { dataBuf += buf; buf = buf.slice(-4); dataBuf = dataBuf.slice(0, dataBuf.length - 4 + 0); return; }
          dataBuf += buf.slice(0, end);
          buf = buf.slice(end + 5);
          inData = false;
          this.messages.push({ from, to, data: dataBuf, authUser, authPass });
          dataBuf = "";
          send("250 2.0.0 kabul edildi");
          continue;
        }
        const i = buf.indexOf("\r\n");
        if (i < 0) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (loginStep === "user") { authUser = Buffer.from(line, "base64").toString(); loginStep = "pass"; send("334 UGFzc3dvcmQ6"); continue; }
        if (loginStep === "pass") {
          authPass = Buffer.from(line, "base64").toString();
          loginStep = null;
          this.finishAuth(send, authUser, authPass);
          if (this.mode === "authFail" || !this.credOk(authUser, authPass)) { authUser = undefined; authPass = undefined; }
          continue;
        }
        const up = line.toUpperCase();
        if (up.startsWith("EHLO") || up.startsWith("HELO")) { sock.write("250-fake.smtp\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n"); }
        else if (up.startsWith("AUTH PLAIN")) {
          const parts = Buffer.from(line.slice(11).trim(), "base64").toString().split("\0");
          authUser = parts[1]; authPass = parts[2];
          this.finishAuth(send, authUser, authPass);
          if (this.mode === "authFail" || !this.credOk(authUser, authPass)) { authUser = undefined; authPass = undefined; }
        }
        else if (up.startsWith("AUTH LOGIN")) { loginStep = "user"; send("334 VXNlcm5hbWU6"); }
        else if (up.startsWith("MAIL FROM")) { from = /<([^>]*)>/.exec(line)?.[1] ?? ""; to = []; send("250 2.1.0 tamam"); }
        else if (up.startsWith("RCPT TO")) {
          if (this.mode === "rcptTemp") send("451 4.3.0 gecici hata");
          else if (this.mode === "rcptPerm") send("550 5.1.1 alici yok");
          else { to.push(/<([^>]*)>/.exec(line)?.[1] ?? ""); send("250 2.1.5 tamam"); }
        }
        else if (up === "DATA") { inData = true; send("354 gonder"); }
        else if (up === "QUIT") { send("221 gule gule"); sock.end(); }
        else send("250 tamam");
      }
    });
  }

  private credOk(u?: string, p?: string): boolean { return !this.opts.user || (u === this.opts.user && p === this.opts.pass); }
  private finishAuth(send: (s: string) => void, u?: string, p?: string): void {
    if (this.mode === "authFail" || !this.credOk(u, p)) send("535 5.7.8 kimlik dogrulama basarisiz");
    else send("235 2.7.0 kabul edildi");
  }
}
