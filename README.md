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
4. Optionally save an OpenRouter key in Accounts for a paid model; it is saved through Windows Credential Manager/macOS Keychain/Linux Secret Service via `keyring`.

## Safety model

- Autonomous campaigns require explicit approval in the UI before a durable send job can be queued.
- Provider response success is required before a send is logged as `sent`.
- SQLite transactions, unique idempotency keys, queue claim transitions, retry backoff, account limits, and suppression checks guard against accidental duplicates.
- Provider quotas and applicable consent, unsubscribe, privacy, and outreach-law requirements remain the operator's responsibility. Maily does not evade provider controls.
- Background work runs while the desktop process is alive/minimized and resumes persisted queued work after restart. No desktop app can send while its process is completely stopped by the OS.

## Verification

`npm run check`, `npm run build`, `cargo fmt --check`, and `cargo check --offline` are the project verification commands.
