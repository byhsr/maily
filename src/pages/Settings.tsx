import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { ChevronDown, ChevronRight, Copy, Eye, EyeOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  accountPermissions,
  awaitOauthRedirect,
  clearOpenrouterKey,
  disconnectAccount,
  finishOauth,
  getSettings,
  listAccounts,
  listOpenrouterModels,
  oauthStatus,
  openrouterKeyStatus,
  revealOpenrouterKey,
  saveOauthClient,
  saveOpenrouterKey,
  saveSetting,
  setAccountLimits,
  startOauth,
  syncInbox,
  testLlm,
  testOllama,
} from "../lib/api";
import { whenLabel } from "../lib/agents";
import type { Account, LlmModel, LlmSettings, OllamaModel } from "../lib/types";
import { checkForUpdate, installUpdate, type UpdateState } from "../lib/updates";
import { Button } from "../ui/Button";
import { Confirm } from "../ui/Confirm";
import { Input } from "../ui/Input";
import { ModelPicker } from "../ui/ModelPicker";
import { PageHeader } from "../ui/PageHeader";
import { Select, type SelectOption } from "../ui/Select";

type Section = "workspace" | "accounts" | "models" | "limits" | "updates" | "danger";

const SECTIONS: { key: Section; label: string }[] = [
  { key: "workspace", label: "General" },
  { key: "accounts", label: "Email accounts" },
  { key: "models", label: "AI models" },
  { key: "limits", label: "Sending limits" },
  { key: "updates", label: "Updates" },
  { key: "danger", label: "Danger zone" },
];

/** Mirrors the constant in Rust; used until the backend reports its own. */
const DEFAULT_REDIRECT_URI = "http://127.0.0.1:42813/callback";

/** Mirrors `DEFAULT_POLL_SECONDS` in Rust. Never is a real choice: a machine on a metered
    connection should not reach out on its own. */
const DEFAULT_POLL_SECONDS = 300;
const POLL_CHOICES: SelectOption[] = [
  { value: "0", label: "Never" },
  { value: "60", label: "Every minute" },
  { value: "120", label: "Every 2 minutes" },
  { value: "300", label: "Every 5 minutes" },
  { value: "900", label: "Every 15 minutes" },
];

type SettingsProps = {
  tell: (message: string) => void;
  workspace: string;
  onWorkspaceChange: (name: string) => void;
  /** Which section to show; the sidebar's account row lands on "accounts". */
  section?: string;
  /** Called after an account is connected or removed, so the sidebar can refresh. */
  onAccountsChange?: () => void;
};

const SLOTS: { key: keyof LlmSettings; label: string; hint: string }[] = [
  { key: "default_model", label: "Default model", hint: "Used when a job has no model of its own" },
  { key: "drafter_model", label: "Email drafting", hint: "Writes personalized drafts for review" },
  { key: "classifier_model", label: "Reply classification", hint: "Judges replies in campaigns and the inbox" },
  { key: "style_model", label: "Style analysis", hint: "Learns your voice from past writing" },
];

/** The request a browser session will complete; held in memory, never persisted. */
type PendingOAuth = {
  provider: "gmail" | "microsoft";
  clientId: string;
  clientSecret: string | null;
  redirectUri: string;
  state: string;
  /** The consent link, kept so it can be reopened if the browser does not appear. */
  authorize: string;
};

/** The loopback port a provider will redirect to, taken from the registered URI. */
function redirectPort(uri: string): number {
  try {
    const url = new URL(uri);
    if (url.port) return Number(url.port);
    return url.protocol === "https:" ? 443 : 80;
  } catch {
    return 42813;
  }
}

