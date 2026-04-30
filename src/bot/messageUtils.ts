export function chunkTelegramMessage(text: string, maxLength: number): string[] {
  const normalized = text.trim();

  if (!normalized) {
    return ["I did not receive a response."];
  }

  if (normalized.length <= maxLength) {
    return [normalized];
  }

  const chunks: string[] = [];
  let remaining = normalized;

  while (remaining.length > maxLength) {
    const splitAt = findSplitPoint(remaining, maxLength);
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

function findSplitPoint(text: string, maxLength: number): number {
  const newline = text.lastIndexOf("\n", maxLength);
  if (newline > maxLength * 0.6) return newline;

  const space = text.lastIndexOf(" ", maxLength);
  if (space > maxLength * 0.6) return space;

  return maxLength;
}
