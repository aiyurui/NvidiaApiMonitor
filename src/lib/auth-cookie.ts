/**
 * 固定的鉴权 Cookie 名称。
 *
 * 为什么需要它：
 * NextAuth 默认会根据「请求是否走 HTTPS」自动给会话 Cookie 加 `__Secure-` 前缀
 * （`next-auth.session-token`  ↔  `__Secure-next-auth.session-token`）。
 * 但本项目经 nginx 反代部署时，**Node 路由处理器**看到的是 `X-Forwarded-Proto: https`
 * （域名走 HTTPS），于是写成带前缀的 Secure Cookie；而 **Edge 中间件** `getToken`
 * 看到的是 nginx→应用 的内部 HTTP 连接，去找不带前缀的名字 → 找不到 → 误判未登录 →
 * 跳登录页，登录页又因能读到 Cookie 跳回后台 → 死循环。
 *
 * 用固定的、不带前缀的名称 + `secure: false`，让两侧永远用同一个名字，
 * 且浏览器在 HTTP 与 HTTPS 下都会发送该 Cookie，IP 直连与域名反代都能正常工作。
 */
export const SESSION_COOKIE_NAME = "next-auth.session-token";
export const CSRF_COOKIE_NAME = "next-auth.csrf-token";
export const CALLBACK_COOKIE_NAME = "next-auth.callback-url";
