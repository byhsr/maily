import type { LlmModel } from "./types";

export type Provider = "openrouter" | "ollama";

/** Model strings are `<provider>:<model>`; a bare id means OpenRouter. */
export function providerOf(model: string): Provider {
  return model.startsWith("ollama:") ? "ollama" : "openrouter";
}

export function modelName(model: string): string {
  return model.startsWith("ollama:") ? model.slice("ollama:".length) : model.replace(/^openrouter:/, "");
}

export function withProvider(model: string, provider: Provider): string {
  const bare = modelName(model);
  return provider === "ollama" ? `ollama:${bare}` : bare;
}

function perMillion(value: string | number | undefined): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n * 1_000_000 : null;
}

export function priceLabel(model: LlmModel): string {
  const prompt = perMillion(model.prompt_price);
  const completion = perMillion(model.completion_price);
  if (prompt === null || completion === null) return "";
  if (prompt === 0 && completion === 0) return "free";
  return `$${prompt.toFixed(2)} in / $${completion.toFixed(2)} out per Mtok`;
}

export function contextLabel(model: LlmModel): string {
  return model.context_length ? `${Math.round(model.context_length / 1000)}k context` : "";
}
