/**
 * 全局入口密码的签名 Cookie 令牌。
 *
 * 设计要点：
 * - 令牌 = `v1.` + HMAC-SHA256(密钥, `entry:<密码哈希前12字符>`)。
 *   把**密码哈希的前缀**绑进载荷：管理员修改/重设入口密码后哈希前缀变化，
 *   旧令牌立即失效 —— 不需要服务端存任何会话状态。
 * - HMAC 密钥复用 NEXTAUTH_SECRET（与 next-auth 同源，不新增需要管理的密钥）。
 * - 用 globalThis.crypto.subtle（Web Crypto）：Node 18+ 与 Edge 运行时都原生可用，
 *   不引入 node:crypto 依赖（Edge 不支持）。
 */

export const ENTRY_COOKIE_NAME = "nv-entry-key";

/** 绑进令牌载荷的 bcrypt 哈希前缀长度 */
export const ENTRY_HASH_PREFIX_LEN = 12;

const TOKEN_PREFIX = "v1.";

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(payload: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await globalThis.crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return toHex(sig);
}

export async function signEntryToken(
  passwordHashPrefix: string,
  secret: string,
): Promise<string> {
  return TOKEN_PREFIX + (await hmacHex(`entry:${passwordHashPrefix}`, secret));
}

/** 常数时间字符串比较，避免逐字节短路泄漏 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyEntryToken(
  token: string,
  passwordHashPrefix: string,
  secret: string,
): Promise<boolean> {
  if (!token.startsWith(TOKEN_PREFIX)) return false;
  const sig = token.slice(TOKEN_PREFIX.length);
  // 严格 64 位小写 hex，杜绝把任意输入喂给 hmacHex 造成的不必要开销
  if (!/^[0-9a-f]{64}$/.test(sig)) return false;
  const expected = await hmacHex(`entry:${passwordHashPrefix}`, secret);
  return timingSafeEqual(sig, expected);
}

/** dev / 未设 NEXTAUTH_SECRET 时的回退密钥（生产环境由入口脚本强制要求真密钥） */
export function entryTokenSecret(): string {
  return process.env.NEXTAUTH_SECRET ?? "dev-entry-secret-nvidia-api-monitor";
}
