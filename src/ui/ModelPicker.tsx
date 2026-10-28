import { useId } from "react";
import { contextLabel, modelName, priceLabel, providerOf } from "../lib/models";
import type { LlmModel, OllamaModel } from "../lib/types";
import { Input } from "./Input";

type ModelPickerProps = {
  value: string;
  onChange: (value: string) => void;
  catalog: LlmModel[];
  local?: OllamaModel[];
  placeholder?: string;
};

/**
 * Free-text model field backed by the OpenRouter catalog and locally installed
 * Ollama models, so every picker in the app searches and renders the same way.
 */
export function ModelPicker({ value, onChange, catalog, local = [], placeholder }: ModelPickerProps) {
  const listId = useId();
  const match = catalog.find((model) => model.id === modelName(value));

  const detail = match
    ? [priceLabel(match), contextLabel(match)].filter(Boolean).join(" · ")
    : providerOf(value) === "ollama"
      ? "Local Ollama model"
      : "OpenRouter model id";

  return (
    <div className="modelpick">
      <Input
        list={listId}
        value={value}
        spellCheck={false}
        placeholder={placeholder ?? "vendor/model"}
        onChange={(e) => onChange(e.target.value)}
      />
      <datalist id={listId}>
        {local.map((model) => (
          <option key={`ollama:${model.name}`} value={`ollama:${model.name}`} />
        ))}
        {catalog.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name ?? model.id}
          </option>
        ))}
      </datalist>
      <small>{value.trim() ? detail : "Not set — falls back to the default model"}</small>
    </div>
  );
}
