// seed 脚本：创建管理员/默认设置/默认测试用例（幂等 upsert）
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

// 直接用默认 PrismaClient：DATABASE_URL="file:./dev.db" 相对 schema 目录解析为 prisma/dev.db，
// 与 dev server / prisma CLI 完全一致，避免手写路径造成的 db 文件错配。
const prisma = new PrismaClient();

async function main() {
  const email = process.env.ADMIN_EMAIL ?? "admin@example.com";

  // 幂等 + 不误伤：只有在「还没有任何账号」或显式 SEED_FORCE=1 时才写管理员。
  // 否则重复执行会把用户在后台改过的密码重置回 .env 里的初始值。
  const existingUsers = await prisma.user.count();
  if (existingUsers === 0 || process.env.SEED_FORCE === "1") {
    const password = process.env.ADMIN_PASSWORD_HASH ?? "";
    if (!password) throw new Error("ADMIN_PASSWORD_HASH is required for seeding");

    await prisma.user.upsert({
      where: { email },
      update: { password },
      create: { email, password, role: "ADMIN" },
    });
  } else {
    console.log(`已有 ${existingUsers} 个账号，跳过管理员写入（如需强制覆盖密码：SEED_FORCE=1）`);
  }

  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
  });

  await prisma.testCase.upsert({
    where: { id: "default-brief" },
    update: {},
    create: {
      id: "default-brief",
      name: "默认简短问答",
      description: "基础连通性与延迟测试",
      messages: JSON.stringify([{ role: "user", content: "Hello, please respond briefly." }]),
      maxTokens: 50,
      temperature: 0.7,
      enabled: true,
    },
  });

  const MANUAL_SCORES: Array<[string, number]> = [
    ["01-ai/yi-large", 81],
    ["adept/fuyu-8b", 52],
    ["ai21labs/jamba-1.5-large-instruct", 79],
    ["aisingapore/sea-lion-7b-instruct", 51],
    ["bigcode/starcoder2-15b", 72],
    ["databricks/dbrx-instruct", 81],
    ["deepseek-ai/deepseek-coder-6.7b-instruct", 68],
    ["deepseek-ai/deepseek-v4-flash-0731", 95],
    ["google/codegemma-1.1-7b", 64],
    ["google/codegemma-7b", 65],
    ["google/deplot", 75],
    ["google/diffusiongemma-26b-a4b-it", 78],
    ["google/gemma-2b", 54],
    ["google/gemma-3-12b-it", 75],
    ["google/gemma-3-4b-it", 69],
    ["google/gemma-4-31b-it", 80],
    ["google/recurrentgemma-2b", 58],
    ["ibm/granite-3.0-3b-a800m-instruct", 62],
    ["ibm/granite-3.0-8b-instruct", 66],
    ["ibm/granite-34b-code-instruct", 76],
    ["ibm/granite-8b-code-instruct", 73],
    ["meta/codellama-70b", 82],
    ["meta/llama-3.2-11b-vision-instruct", 79],
    ["meta/llama-3.2-90b-vision-instruct", 84],
    ["meta/llama2-70b", 63],
    ["meta/muse-glimmer-30b", 79],
    ["microsoft/kosmos-2", 46],
    ["microsoft/phi-3-vision-128k-instruct", 50],
    ["microsoft/phi-3.5-moe-instruct", 77],
    ["mistralai/codestral-22b-instruct-v0.1", 83],
    ["mistralai/mistral-7b-instruct-v0.3", 68],
    ["mistralai/mistral-large", 87],
    ["mistralai/mistral-large-2-instruct", 89],
    ["mistralai/mistral-nemotron", 80],
    ["mistralai/mixtral-8x22b-v0.1", 83],
    ["moonshotai/kimi-k2.6", 88],
    ["moonshotai/kimi-k3", 96],
    ["nv-mistralai/mistral-nemo-12b-instruct", 72],
    ["nvidia/ai-synthetic-video-detector", 78],
    ["nvidia/cosmos-reason2-8b", 81],
    ["nvidia/embed-qa-4", 90],
    ["nvidia/ising-calibration-1.5-31b", 76],
    ["nvidia/llama-3.1-nemotron-51b-instruct", 84],
    ["nvidia/llama-3.1-nemotron-70b-instruct", 86],
    ["nvidia/llama-3.1-nemotron-ultra-253b-v1", 87],
    ["nvidia/llama-3.2-nemoretriever-1b-vlm-embed-v1", 88],
    ["nvidia/llama-3.2-nv-embedqa-1b-v1", 87],
    ["nvidia/llama-nemotron-embed-vl-1b-v2", 90],
    ["nvidia/llama3-chatqa-1.5-70b", 78],
    ["nvidia/mistral-nemo-minitron-8b-8k-instruct", 72],
    ["nvidia/nemotron-3-embed-1b", 88],
    ["nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", 92],
    ["nvidia/nemotron-3-super-120b-a12b", 94],
    ["nvidia/nemotron-3-ultra-550b-a55b", 95],
    ["nvidia/nemotron-3.5-lightning-30b-a3b", 93],
    ["nvidia/nemotron-4-340b-instruct", 85],
    ["nvidia/nemotron-nano-3-30b-a3b", 92],
    ["nvidia/nemotron-parse", 73],
    ["nvidia/nemotron-parse-2.0", 78],
    ["nvidia/neva-22b", 45],
    ["nvidia/nv-embedqa-mistral-7b-v2", 93],
    ["nvidia/nvclip", 89],
    ["nvidia/riva-translate-4b-instruct", 75],
    ["nvidia/riva-translate-4b-instruct-v1.1", 77],
    ["nvidia/riva-translate-4b-instruct-v2", 80],
    ["nvidia/vila", 44],
    ["openai/gpt-oss-20b", 91],
    ["poolside/laguna-xs-2.1", 89],
    ["snowflake/arctic-embed-l", 92],
    ["writer/palmyra-creative-122b", 86],
    ["writer/palmyra-fin-70b-32k", 85],
    ["writer/palmyra-med-70b", 83],
    ["writer/palmyra-med-70b-32k", 84],
    ["z-ai/glm-5.3", 97],
    ["z-ai/glm-5.3-flash", 91],
    ["zyphra/zamba2-7b-instruct", 67],
  ];
  for (const [modelId, score] of MANUAL_SCORES) {
    await prisma.manualScore.upsert({
      where: { modelId },
      update: {},
      create: { modelId, score },
    });
  }

  console.log("seed ok");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
