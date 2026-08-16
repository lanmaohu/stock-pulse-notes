export function jsonStringArray(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function optionalString(value: string | null | undefined) {
  return value || undefined;
}

export function sqliteBoolean(value: number) {
  return Boolean(value);
}
