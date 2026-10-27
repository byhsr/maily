export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

const VARIABLE = /{{\s*([\w.]+)(?:\s*\|\s*([^}]*))?\s*}}/g;

export function templateVariables(template: string): string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(VARIABLE)) found.add(match[1]);
  return [...found];
}

export function renderVariables(template: string, values: Record<string, string | undefined>): string {
  return template.replace(VARIABLE, (_, key: string, fallback?: string) => {
    const value = values[key];
    return value !== undefined && value !== "" ? value : fallback ?? "";
  });
}

/** Variables that have neither a value nor an inline fallback (`{{name|default}}`). */
export function missingVariables(template: string, values: Record<string, string | undefined>): string[] {
  const missing = new Set<string>();
  for (const match of template.matchAll(VARIABLE)) {
    const key = match[1];
    const fallback = match[2];
    const value = values[key];
    if ((value === undefined || value === "") && fallback === undefined) missing.add(key);
  }
  return [...missing];
}
