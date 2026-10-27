import { Moon, Sun } from "lucide-react";
import { useState } from "react";
import { saveSetting, testOllama } from "../lib/api";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";

type SettingsDrawerProps = {
  tell: (message: string) => void;
  dark: boolean;
  setDark: (dark: boolean) => void;
};

export function SettingsDrawer({ tell, dark, setDark }: SettingsDrawerProps) {
  const [url, setUrl] = useState("http://127.0.0.1:11434");
  const [models, setModels] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);

  const test = async () => {
    setBusy(true);
    try {
      const found = await testOllama(url);
      setModels(found);
      await saveSetting({ key: "ollama_url", value: url });
      tell(`Connected — ${found.length} model(s) found`);
    } catch (e) {
      setModels([]);
      tell(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="drawerform">
      <p>Settings are local. Provider/API tokens use your operating-system credential vault.</p>
      <section className="themes">
        <h3>Appearance</h3>
        <button className={!dark ? "picked" : ""} onClick={() => setDark(false)}>
          <Sun />Light
        </button>
        <button className={dark ? "picked" : ""} onClick={() => setDark(true)}>
          <Moon />Dark
        </button>
      </section>
      <label>
        Ollama server URL
        <Input value={url} onChange={(e) => setUrl(e.target.value)} />
      </label>
      <Button variant="ink" onClick={test} disabled={busy}>
        {busy ? "Testing…" : "Test & fetch local models"}
      </Button>
      {models.length > 0 && (
        <div className="modelchips">
          {models.map((m) => (
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
