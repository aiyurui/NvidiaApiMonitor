export interface KeyCandidate {
  id: string;
  priority: number;
  lastUsedAt: Date | null;
  cooledUntil: Date | null;
  enabled: boolean;
}

export interface ScoringWeights {
  context: number; vision: number; tools: number; json: number;
  reasoning: number; code: number; multilingual: number;
  longContext: number; availability: number;
}

export interface RemoteModel {
  id: string;
  name?: string;
  description?: string | null;
  contextLength?: number | null;
  supportsVision?: boolean;
  supportsTools?: boolean;
  supportsJson?: boolean;
}

export interface ParsedSettings {
  syncIntervalHours: number;
  healthIntervalMin: number;
  defaultReasoning: boolean;
  filterKeywords: string[];
  blacklistModelIds: string[];
  scoringWeights: ScoringWeights;
  /** 入口密码是否已配置（只暴露开关，绝不外传哈希） */
  entryPasswordEnabled: boolean;
}

export type ModelStatus = "ok" | "down" | "untested";
