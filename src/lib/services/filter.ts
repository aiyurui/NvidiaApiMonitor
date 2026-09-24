export interface Classification { specialized: boolean; tags: string[]; }

export function classifyModel(modelId: string, keywords: string[], blacklist: string[]): Classification {
  const lower = modelId.toLowerCase();
  const tags = keywords
    .map((k) => k.toLowerCase())
    .filter((k) => k.length > 0 && lower.includes(k));
  const blacklisted = blacklist.some((b) => b.toLowerCase() === lower);
  if (blacklisted && !tags.includes("blacklist")) tags.push("blacklist");
  return { specialized: tags.length > 0, tags };
}

export function serializeTags(tags: string[]): string {
  return JSON.stringify(tags);
}

export function deserializeTags(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
