export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export function renderVariables(template: string, values: Record<string, string | undefined>): string {
  return template.replace(/{{\s*([\w]+)\s*}}/g, (_, key: string) => values[key] ?? "");
}
