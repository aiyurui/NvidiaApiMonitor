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
}

export type ModelStatus = "ok" | "down" | "untested";
