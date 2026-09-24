import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-guard";
import { decryptSecret } from "@/lib/crypto";
import { getSettings } from "@/lib/settings";
import { runHealthCheckForModel, type ChatMessage } from "@/lib/services/health-check";
import type { KeyCandidateWithSecret } from "@/lib/services/key-rotation";
import { prisma } from "@/lib/prisma";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const denied = await requireAdmin(); if (denied) return denied;
  const model = await prisma.model.findUnique({ where: { id: params.id } });
  if (!model) return NextResponse.json({ error: "not found" }, { status: 404 });

  const testCase = await prisma.testCase.findFirst({
    where: { enabled: true },
    orderBy: { createdAt: "asc" },
  });
  if (!testCase) {
    return NextResponse.json({ error: "no enabled test case" }, { status: 400 });
  }

  const keyRows = await prisma.apiKey.findMany({
    // 不按 cooledUntil 过滤：本项目不冻结 Key
    where: { enabled: true },
    orderBy: [{ priority: "desc" }, { lastUsedAt: "asc" }],
  });
  if (keyRows.length === 0) {
    return NextResponse.json({ error: "no available api key" }, { status: 400 });
  }
  const keys: Array<KeyCandidateWithSecret & { baseUrl: string }> = [];
  for (const k of keyRows) {
    try {
      keys.push({
        id: k.id,
        priority: k.priority,
        lastUsedAt: k.lastUsedAt,
        cooledUntil: k.cooledUntil,
        enabled: k.enabled,
        secret: decryptSecret(k.key),
        baseUrl: k.baseUrl,
      });
    } catch {
      return NextResponse.json({ error: "failed to decrypt api key" }, { status: 500 });
    }
  }

  const settings = await getSettings();

  let messages: ChatMessage[];
  try {
    const parsed: unknown = JSON.parse(testCase.messages);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    messages = parsed as ChatMessage[];
  } catch {
    return NextResponse.json({ error: "invalid test case messages" }, { status: 500 });
  }

  const attempt = await runHealthCheckForModel({
    baseUrl: keys[0].baseUrl,
    model: model.modelId,
    messages,
    maxTokens: testCase.maxTokens,
    temperature: testCase.temperature,
    reasoningEnabled: settings.defaultReasoning,
    keys,
  });

  const apiKeyId = attempt.apiKeyId ?? keys[0].id;
  if (attempt.success) {
    await prisma.healthCheck.create({
      data: {
        modelId: model.id,
        apiKeyId,
        testCaseId: testCase.id,
        ttftMs: attempt.ttftMs,
        latencyMs: attempt.latencyMs,
        tokensPerSec: attempt.tokensPerSec,
        outputTokens: attempt.outputTokens,
        success: true,
      },
    });
  } else {
    await prisma.healthCheck.create({
      data: {
        modelId: model.id,
        apiKeyId,
        testCaseId: testCase.id,
        ttftMs: 0,
        latencyMs: 0,
        tokensPerSec: 0,
        outputTokens: 0,
        success: false,
        errorMessage: attempt.errorMessage ?? "health check failed",
      },
    });
  }

  return NextResponse.json(attempt);
}
