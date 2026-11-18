import { z } from "zod";

// Uretim CSP'si 'unsafe-eval' ICERMEZ: zod'un JIT derleyicisi (new Function) kapatilir. Bu modul main.tsx'te EN ILK import edilmelidir
// (protokol semalari import aninda olusur; ayar ondan once yapilmazsa zod yine Function("") yoklamasi yapar ve CSP ihlali raporlanir).
z.config({ jitless: true });
