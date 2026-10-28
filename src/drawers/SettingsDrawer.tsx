import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import {
  clearOpenrouterKey,
  getSettings,
  listOpenrouterModels,
  openrouterKeyStatus,
  saveOpenrouterKey,
  saveSetting,
  testLlm,
  testOllama,
} from "../lib/api";
import type { LlmModel, LlmSettings, OllamaModel } from "../lib/types";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { ModelPicker } from "../ui/ModelPicker";

type SettingsDrawerProps = {
  tell: (message: string) => void;
  dark: boolean;
  setDark: (dark: boolean) => void;
};

const SLOTS: { key: keyof LlmSettings; label: string; hint: string }[] = [
  { key: "default_model", label: "Default model", hint: "Used when a job has no model of its own" },
  { key: "drafter_model", label: "Email drafting", hint: "Writes personalized drafts for review" },
  { key: "classifier_model", label: "Reply classification", hint: "Judges replies in campaigns and the inbox" },
  { key: "style_model", label: "Style analysis", hint: "Learns your voice from past writing" },
];

export function SettingsDrawer({ tell, dark, setDark }: SettingsDrawerProps) {
  const [url, setUrl] = useState("http://127.0.0.1:11434");
  const [local, setLocal] = useState<OllamaModel[]>([]);
  const [catalog, setCatalog] = useState<LlmModel[]>([]);
  const [llm, setLlm] = useState<LlmSettings>({});
  const [key, setKey] = useState("");
  const [stored, setStored] = useState(false);
  const [busy, setBusy] = useState("");

  useEffect(() => {
    getSettings()
      .then((all) => {
        if (typeof all.ollama_url === "string" && all.ollama_url) setUrl(all.ollama_url);
        if (all.llm && typeof all.llm === "object") setLlm(all.llm as LlmSettings);
      })
      .catch(() => {});
    openrouterKeyStatus()
      .then((status) => setStored(status.stored))
      .catch(() => {});
    listOpenrouterModels()
      .then(setCatalog)
      .catch(() => {});
  }, []);

  const saveKey = async () => {
    if (!key.trim()) return;
    setBusy("key");
    try {
      await saveOpenrouterKey(key);
      setKey("");
      setStored(true);
      tell("OpenRouter key saved to the system vault");
    } catch (e) {
      tell(String(e));
    } finally {
      setBusy("");
    }
  };

  const forgetKey = async () => {
    try {
      await clearOpenrouterKey();
      setStored(false);
      tell("OpenRouter key removed from the vault");
    } catch (e) {
      tell(String(e));
    }
  };

  const refreshCatalog = async () => {
    setBusy("catalog");
    try {
      const models = await listOpenrouterModels(true);
      setCatalog(models);
      tell(`${models.length} OpenRouter models`);
    } catch (e) {
      tell(String(e));
    } finally {
      setBusy("");
    }
  };

  const saveModels = async () => {
    try {
      await saveSetting({ key: "llm", value: llm });
      tell("Model defaults saved");
    } catch (e) {
      tell(String(e));
    }
  };

  const test = async (model: string) => {
    if (!model.trim()) {
      tell("Choose a model first");
      return;
    }
    setBusy("test");
    try {
      const result = await testLlm(model);
      tell(`${result.model} replied in ${result.latency_ms} ms`);
    } catch (e) {
      tell(String(e));
    } finally {
      setBusy("");
    }
  };

  const testLocal = async () => {
    setBusy("ollama");
    try {
      const found = await testOllama(url);
      setLocal(found);
      await saveSetting({ key: "ollama_url", value: url });
      tell(`Connected — ${found.length} local model(s) found`);
    } catch (e) {
      setLocal([]);
      tell(String(e));
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="drawerform">
      <p>Settings are local. API keys go into your operating system's credential vault, never the database.</p>

      <section className="themes">
        <h3>Appearance</h3>
        <button className={!dark ? "picked" : ""} onClick={() => setDark(false)}>
          <Sun />Light
        </button>
        <button className={dark ? "picked" : ""} onClick={() => setDark(true)}>
          <Moon />Dark
        </button>
      </section>

      <hr />
      <h3>OpenRouter</h3>
      <p>Most models run through OpenRouter. One key covers every model in the catalog.</p>
      <label>
        API key {stored && <span className="storedtag">stored in vault</span>}
        <Input
          type="password"
          value={key}
          placeholder={stored ? "•••••••• replace saved key" : "sk-or-v1-…"}
          onChange={(e) => setKey(e.target.value)}
        />
      </label>
      <div className="settingsrow">
        <Button variant="ink" onClick={saveKey} disabled={busy === "key" || !key.trim()}>
          {busy === "key" ? "Saving…" : "Save key"}
        </Button>
        {stored && (
          <Button variant="ghost" onClick={forgetKey}>
            Remove key
          </Button>
        )}
        <Button variant="ghost" onClick={refreshCatalog} disabled={busy === "catalog"}>
          {busy === "catalog" ? "Refreshing…" : `Refresh catalog${catalog.length ? ` (${catalog.length})` : ""}`}
        </Button>
      </div>

      <hr />
      <h3>Models</h3>
      {SLOTS.map((slot) => (
        <label key={slot.key}>
          {slot.label}
          <ModelPicker
            value={llm[slot.key] ?? ""}
            onChange={(value) => setLlm((current) => ({ ...current, [slot.key]: value }))}
            catalog={catalog}
            local={local}
          />
          <small>{slot.hint}</small>
        </label>
      ))}
      <div className="settingsrow">
        <Button variant="ink" onClick={saveModels}>
          Save model defaults
        </Button>
        <Button variant="ghost" onClick={() => test(llm.default_model ?? "")} disabled={busy === "test"}>
          {busy === "test" ? "Testing…" : "Test connection"}
        </Button>
      </div>

      <hr />
      <h3>Local models (Ollama)</h3>
      <label>
        Ollama server URL
        <Input value={url} onChange={(e) => setUrl(e.target.value)} />
      </label>
      <Button variant="ink" onClick={testLocal} disabled={busy === "ollama"}>
        {busy === "ollama" ? "Testing…" : "Test & fetch local models"}
      </Button>
      {local.length > 0 && (
        <div className="modelchips">
          {local.map((m) => (
            <span key={m.name}>● {m.name}</span>
          ))}
        </div>
      )}

      <hr />
      <h3>Email account connection</h3>
      <p>Use a registered OAuth client. System-browser consent, not a browser cookie, grants provider API access.</p>
      <small>Register the redirect URI in the provider console before beginning the connection flow.</small>
    </div>
  );
}
