// Lisans politikasi: GPL/AGPL/SSPL/bilinmeyen kabul edilmez. MPL-2.0 dosya duzeyi copyleft oldugu icin izinli.
const DENY = /(^|[^L])(A?GPL)|SSPL|BUSL|UNKNOWN|UNLICENSED|SEE LICENSE/i;

export function isAllowed(expr) {
  const s = (expr ?? "").trim();
  if (!s) return false;
  const inner = s.replace(/^\(|\)$/g, "");
  if (/\sOR\s/i.test(inner)) {
    return inner.split(/\sOR\s/i).some((part) => isAllowed(part));
  }
  if (/\sAND\s/i.test(inner)) {
    return inner.split(/\sAND\s/i).every((part) => isAllowed(part));
  }
  return !DENY.test(inner);
}
