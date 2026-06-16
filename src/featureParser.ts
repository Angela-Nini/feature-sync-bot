const triggerPatterns = [
  /已更新\s+(.+?)\s+功能支持情况/i,
  /同步\s+(.+?)\s+功能支持情况/i,
  /sync\s+(.+?)\s+(availability|feature availability)/i
];

export function parseFeatureName(text: string): string | null {
  const normalized = text
    .replace(/<at[^>]*>.*?<\/at>/g, "")
    .replace(/@\S+/g, "")
    .trim();

  for (const pattern of triggerPatterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) {
      return normalizeFeatureName(match[1]);
    }
  }

  return null;
}

export function parseConfirmationCode(text: string): string | null {
  const match = text.trim().match(/^(?:ok|okay|确认|yes|confirm)\s+([a-z0-9]{6})$/i);
  return match?.[1]?.toUpperCase() ?? null;
}

function normalizeFeatureName(input: string): string {
  return input
    .replace(/[“”"'`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
