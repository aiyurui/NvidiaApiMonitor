import type { ParsedSettings, ScoringWeights } from "@/types";
import { prisma } from "@/lib/prisma";

export const DEFAULT_WEIGHTS: ScoringWeights = {
  context: 1, vision: 1, tools: 1, json: 1, reasoning: 1,
  code: 0.5, multilingual: 0.5, longContext: 0.5, availability: 1.5,
};

const SCORE_KEYS = ["context", "vision", "tools", "json", "reasoning", "code", "multilingual", "longContext", "availability"] as const;

function sanitizeWeights(input: unknown, fallback: ScoringWeights = DEFAULT_WEIGHTS): ScoringWeights {
  const base = { ...fallback };
  if (typeof input !== "object" || input === null) return base;
  const src = input as Record<string, unknown>;
  for (const k of SCORE_KEYS) {
    const v = src[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) base[k] = v;
  }
  return base;
}

interface SettingsRow {
  id: string; syncIntervalHours: number; healthIntervalMin: number;
  defaultReasoning: boolean; filterKeywords: string;
  blacklistModelIds: string; scoringWeights: string; updatedAt: Date;
}

function parseStringArray(raw: string, fallback: string[]): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [...fallback];
  } catch {
    return [...fallback];
  }
}

const DEFAULT_KEYWORDS = ["safety", "moderation", "guard", "filter", "content-safety", "llama-guard", "nemo-guard"];

export function parseSettings(row: SettingsRow): ParsedSettings {
  let weights: ScoringWeights = { ...DEFAULT_WEIGHTS };
  try {
    weights = sanitizeWeights(JSON.parse(row.scoringWeights), DEFAULT_WEIGHTS);
  } catch {
    weights = { ...DEFAULT_WEIGHTS };
  }
  return {
    syncIntervalHours: row.syncIntervalHours,
    healthIntervalMin: row.healthIntervalMin,
    defaultReasoning: row.defaultReasoning,
    filterKeywords: parseStringArray(row.filterKeywords, DEFAULT_KEYWORDS),
    blacklistModelIds: parseStringArray(row.blacklistModelIds, []),
    scoringWeights: weights,
  };
}

export async function getSettings(): Promise<ParsedSettings> {
  // 缺失时自动创建默认单例，避免 settings 表为空导致调度器启动即崩（findUniqueOrThrow 的坑）
  const row = await prisma.settings.upsert({
    where: { id: "singleton" },
    update: {},
    create: {
      id: "singleton",
      syncIntervalHours: 6,
      healthIntervalMin: 30,
      defaultReasoning: false,
      filterKeywords: JSON.stringify(DEFAULT_KEYWORDS),
      blacklistModelIds: "[]",
      scoringWeights: JSON.stringify(DEFAULT_WEIGHTS),
    },
  });
  return parseSettings(row);
}
