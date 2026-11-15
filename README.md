# Maily

Maily is a local-first Tauri desktop application for compliant email outreach. SQLite data is stored in the OS app-data folder; OAuth and OpenRouter secrets are stored in the operating-system credential vault, not in SQLite or source control.

## Run

```powershell
npm install
npm run tauri dev
```

For a production bundle, use `npm run tauri build` after installing the platform prerequisites for Tauri v2.

## Connecting an email account

The user-facing flow is one click: **Settings → Email accounts → Connect Gmail / Connect Outlook**. Sign-in opens in the system browser and the loopback redirect is captured automatically; nothing else is asked for.

That requires the app to own an OAuth client, set up **once** (by whoever builds or installs Maily), not per user. Gmail and Microsoft will not issue tokens to an unregistered client, so this step cannot be skipped:

1. Create an OAuth *desktop* client in Google Cloud (enable the Gmail API) and/or an Entra app with delegated `Mail.Send`, `Mail.Read`, `User.Read`.
2. Register the redirect URI `http://127.0.0.1:42813/callback`. Google desktop clients accept any loopback port; for Entra, add it under the *Mobile and desktop applications* platform.
3. Put the client id (and secret, for Gmail) where Maily expects it — any one of:
   - **Settings → Email accounts → Advanced → Save for one-click**, which stores it in the OS credential vault;
   - the `MAILY_GMAIL_CLIENT_ID` / `MAILY_GMAIL_CLIENT_SECRET` / `MAILY_MICROSOFT_CLIENT_ID` / `MAILY_MICROSOFT_CLIENT_SECRET` environment variables.

The redirect URI and the client id/secret fields are only shown under **Advanced**, for using a different OAuth app than the app default. A desktop client secret is not a real secret (Google ships it in binary); it still lives in the credential vault, never SQLite.

## Local and hosted models

1. Install and run Ollama locally for local models, e.g. `ollama pull qwen2.5:3b`. Models are entered as `ollama:<name>`; **Settings → AI models** lists what is installed so you pick from the list instead of typing a name, and no model is assumed by default.
2. Or use OpenRouter for hosted models: paste a key into **Settings → AI models**. It is saved through Windows Credential Manager/macOS Keychain/Linux Secret Service via `keyring`, never in SQLite. One key covers the whole model catalog, and each job slot (default, drafting, classification, style) picks its own model.

## Models, knowledge and agents

**Settings → AI models** is the only place a model is configured. Every model call routes the same way: `ollama:<name>` goes to the local server, anything else is treated as an OpenRouter model id. "Test connection" sends a real structured request so a bad key fails with the provider's own message rather than silently.

**Knowledge** holds what the models are allowed to know: offers, ICPs, style, proof points, objections, product detail. Only entries marked *Use in prompts* are sent, and each agent and classifier node chooses which groups it may read. The prompt block is assembled in one place and the editor shows you exactly what a model would receive.

**Agents** are name + task + model + instructions + knowledge scope. The drafting agent writes a personalized subject and body per lead as a **draft**, which never sends on its own: review it under *Campaigns → Review drafts*, edit the wording, then approve. A campaign email node with "Write each email with an agent" set will block and flag the lead rather than send anything unapproved. "Learn my style" reads your templates and everything sent since bodies started being recorded, and writes a style profile into the knowledge base.

**Reply Classifier** nodes judge a reply into one of five labels — positive, negative, question, out-of-office, unsubscribe — each an output port wired to its own branch. A judgement below the node's confidence threshold pauses the lead for review instead of routing it on a guess, and every judgement is recorded.

## Safety model

- Autonomous campaigns require explicit approval in the UI before a durable send job can be queued.
- Agent-written email is a proposal until a human approves it. A personalize node with no approved draft blocks the send and flags the lead.
- A low-confidence reply judgement pauses the lead for review rather than routing it down a branch.
- Provider response success is required before a send is logged as `sent`.
- SQLite transactions, unique idempotency keys, queue claim transitions, retry backoff, account limits, and suppression checks guard against accidental duplicates.
- Provider quotas and applicable consent, unsubscribe, privacy, and outreach-law requirements remain the operator's responsibility. Maily does not evade provider controls.
- Background work runs while the desktop process is alive/minimized and resumes persisted queued work after restart. No desktop app can send while its process is completely stopped by the OS.

## Verification

`npm run check`, `npm run build`, `cargo fmt --check`, and `cargo check --offline` are the project verification commands.
