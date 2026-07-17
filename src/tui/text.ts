export function stripFilePrefix(error: string, file: string): string {
  return error.startsWith(file) ? error.slice(file.length).replace(/^[,:]\s*/, "") : error;
}

export function truncate(text: string, max = 80): string {
  if (text.length <= max) return text;
  if (max <= 0) return "";
  if (max === 1) return "…";
  return `${text.slice(0, max - 1)}…`;
}
