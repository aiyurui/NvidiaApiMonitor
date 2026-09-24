import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    // 显式声明排除目录。
    // 起因：`dist/_verify/` 里曾留有一份解包验证用的源码副本，
    // 其中的 *.test.ts 被一并收集，测试数量翻倍（8 files/70 tests → 17/143），
    // 这种"影子副本"会掩盖真实失败，也会让计数失去意义。
    exclude: ["**/node_modules/**", "**/.next/**", "**/dist/**", "**/build/**"],
  },
});
