# Maily

Maily is a local-first Tauri desktop application for compliant email outreach. SQLite data is stored in the OS app-data folder; OAuth and OpenRouter secrets are stored in the operating-system credential vault, not in SQLite or source control.

## Run

```powershell
npm install
npm run tauri dev
```

For a production bundle, use `npm run tauri build` after installing the platform prerequisites for Tauri v2.

## Required configuration

1. Create an OAuth desktop/web client in Google Cloud and enable Gmail API, or create an Entra app with delegated `Mail.Send`, `Mail.Read`, and `User.Read` permissions.
2. Register the redirect URI you enter in Accounts. After authorization, pass the returned `code` and `state` to Maily's `finish_oauth` command (a custom callback/deep-link handler can call this command). Never put client secrets in campaign data.
3. Install and run Ollama locally for local models, e.g. `ollama pull llama3.2`. Enter models as `ollama:llama3.2`.
4. Or use OpenRouter for hosted models: paste a key into **Settings → Models**. It is saved through Windows Credential Manager/macOS Keychain/Linux Secret Service via `keyring`, never in SQLite. One key covers the whole model catalog, and each job slot (default, drafting, classification, style) picks its own model.

## Models, knowledge and agents

**Settings → Models** is the only place a model is configured. Every model call routes the same way: `ollama:<name>` goes to the local server, anything else is treated as an OpenRouter model id. "Test connection" sends a real structured request so a bad key fails with the provider's own message rather than silently.

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