export function Settings({ tell, workspace, onWorkspaceChange, section = "accounts", onAccountsChange }: SettingsProps) {
  const [tab, setTab] = useState<Section>(
    () => (SECTIONS.some((entry) => entry.key === section) ? (section as Section) : "accounts"),
  );

  // The sidebar can point at a section while Settings is already the open page.
  useEffect(() => {
    if (SECTIONS.some((entry) => entry.key === section)) setTab(section as Section);
  }, [section]);

  const [name, setName] = useState(workspace);
  const [url, setUrl] = useState("http://127.0.0.1:11434");
  const [local, setLocal] = useState<OllamaModel[]>([]);
  const [catalog, setCatalog] = useState<LlmModel[]>([]);
  const [llm, setLlm] = useState<LlmSettings>({});
  const [key, setKey] = useState("");
  const [stored, setStored] = useState(false);
  const [revealed, setRevealed] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState("");

  const [accounts, setAccounts] = useState<Account[]>([]);
  /** Per account: what its token is allowed to do. Missing until it has been asked. */
  const [permissions, setPermissions] = useState<Record<string, { can_send: boolean; scopes: string[] }>>({});
  const [poll, setPoll] = useState(String(DEFAULT_POLL_SECONDS));
  const [provider, setProvider] = useState<"gmail" | "microsoft">("gmail");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [redirectUri, setRedirectUri] = useState(DEFAULT_REDIRECT_URI);
  const [pending, setPending] = useState<PendingOAuth | null>(null);
  const [pasted, setPasted] = useState("");
  const [disconnecting, setDisconnecting] = useState<Account | null>(null);
  const [ready, setReady] = useState<Record<string, boolean>>({});
  const [advanced, setAdvanced] = useState(false);
  /** The last connect failure, kept on screen — a toast disappears before it is read. */
  const [connectError, setConnectError] = useState("");
  const completed = useRef(false);

  /** The version this build reports, and the state of the update check behind the Updates tab. */
  const [version, setVersion] = useState("");
  const [update, setUpdate] = useState<UpdateState>({ kind: "idle" });
  const [updating, setUpdating] = useState(false);
  const [percent, setPercent] = useState<number | null>(null);

  useEffect(() => setName(workspace), [workspace]);

  const loadOauth = () =>
    oauthStatus()
      .then((status) => {
        setReady(status.providers);
        if (status.redirect_uri) setRedirectUri(status.redirect_uri);
        // Nothing configured yet: show the one-time setup rather than dead buttons.
        if (!status.providers.gmail && !status.providers.microsoft) setAdvanced(true);
      })
      // Never swallow this: a failure here is why Connect appears to do nothing.
      .catch((e) => tell(`Could not read the OAuth setup: ${String(e)}`));

  const loadAccounts = () =>
    listAccounts()
      .then((list) => {
        setAccounts(list);
        onAccountsChange?.();
        // A token can be granted less than it asked for, and the provider only admits it
        // with a bare 403 on the first send. Ask up front so it is visible before then.
        for (const account of list) {
          accountPermissions(account.id)
            .then((found) => setPermissions((current) => ({ ...current, [account.id]: found })))
            .catch(() => {});
        }
      })
      .catch((e) => tell(String(e)));

  const savePoll = async (seconds: string) => {
    setPoll(seconds);
    try {
      await saveSetting({ key: "inbox_poll_seconds", value: Number(seconds) });
      const choice = POLL_CHOICES.find((option) => option.value === seconds);
      tell(Number(seconds) > 0 ? `Checking for new mail, ${choice?.label.toLowerCase()}` : "Automatic checking is off");
    } catch (e) {
      tell(String(e));
    }
  };

  /** Reads every account now, for when waiting is not wanted. */
  const checkNow = async () => {
    setBusy("sync");
    try {
      const added = await syncInbox();
      tell(added ? `${added} new message${added === 1 ? "" : "s"}` : "Already up to date");
      await loadAccounts();
    } catch (e) {
      tell(String(e));
    } finally {
      setBusy("");
    }
  };

  /** Lists what is actually installed so every model picker offers real choices. */
  const fetchLocal = async (base: string) => {
    try {
      setLocal(await testOllama(base));
    } catch {
      setLocal([]);
    }
  };

  useEffect(() => {
    getSettings()
      .then((all) => {
        const base =
          typeof all.ollama_url === "string" && all.ollama_url ? all.ollama_url : "http://127.0.0.1:11434";
        setUrl(base);
        if (all.llm && typeof all.llm === "object") setLlm(all.llm as LlmSettings);
        if (typeof all.inbox_poll_seconds === "number") setPoll(String(all.inbox_poll_seconds));
        fetchLocal(base);
      })
      .catch(() => {});
    openrouterKeyStatus()
      .then((status) => setStored(status.stored))
      .catch(() => {});
    listOpenrouterModels()
      .then(setCatalog)
      .catch(() => {});
    loadAccounts();
    loadOauth();
    // Asked of the running build, so the Updates tab cannot claim a version it is not.
    getVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);

  /* ---------- Workspace ---------- */

  const saveWorkspaceName = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || trimmed === workspace) return;
    // The shell owns the rename: it is the one that knows which workspace is open.
    onWorkspaceChange(trimmed);
    tell("Workspace renamed");
  };

  /* ---------- AI models ---------- */

  const saveKey = async () => {
    if (!key.trim()) return;
    setBusy("key");
    try {
      await saveOpenrouterKey(key);
      setKey("");
      setRevealed("");
      setShowKey(false);
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
      setRevealed("");
      setShowKey(false);
      tell("OpenRouter key removed from the vault");
    } catch (e) {
      tell(String(e));
    }
  };

  const toggleKey = async () => {
    if (showKey) {
      setShowKey(false);
      return;
    }
    try {
      if (!revealed) setRevealed(await revealOpenrouterKey());
      setShowKey(true);
    } catch (e) {
      tell(String(e));
    }
  };

  const copyKey = async () => {
    try {
      const value = revealed || (await revealOpenrouterKey());
      setRevealed(value);
      await navigator.clipboard.writeText(value);
      tell("API key copied");
    } catch (e) {
      tell(`Could not copy: ${String(e)}`);
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

  /** Makes an installed Ollama model the default, and saves it straight away. */
  const pickLocalAsDefault = async (modelName: string) => {
    const next = { ...llm, default_model: `ollama:${modelName}` };
    setLlm(next);
    try {
      await saveSetting({ key: "llm", value: next });
      tell(`${modelName} is now the default model`);
    } catch (e) {
      tell(String(e));
    }
  };

  /* ---------- Sending limits ---------- */

  const saveLimits = async (account: Account, daily: string, hourly: string) => {
    const nextDaily = Number(daily) || account.daily_limit;
    const nextHourly = Number(hourly) || account.hourly_limit;
    if (nextDaily === account.daily_limit && nextHourly === account.hourly_limit) return;
    try {
      await setAccountLimits(account.id, nextDaily, nextHourly);
      await loadAccounts();
      tell(`Limits updated for ${account.email}`);
    } catch (e) {
      tell(String(e));
    }
  };

  /* ---------- Accounts ---------- */

  /** Exchanges a returned code for a token and stores the new account. */
  const complete = async (request: PendingOAuth, code: string, state: string) => {
    setBusy("connect");
    try {
      const result = await finishOauth({
        provider: request.provider,
        code,
        state,
        client_id: request.clientId || null,
        client_secret: request.clientSecret,
        redirect_uri: request.redirectUri,
      });
      completed.current = true;
      setConnectError("");
      setPending(null);
      setClientSecret("");
      setPasted("");
      tell(`Connected ${result.email}`);
      await loadAccounts();
    } catch (e) {
      // Keep it visible: the browser has already said "received", so this is the only
      // place the real reason for a failed connection shows up.
      setConnectError(String(e));
      tell(String(e));
    } finally {
      setBusy("");
    }
  };

  /**
   * Opens the provider's consent page and waits for the loopback redirect. With no
   * client id the app's own saved OAuth client is used, so the caller just picks a
   * provider and the browser does the rest.
   */
  const beginConnection = async (
    target: "gmail" | "microsoft",
    useClientId = "",
    useClientSecret = "",
    useRedirectUri = redirectUri || DEFAULT_REDIRECT_URI,
  ) => {
    const id = useClientId.trim();
    const uri = useRedirectUri.trim();
    if (!id && !ready[target]) {
      tell(`Add a ${target === "gmail" ? "Gmail" : "Outlook"} client ID under Advanced first`);
      setAdvanced(true);
      return;
    }
    completed.current = false;
    setConnectError("");
    setBusy("connect");
    let authorize: string;
    try {
      authorize = await startOauth({
        provider: target,
        client_id: id || null,
        redirect_uri: uri,
      });
    } catch (e) {
      setConnectError(String(e));
      tell(String(e));
      setBusy("");
      return;
    }
    const state = new URL(authorize).searchParams.get("state") ?? "";
    const request: PendingOAuth = {
      provider: target,
      clientId: id,
      clientSecret: useClientSecret.trim() || null,
      redirectUri: uri,
      state,
      authorize,
    };
    setPending(request);

    // Bind the listener before opening the browser so an instant redirect is not missed.
    const waiting = awaitOauthRedirect(redirectPort(request.redirectUri), state, 300);
    try {
      await openUrl(authorize);
    } catch (e) {
      tell(`Could not open your browser: ${String(e)} — open the link below instead`);
    }
    try {
      const { code } = await waiting;
      await complete(request, code, state);
    } catch (e) {
      // A manual paste may already have finished the request; ignore the late error.
      if (!completed.current) {
        tell(String(e));
        setBusy("");
      }
    }
  };

  /** Remembers the app's own OAuth client so the provider buttons become one click. */
  const saveClient = async () => {
    if (!clientId.trim()) {
      tell("Paste the client ID first");
      return;
    }
    // Google issues a secret with every desktop client and the token exchange needs
    // it; saving the ID alone produces a confusing failure after the browser step.
    if (provider === "gmail" && !clientSecret.trim()) {
      tell("Google also issues a client secret with every desktop client — paste that too");
      return;
    }
    setBusy("saveclient");
    try {
      await saveOauthClient(provider, clientId.trim(), clientSecret);
      setClientSecret("");
      await loadOauth();
      tell(`${provider === "gmail" ? "Gmail" : "Outlook"} client saved — Connect is one click now`);
    } catch (e) {
      tell(String(e));
    } finally {
      setBusy("");
    }
  };

  /** Fallback for when the loopback redirect cannot be captured automatically. */
  const finishManual = async () => {
    if (!pending) {
      tell("Start a connection first");
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(pasted.trim());
    } catch {
      tell("Paste the full redirect URL from your browser's address bar");
      return;
    }
    const code = parsed.searchParams.get("code");
    const state = parsed.searchParams.get("state") ?? pending.state;
    if (!code) {
      tell("That URL does not contain an authorization code");
      return;
    }
    if (state !== pending.state) {
      tell("That redirect does not match the request you started");
      return;
    }
    await complete(pending, code, state);
  };

  const disconnect = async () => {
    if (!disconnecting) return;
    const target = disconnecting;
    setDisconnecting(null);
    setBusy(target.id);
    try {
      await disconnectAccount(target.id);
      tell(`${target.email} disconnected`);
      await loadAccounts();
    } catch (e) {
      tell(String(e));
    } finally {
      setBusy("");
    }
  };

  const disconnectAll = async () => {
    setBusy("disconnect-all");
    try {
      for (const account of accounts) await disconnectAccount(account.id);
      await loadAccounts();
      tell(`${accounts.length} account${accounts.length === 1 ? "" : "s"} disconnected`);
    } catch (e) {
      tell(String(e));
    } finally {
      setBusy("");
    }
  };

  /* ---------- Updates ---------- */

  /** Asks the release endpoint now, rather than waiting for the next app open. */
  const checkUpdates = async () => {
    setUpdate({ kind: "checking" });
    const found = await checkForUpdate();
    setUpdate(found);
    if (found.kind === "current") tell("Maily is up to date");
    if (found.kind === "available") tell(`Maily ${found.version} is available`);
    if (found.kind === "error") tell(`Could not check for updates: ${found.message}`);
  };

  const runUpdate = async () => {
    setUpdating(true);
    try {
      // The new build cannot take over while this one holds the process.
      if (await installUpdate(setPercent)) await relaunch();
    } catch (e) {
      setUpdate({ kind: "error", message: String(e) });
      tell(String(e));
    } finally {
      setUpdating(false);
      setPercent(null);
    }
  };

  return (
    <>
      <PageHeader title="Settings" />

      <div className="settingspage">
        <div className="segmented">
          {SECTIONS.map((entry) => (
            <button
              type="button"
              key={entry.key}
              className={tab === entry.key ? "on" : ""}
              onClick={() => setTab(entry.key)}
            >
              {entry.label}
            </button>
          ))}
        </div>

        {tab === "workspace" && (
          <section className="settingssection">
            <header>
              <h2>Workspace</h2>
              <p>How this workspace is labelled in the sidebar. Everything stays on this machine.</p>
            </header>
            <div className="settingrow">
              <div>
                <b>Name</b>
                <small>Shown in the sidebar's workspace switcher.</small>
              </div>
              <div className="settingrow-control">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => saveWorkspaceName(name)}
                  placeholder="Maily"
                />
              </div>
            </div>
          </section>
        )}

        {tab === "accounts" && (
          <section className="settingssection">
            <header>
              <h2>Connected email accounts</h2>
              <p>
                Each account sends through its provider's own API — consent opens in your browser and the
                token is kept in the OS credential vault, never the database.
              </p>
            </header>

            {accounts.map((account) => (
              <div className="accountrow" key={account.id}>
                <i className={`statusdot${account.health === "healthy" ? " is-healthy" : ""}`} />
                <span>
                  <b>{account.email}</b>
                  <small>
                    {account.provider === "gmail" ? "Gmail" : "Outlook"} · {account.sent_today}/
                    {account.daily_limit} sent today ·{" "}
                    {account.last_synced_at ? `mail read ${whenLabel(account.last_synced_at)}` : "not read yet"}
                    {/* A token granted less than it asked for is the usual reason a send
                        comes back as a bare 403, so name what it does have. */}
                    {permissions[account.id]?.can_send === false &&
                      ` · only granted: ${permissions[account.id].scopes.join(", ") || "nothing"}`}
                  </small>
                </span>
                {permissions[account.id] && (
                  <i className={`accounthealth${permissions[account.id].can_send ? " health-healthy" : " health-error"}`}>
                    {permissions[account.id].can_send ? "can send" : "cannot send"}
                  </i>
                )}
                <i className={`accounthealth health-${account.health}`}>{account.health}</i>
                <Button variant="secondary" onClick={() => setDisconnecting(account)} disabled={busy === account.id}>
                  Disconnect
                </Button>
              </div>
            ))}

            <div className="settingrow">
              <div>
                <b>Check for new mail</b>
                <small>
                  Maily reads only what has arrived since its last look, so a reply is picked up however
                  long ago the message it answers went out.
                </small>
              </div>
              <div className="settingrow-control">
                <Select value={poll} options={POLL_CHOICES} onChange={savePoll} label="Check for new mail" />
                <Button variant="secondary" onClick={checkNow} disabled={busy === "sync" || !accounts.length}>
                  Check now
                </Button>
              </div>
            </div>

            <div className="settingrow">
              <div>
                <b>{accounts.length ? "Connect another account" : "Connect an account"}</b>
                <small>
                  {ready.gmail || ready.microsoft
                    ? "Sign-in opens in your browser. Nothing else to configure."
                    : "One-time setup: add this app's OAuth client under Advanced below."}
                </small>
              </div>
              <div className="settingrow-control">
                <Button onClick={() => beginConnection("gmail")} disabled={busy === "connect"}>
                  Connect Gmail
                </Button>
                <Button variant="secondary" onClick={() => beginConnection("microsoft")} disabled={busy === "connect"}>
                  Connect Outlook
                </Button>
              </div>
            </div>

            {!ready.gmail && !ready.microsoft && (
              <div className="settingnote">
                <span className="badge-warn">Setup</span>
                <p>
                  Gmail and Microsoft only issue access to a registered app, so this app's OAuth client has to be
                  added once. After that the buttons above are one click.
                </p>
              </div>
            )}

            {connectError && (
              <div className="settingnote">
                <span className="badge-warn">Failed</span>
                <p>{connectError}</p>
                <Button variant="secondary" onClick={() => setConnectError("")}>
                  Dismiss
                </Button>
              </div>
            )}

            {pending && (
              <>
                <div className="settingrow">
                  <div>
                    <b>Finish in your browser</b>
                    <small>Browser did not open? Paste this consent link into it, then come back here.</small>
                  </div>
                  <div className="settingrow-control">
                    <Input readOnly value={pending.authorize} onFocus={(e) => e.currentTarget.select()} />
                  </div>
                </div>
                <div className="settingrow">
                  <div>
                    <b>Or paste the redirect URL</b>
                    <small>The address your browser landed on after approving access.</small>
                  </div>
                  <div className="settingrow-control">
                    <Input
                      value={pasted}
                      onChange={(e) => setPasted(e.target.value)}
                      placeholder="http://127.0.0.1:42813/callback?code=…&state=…"
                    />
                    <Button
                      variant="secondary"
                      onClick={finishManual}
                      disabled={busy === "connect" || !pasted.trim()}
                    >
                      Finish
                    </Button>
                  </div>
                </div>
              </>
            )}

            <div className="settingrow">
              <div>
                <b>Advanced — use your own OAuth app</b>
                <small>The redirect URI and client credentials are only needed here.</small>
              </div>
              <div className="settingrow-control">
                <Button variant="secondary" onClick={() => setAdvanced((open) => !open)}>
                  {advanced ? <ChevronDown /> : <ChevronRight />}
                  {advanced ? "Hide" : "Show"}
                </Button>
              </div>
            </div>

            {advanced && (
              <>
                <div className="settingrow">
                  <div>
                    <b>Provider</b>
                    <small>Which console the client was created in.</small>
                  </div>
                  <div className="settingrow-control">
                    <Select
                      label="Provider"
                      value={provider}
                      options={[
                        { value: "gmail", label: "Gmail" },
                        { value: "microsoft", label: "Outlook / Microsoft 365" },
                      ]}
                      onChange={(value) => setProvider(value as "gmail" | "microsoft")}
                    />
                  </div>
                </div>
                <div className="settingrow">
                  <div>
                    <b>OAuth client ID</b>
                    <small>From Google Cloud Console or the Entra app registration.</small>
                  </div>
                  <div className="settingrow-control">
                    <Input
                      value={clientId}
                      onChange={(e) => setClientId(e.target.value)}
                      placeholder={provider === "gmail" ? "…apps.googleusercontent.com" : "Application (client) ID"}
                    />
                  </div>
                </div>
                <div className="settingrow">
                  <div>
                    <b>Client secret</b>
                    <small>
                      {provider === "gmail"
                        ? "Required — Google issues a secret with every desktop client, and the token exchange needs it."
                        : "Optional for a public client."}
                    </small>
                  </div>
                  <div className="settingrow-control">
                    <Input
                      type="password"
                      value={clientSecret}
                      onChange={(e) => setClientSecret(e.target.value)}
                      placeholder={provider === "gmail" ? "GOCSPX-…" : "Blank for a public client"}
                    />
                  </div>
                </div>
                <div className="settingrow">
                  <div>
                    <b>Redirect URI</b>
                    <small>Register this exact URI in the provider console.</small>
                  </div>
                  <div className="settingrow-control">
                    <Input value={redirectUri} onChange={(e) => setRedirectUri(e.target.value)} />
                  </div>
                </div>
                <footer>
                  <Button
                    variant="secondary"
                    onClick={() => beginConnection(provider, clientId, clientSecret, redirectUri)}
                    disabled={busy === "connect"}
                  >
                    Connect with these
                  </Button>
                  <Button variant="secondary" onClick={saveClient} disabled={busy === "saveclient" || !clientId.trim()}>
                    {busy === "saveclient" ? "Saving…" : "Save for one-click"}
                  </Button>
                </footer>
              </>
            )}
          </section>
        )}

        {tab === "models" && (
          <>
            <section className="settingssection">
              <header>
                <h2>OpenRouter</h2>
                <p>Most models run through OpenRouter. One key covers every model in the catalog.</p>
              </header>
              <div className="settingrow">
                <div>
                  <b>API key {stored && <span className="storedtag">stored in vault</span>}</b>
                  <small>The key is written to the OS credential vault and never the database.</small>
                </div>
                <div className="settingrow-control">
                  {stored && !key ? (
                    <div className="secretfield">
                      <Input
                        readOnly
                        value={showKey ? revealed : "•••• •••• ••••"}
                        onFocus={(e) => e.currentTarget.select()}
                      />
                      <button type="button" onClick={toggleKey} title={showKey ? "Hide" : "Reveal"}>
                        {showKey ? <EyeOff /> : <Eye />}
                      </button>
                      <button type="button" onClick={copyKey} title="Copy">
                        <Copy />
                      </button>
                    </div>
                  ) : (
                    <Input
                      type="password"
                      value={key}
                      placeholder={stored ? "Replace with a new key" : "sk-or-v1-…"}
                      onChange={(e) => setKey(e.target.value)}
                    />
                  )}
                </div>
              </div>
              <footer>
                {stored && (
                  <Button variant="secondary" onClick={forgetKey}>
                    Remove key
                  </Button>
                )}
                <Button variant="secondary" onClick={refreshCatalog} disabled={busy === "catalog"}>
                  {busy === "catalog" ? "Refreshing…" : `Refresh catalog${catalog.length ? ` (${catalog.length})` : ""}`}
                </Button>
                <Button variant="secondary" onClick={saveKey} disabled={busy === "key" || !key.trim()}>
                  {busy === "key" ? "Saving…" : "Save key"}
                </Button>
              </footer>
            </section>

            <section className="settingssection">
              <header>
                <h2>Model defaults</h2>
                <p>Each job picks its own model; a blank slot follows the default.</p>
              </header>
              {SLOTS.map((slot) => (
                <div className="settingrow" key={slot.key}>
                  <div>
                    <b>{slot.label}</b>
                    <small>{slot.hint}</small>
                  </div>
                  <div className="settingrow-control">
                    <ModelPicker
                      value={llm[slot.key] ?? ""}
                      onChange={(value) => setLlm((current) => ({ ...current, [slot.key]: value }))}
                      catalog={catalog}
                      local={local}
                    />
                  </div>
                </div>
              ))}
              <footer>
                <Button variant="secondary" onClick={() => test(llm.default_model ?? "")} disabled={busy === "test"}>
                  {busy === "test" ? "Testing…" : "Test connection"}
                </Button>
                <Button variant="secondary" onClick={saveModels}>
                  Save defaults
                </Button>
              </footer>
            </section>

            <section className="settingssection">
              <header>
                <h2>Local models</h2>
                <p>Models installed on this machine, served by Ollama.</p>
              </header>
              <div className="settingrow">
                <div>
                  <b>Ollama server URL</b>
                  <small>The address Ollama listens on.</small>
                </div>
                <div className="settingrow-control">
                  <Input value={url} onChange={(e) => setUrl(e.target.value)} />
                </div>
              </div>
              <div className="settingrow">
                <div>
                  <b>Installed models</b>
                  <small>
                    {local.length
                      ? "Click one to make it the default model."
                      : "Nothing listed yet — start Ollama and fetch."}
                  </small>
                </div>
                <div className="settingrow-control">
                  <Button variant="secondary" onClick={testLocal} disabled={busy === "ollama"}>
                    {busy === "ollama" ? "Testing…" : "Fetch"}
                  </Button>
                </div>
              </div>
              {local.length > 0 && (
                <div className="settingrow">
                  <div className="modelchips">
                    {local.map((model) => (
                      <button
                        type="button"
                        key={model.name}
                        className={llm.default_model === `ollama:${model.name}` ? "on" : ""}
                        onClick={() => pickLocalAsDefault(model.name)}
                      >
                        {model.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </section>
          </>
        )}

        {tab === "limits" && (
          <section className="settingssection">
            <header>
              <h2>Sending limits</h2>
              <p>
                Caps are per account, and a campaign can set a smaller one of its own. Whichever is
                lower decides, and a campaign pauses rather than exceed it. When a campaign may send
                is its own business — each one names a timezone, or sends around the clock.
              </p>
            </header>
            {accounts.length ? (
              accounts.map((account) => (
                <div className="settingrow" key={account.id}>
                  <div>
                    <b>{account.email}</b>
                    <small>
                      {account.sent_today} sent today · {account.hourly_limit}/hour stored
                    </small>
                  </div>
                  <div className="settingrow-control">
                    <Input
                      type="number"
                      min={1}
                      defaultValue={String(account.daily_limit)}
                      aria-label={`Daily limit for ${account.email}`}
                      onBlur={(e) => saveLimits(account, e.target.value, String(account.hourly_limit))}
                    />
                    <Input
                      type="number"
                      min={1}
                      defaultValue={String(account.hourly_limit)}
                      aria-label={`Hourly limit for ${account.email}`}
                      onBlur={(e) => saveLimits(account, String(account.daily_limit), e.target.value)}
                    />
                  </div>
                </div>
              ))
            ) : (
              <div className="settingrow">
                <div>
                  <b>No accounts yet</b>
                  <small>Connect an email account to set its limits.</small>
                </div>
              </div>
            )}
          </section>
        )}

        {tab === "updates" && (
          <section className="settingssection">
            <header>
              <h2>Updates</h2>
              <p>
                Maily asks for a new release when it opens, and says so if there is one. A release is
                signed, and the download is checked against the key built into this app before it is
                installed — so a manifest that has been tampered with installs nothing.
              </p>
            </header>
            <div className="settingrow">
              <div>
                <b>Maily {version || "—"}</b>
                <small>
                  {update.kind === "checking"
                    ? "Checking…"
                    : update.kind === "current"
                      ? "You are on the latest release."
                      : update.kind === "available"
                        ? `Maily ${update.version} is available.`
                        : update.kind === "error"
                          ? `Could not check: ${update.message}`
                          : "Not checked since this app opened."}
                </small>
              </div>
              <div className="settingrow-control">
                <Button
                  variant="secondary"
                  onClick={checkUpdates}
                  disabled={update.kind === "checking" || updating}
                >
                  {update.kind === "checking" ? "Checking…" : "Check for updates"}
                </Button>
                {update.kind === "available" && (
                  <Button onClick={runUpdate} disabled={updating}>
                    {updating ? (percent === null ? "Downloading…" : `${percent}%`) : "Install and restart"}
                  </Button>
                )}
              </div>
            </div>
          </section>
        )}

        {tab === "danger" && (
          <section className="settingssection settingsdanger">
            <header>
              <h2>Danger zone</h2>
              <p>These act immediately and cannot be undone.</p>
            </header>
            <div className="settingrow">
              <div>
                <b>Disconnect every account</b>
                <small>Removes all stored tokens. Campaigns stop sending until you reconnect.</small>
              </div>
              <div className="settingrow-control">
                <Button
                  variant="secondary"
                  onClick={disconnectAll}
                  disabled={!accounts.length || busy === "disconnect-all"}
                >
                  {busy === "disconnect-all" ? "Disconnecting…" : "Disconnect all"}
                </Button>
              </div>
            </div>
          </section>
        )}
      </div>

      {disconnecting && (
        <Confirm
          title={`Disconnect ${disconnecting.email}?`}
          message="Its stored token is removed and campaigns will no longer send from it."
          confirmLabel="Disconnect"
          onConfirm={disconnect}
          onCancel={() => setDisconnecting(null)}
        />
      )}
    </>
  );
}
