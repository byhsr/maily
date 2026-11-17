// The release build is a windowed app. Without this the linker leaves it on the console
// subsystem and Windows opens a command prompt behind the window on every launch — a
// console that also closes the instant the app exits, taking any startup message with it.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use chrono::{Datelike, Days, Months, Utc};
use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{sqlite::SqlitePoolOptions, Row, SqlitePool};
use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;
use tauri::{Emitter, Manager, State};
use tokio::sync::Semaphore;
use uuid::Uuid;

#[derive(Clone)]
struct AppState {
    db: SqlitePool,
    http: Client,
    agents: Arc<Semaphore>,
    /// One inbox sync at a time: the poller and the button must not interleave on the
    /// same cursor.
    sync: Arc<Semaphore>,
    app: tauri::AppHandle,
}
type Result<T> = std::result::Result<T, String>;
fn now() -> String {
    Utc::now().to_rfc3339()
}
fn id() -> String {
    Uuid::new_v4().to_string()
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn vault(account: &str) -> std::result::Result<keyring::Entry, String> {
    keyring::Entry::new("com.maily.desktop", account).map_err(err)
}

/// Windows caps a stored credential at 2560 UTF-16 units, and a provider's access
/// token (Microsoft's especially) can grow past that on its own. When the full blob
/// will not fit, keep only the durable half — the refresh token and client details —
/// and let the sender fetch a fresh access token instead of failing the write.
const VAULT_BLOB_LIMIT: usize = 1200;

fn save_token_blob(entry: &keyring::Entry, token: &Value) -> Result<()> {
    let full = token.to_string();
    let text = if full.encode_utf16().count() <= VAULT_BLOB_LIMIT {
        full
    } else {
        json!({
            "refresh_token": token["refresh_token"],
            "client_id": token["client_id"],
            "client_secret": token["client_secret"],
            "provider": token["provider"],
            "expires_at": 0,
        })
        .to_string()
    };
    entry
        .set_password(&text)
        .map_err(|e| format!("Could not save the account credentials to the system vault: {e}"))
}

/// Reads a JSON value out of app_settings.
async fn setting(db: &SqlitePool, key: &str) -> Option<Value> {
    sqlx::query_scalar::<_, String>("SELECT value FROM app_settings WHERE key=?")
        .bind(key)
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok())
}

/// The workspace everything created before workspaces existed was put in, and the one a
/// fresh install starts in.
const DEFAULT_WORKSPACE: &str = "ws-default";

/// The workspace a call belongs to. Single-user and local, so the active workspace is one
/// setting rather than an argument threaded through every command; the list queries read
/// it, the id-based lookups do not need it.
async fn active_workspace(db: &SqlitePool) -> String {
    setting(db, "current_workspace")
        .await
        .and_then(|value| value.as_str().map(str::to_string))
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_WORKSPACE.to_string())
}

/// The Ollama base URL, falling back to the local default.
async fn ollama_base(db: &SqlitePool) -> String {
    setting(db, "ollama_url")
        .await
        .and_then(|value| value.as_str().map(|text| text.to_string()))
        .filter(|text| !text.trim().is_empty())
        .unwrap_or_else(|| "http://127.0.0.1:11434".to_string())
        .trim_end_matches('/')
        .to_string()
}

fn openrouter_key() -> Result<String> {
    vault("openrouter_api_key")?
        .get_password()
        .map_err(|_| "No OpenRouter API key saved. Add one in Settings under Models.".to_string())
}

/// Model strings are `<provider>:<model>`; `openrouter:` may be left implicit.
fn model_id(model: &str) -> &str {
    model.strip_prefix("openrouter:").unwrap_or(model)
}

/// Resolves the model for a settings slot: the slot's own choice, then the default
/// slot. No model name is assumed — an unset model is reported so the user picks one
/// instead of the app silently sending work to a model they may not have installed.
async fn model_for(db: &SqlitePool, slot: &str) -> Result<String> {
    let llm = setting(db, "llm").await.unwrap_or_else(|| json!({}));
    for key in [slot, "default_model"] {
        if let Some(value) = llm[key].as_str() {
            if !value.trim().is_empty() {
                return Ok(value.trim().to_string());
            }
        }
    }
    Err("No model chosen yet — pick one in Settings → AI models".into())
}

/// The settings slot a job of this kind falls back to when it has no model of its own.
fn slot_for_kind(kind: &str) -> &'static str {
    match kind {
        "draft" | "followup" | "followup_decision" => "drafter_model",
        "classify_reply" => "classifier_model",
        "style_analysis" => "style_model",
        _ => "default_model",
    }
}

struct LlmOutcome {
    value: Value,
    model: String,
    prompt_tokens: i64,
    completion_tokens: i64,
    cost: f64,
}

/// Models sometimes wrap JSON in a fenced block despite response_format.
fn parse_model_json(text: &str) -> Result<Value> {
    let trimmed = text.trim();
    let body = match trimmed.strip_prefix("```") {
        Some(rest) => rest
            .trim_start_matches("json")
            .trim_end_matches("```")
            .trim(),
        None => trimmed,
    };
    serde_json::from_str::<Value>(body).map_err(|_| {
        format!(
            "Model did not return valid JSON: {}",
            trimmed.chars().take(200).collect::<String>()
        )
    })
}

/// Every model call in the app goes through here: `ollama:<name>` hits the local
/// server, anything else (optionally `openrouter:` prefixed) hits OpenRouter.
async fn llm_json(
    st: &AppState,
    model: &str,
    system: Option<&str>,
    user: &str,
    timeout_secs: u64,
) -> Result<LlmOutcome> {
    let timeout = std::time::Duration::from_secs(timeout_secs.clamp(5, 300));

    if let Some(name) = model.strip_prefix("ollama:") {
        let base = ollama_base(&st.db).await;
        let prompt = match system {
            Some(system) => format!("{}\n\n{}", system, user),
            None => user.to_string(),
        };
        let body: Value = st
            .http
            .post(format!("{base}/api/generate"))
            .json(&json!({"model": name, "prompt": prompt, "stream": false, "format": "json"}))
            .timeout(timeout)
            .send()
            .await
            .map_err(|e| format!("Could not reach Ollama at {base}: {e}"))?
            .error_for_status()
            .map_err(err)?
            .json()
            .await
            .map_err(err)?;
        return Ok(LlmOutcome {
            value: parse_model_json(body["response"].as_str().unwrap_or_default())?,
            model: model.to_string(),
            prompt_tokens: body["prompt_eval_count"].as_i64().unwrap_or(0),
            completion_tokens: body["eval_count"].as_i64().unwrap_or(0),
            cost: 0.0,
        });
    }

    let key = openrouter_key()?;
    let mut messages = Vec::new();
    if let Some(system) = system {
        messages.push(json!({"role": "system", "content": system}));
    }
    messages.push(json!({"role": "user", "content": user}));
    let response = st
        .http
        .post("https://openrouter.ai/api/v1/chat/completions")
        .bearer_auth(key)
        .json(&json!({
            "model": model_id(model),
            "messages": messages,
            "response_format": {"type": "json_object"},
            "usage": {"include": true}
        }))
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| format!("OpenRouter request failed: {e}"))?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|_| format!("OpenRouter returned {status} with a non-JSON body"))?;
    if !status.is_success() {
        let detail = body["error"]["message"]
            .as_str()
            .unwrap_or("no further detail")
            .to_string();
        return Err(match status.as_u16() {
            401 => format!("OpenRouter rejected the API key (401): {detail}"),
            402 => format!("OpenRouter reports no remaining credit (402): {detail}"),
            429 => format!("OpenRouter rate-limited this request (429): {detail}"),
            _ => format!("OpenRouter returned {status}: {detail}"),
        });
    }
    Ok(LlmOutcome {
        value: parse_model_json(
            body["choices"][0]["message"]["content"]
                .as_str()
                .unwrap_or_default(),
        )?,
        model: model_id(model).to_string(),
        prompt_tokens: body["usage"]["prompt_tokens"].as_i64().unwrap_or(0),
        completion_tokens: body["usage"]["completion_tokens"].as_i64().unwrap_or(0),
        cost: body["usage"]["cost"].as_f64().unwrap_or(0.0),
    })
}

#[derive(Deserialize)]
struct LeadInput {
    email: String,
    first_name: Option<String>,
    last_name: Option<String>,
    company: Option<String>,
    title: Option<String>,
    website: Option<String>,
    list_name: Option<String>,
    custom_fields: Option<Value>,
    /// How the lead arrived: 'import' for a spreadsheet row, 'manual' for one typed in.
    /// It is what tells the Leads page a list from a person, so it is only written when a
    /// lead is first created — a re-import never relabels one that is already there.
    source: Option<String>,
}
/// The editable fields of an existing lead, changed in place by id. Beside the identity
/// columns it carries `custom_fields`, so the columns an import kept can be corrected by
/// hand and a message then interpolates the corrected value.
#[derive(Deserialize)]
struct LeadUpdate {
    id: String,
    email: String,
    first_name: Option<String>,
    last_name: Option<String>,
    company: Option<String>,
    title: Option<String>,
    website: Option<String>,
    custom_fields: Option<Value>,
}
#[derive(Deserialize)]
struct CampaignInput {
    id: Option<String>,
    name: String,
    template_id: Option<String>,
    /// The first touch itself, copied in when its template was picked. Step 0 of the
    /// sequence, and the reason sending never reads a template.
    subject: Option<String>,
    body: Option<String>,
    /// Every first-touch subject line this campaign may go out with, in order. Position 0
    /// is the one on the campaign itself; the rest are challengers an A/B test splits
    /// across the audience. Empty means the single `subject` line is all there is.
    subjects: Option<Vec<String>>,
    list_name: Option<String>,
    interval_minutes: Option<i64>,
    account_id: Option<String>,
    /// Which stop rules this campaign obeys, as `{"reply":bool,"bounce":bool,"ooo":bool}`.
    /// Every rule is on unless the setup form turned it off.
    stop_rules: Option<Value>,
    /// Where the campaign sends from, as an IANA name. A label for the schedule; the sender
    /// never reads it.
    timezone: Option<String>,
    /// When the campaign may start, as an instant. Null means as soon as it is launched.
    scheduled_at: Option<String>,
    /// The campaign's own daily ceiling, on top of the account limits.
    daily_cap: Option<i64>,
}
/// One follow-up step of a campaign sequence, as the setup form sends it. Position is
/// assigned by order when saved. The step carries its own message; `template_id` is only a
/// label for where the copy came from, never something the sender resolves.
#[derive(Deserialize)]
struct StepInput {
    template_id: Option<String>,
    subject: Option<String>,
    body: Option<String>,
    /// The step as written and as rendered: the markdown, and the HTML and text it
    /// produced. Both keep their `{{variables}}` — one step goes to a whole audience, so
    /// they are resolved per lead on the way out, never here.
    body_html: Option<String>,
    body_text: Option<String>,
    delay_minutes: Option<i64>,
    send_date: Option<String>,
}

/// One scheduled follow-up on a single email. The composer renders each step through the
/// one shared markdown renderer, so the server stores exactly what will be sent: the
/// markdown as written and the html/text it produced.
#[derive(Deserialize)]
struct FollowupInput {
    delay_days: Option<i64>,
    /// 'YYYY-MM-DD' pins the step to a day, which outranks `delay_days` when set.
    send_date: Option<String>,
    body_md: String,
    body_html: Option<String>,
    body_text: Option<String>,
    subject_override: Option<String>,
}
#[derive(Deserialize)]
struct TemplateInput {
    id: Option<String>,
    name: String,
    subject: String,
    body: String,
    purpose: Option<String>,
    variants: Option<Value>,
}
#[derive(Deserialize)]
struct KnowledgeInput {
    id: Option<String>,
    category: String,
    title: String,
    content: String,
    approved: bool,
    tags: Option<Value>,
}
#[derive(Deserialize)]
struct AgentInput {
    kind: String,
    model: String,
    input: Value,
    timeout_seconds: Option<i64>,
    agent_id: Option<String>,
    lead_id: Option<String>,
    campaign_id: Option<String>,
}
#[derive(Deserialize)]
struct AgentDefInput {
    id: Option<String>,
    name: String,
    kind: String,
    model: String,
    system_prompt: Option<String>,
    knowledge_categories: Option<Value>,
    enabled: Option<bool>,
}
/// A connect request. The client id and redirect URI are optional: when they are
/// omitted the app's own saved OAuth client is used, which is what makes Connect a
/// single click.
#[derive(Deserialize)]
struct OAuthConfig {
    provider: String,
    client_id: Option<String>,
    redirect_uri: Option<String>,
}
#[derive(Deserialize)]
struct OAuthCallback {
    provider: String,
    code: String,
    state: String,
    client_id: Option<String>,
    client_secret: Option<String>,
    redirect_uri: Option<String>,
}
#[derive(Deserialize)]
struct SettingInput {
    key: String,
    value: Value,
}
/// One hand-written email: a fresh message, or a reply to an inbox thread.
#[derive(Deserialize)]
struct MessageInput {
    account_id: Option<String>,
    lead_id: Option<String>,
    to: Option<String>,
    cc: Option<Vec<String>>,
    bcc: Option<Vec<String>>,
    subject: Option<String>,
    /// The message as it was written. Kept so the Sent view can show the source.
    markdown: String,
    /// The rendered email and its plain-text alternative, both produced by the same
    /// renderer the composer's Preview tab uses, so preview and delivery cannot differ.
    html: String,
    text: String,
    reply_to: Option<String>,
    /// An autosaved draft to clear once the message is away.
    draft_id: Option<String>,
    /// Follow-ups to schedule after this message. A single email that carries them is
    /// stored as a hidden campaign (`kind='single'`) with one lead, so the one scheduler
    /// walks it — there is no second engine.
    followups: Option<Vec<FollowupInput>>,
    /// Stop rules for those follow-ups; every rule is on unless the composer says
    /// otherwise (stop on reply, stop on bounce/unsubscribe, pause on out-of-office).
    stop_rules: Option<Value>,
}

/// One composed draft, autosaved while the composer is open.
#[derive(Deserialize)]
struct DraftInput {
    id: Option<String>,
    account_id: Option<String>,
    reply_to: Option<String>,
    to_email: Option<String>,
    cc: Option<String>,
    bcc: Option<String>,
    subject: Option<String>,
    markdown: String,
}

/// An outgoing message in every form the two transports need.
struct Mail<'a> {
    from: &'a str,
    to: &'a str,
    cc: &'a str,
    bcc: &'a str,
    subject: &'a str,
    /// The plain-text body: the text part, and Microsoft's fallback.
    text: &'a str,
    /// The rendered HTML, or `None` for a plain campaign template.
    html: Option<&'a str>,
    /// Provider threading hint — a Gmail thread id, or an RFC Message-ID for Microsoft.
    thread: Option<&'a str>,
}

#[tauri::command]
async fn dashboard(state: State<'_, AppState>) -> Result<Value> {
    let db = &state.db;
    let ws = active_workspace(db).await;
    let campaigns = sqlx::query_scalar::<_, i64>("SELECT count(*) FROM campaigns WHERE kind='campaign' AND workspace_id=?")
        .bind(&ws)
        .fetch_one(db)
        .await
        .map_err(err)?;
    // A queued job belongs to the workspace of the campaign it was keyed for.
    let queued = sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM jobs j JOIN campaigns c ON j.idempotency_key LIKE c.id || ':%' WHERE j.state='queued' AND c.workspace_id=?",
    )
    .bind(&ws)
    .fetch_one(db)
    .await
    .map_err(err)?;
    let sent = sqlx::query_scalar::<_, i64>("SELECT count(*) FROM send_logs WHERE status='sent' AND workspace_id=?")
        .bind(&ws)
        .fetch_one(db)
        .await
        .map_err(err)?;
    let failed =
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM send_logs WHERE status='failed' AND workspace_id=?")
            .bind(&ws)
            .fetch_one(db)
            .await
            .map_err(err)?;
    // `ours=0` throughout: a marked row is a copy of something we sent, kept so the
    // conversation reads whole, and it is not a reply.
    let replies = sqlx::query_scalar::<_, i64>("SELECT count(*) FROM inbox_messages WHERE ours=0 AND workspace_id=?")
        .bind(&ws)
        .fetch_one(db)
        .await
        .map_err(err)?;
    let interested = sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM inbox_messages WHERE intent='interested' AND ours=0 AND workspace_id=?",
    )
    .bind(&ws)
    .fetch_one(db)
    .await
    .map_err(err)?;
    Ok(
        json!({"campaigns":campaigns,"queued":queued,"sent":sent,"failed":failed,"replies":replies,"interested":interested,"accounts":sqlx::query("SELECT id,provider,email,health,daily_limit,hourly_limit,sent_today,last_health_at FROM accounts WHERE workspace_id=? ORDER BY email").bind(&ws).fetch_all(db).await.map_err(err)?.iter().map(row_json).collect::<Vec<_>>(),"events":sqlx::query("SELECT level,event_type,detail,created_at FROM events WHERE workspace_id=? ORDER BY created_at DESC LIMIT 12").bind(&ws).fetch_all(db).await.map_err(err)?.iter().map(row_json).collect::<Vec<_>>() }),
    )
}
fn row_json(r: &sqlx::sqlite::SqliteRow) -> Value {
    json!({"id":r.try_get::<String,_>("id").unwrap_or_default(),"provider":r.try_get::<String,_>("provider").unwrap_or_default(),"email":r.try_get::<String,_>("email").unwrap_or_default(),"health":r.try_get::<String,_>("health").unwrap_or_default(),"daily_limit":r.try_get::<i64,_>("daily_limit").unwrap_or(0),"hourly_limit":r.try_get::<i64,_>("hourly_limit").unwrap_or(0),"sent_today":r.try_get::<i64,_>("sent_today").unwrap_or(0),"last_health_at":r.try_get::<String,_>("last_health_at").unwrap_or_default(),"last_synced_at":r.try_get::<Option<String>,_>("last_synced_at").unwrap_or_default(),"incremental":r.try_get::<i64,_>("incremental").unwrap_or(0) != 0,"unread":r.try_get::<i64,_>("unread").unwrap_or(0)})
}

fn window_keys(range: &str) -> (Vec<(String, String)>, bool) {
    let now = Utc::now();
    if range == "year" {
        let base = now
            .date_naive()
            .with_day(1)
            .unwrap_or_else(|| now.date_naive());
        let keys = (0..12u32)
            .rev()
            .map(|i| {
                let m = base.checked_sub_months(Months::new(i)).unwrap_or(base);
                (m.format("%Y-%m").to_string(), m.format("%b").to_string())
            })
            .collect::<Vec<_>>();
        (keys, true)
    } else {
        let days = if range == "month" { 30u64 } else { 7u64 };
        let keys = (0..days)
            .rev()
            .map(|i| {
                let d = now.date_naive() - Days::new(i);
                (d.format("%Y-%m-%d").to_string(), d.format("%d").to_string())
            })
            .collect::<Vec<_>>();
        (keys, false)
    }
}

fn bucket_key(created_at: &str, monthly: bool) -> Option<String> {
    let width = if monthly { 7 } else { 10 };
    if created_at.len() >= width {
        Some(created_at[..width].to_string())
    } else {
        None
    }
}

#[tauri::command]
async fn dashboard_stats(state: State<'_, AppState>, range: Option<String>) -> Result<Value> {
    let range = range.unwrap_or_else(|| "week".to_string());
    let (keys, monthly) = window_keys(&range);
    let day_count = if range == "month" { 30u64 } else { 7u64 };

    let mut current: BTreeMap<String, [i64; 4]> =
        keys.iter().map(|(k, _)| (k.clone(), [0; 4])).collect();
    let previous: HashSet<String> = if monthly {
        let base = Utc::now()
            .date_naive()
            .with_day(1)
            .unwrap_or_else(|| Utc::now().date_naive());
        (12..24u32)
            .map(|i| {
                base.checked_sub_months(Months::new(i))
                    .unwrap_or(base)
                    .format("%Y-%m")
                    .to_string()
            })
            .collect()
    } else {
        (day_count..day_count * 2)
            .map(|i| {
                (Utc::now().date_naive() - Days::new(i))
                    .format("%Y-%m-%d")
                    .to_string()
            })
            .collect()
    };
    let mut prev = [0i64; 4];
    let ws = active_workspace(&state.db).await;

    let logs = sqlx::query("SELECT status, created_at FROM send_logs WHERE workspace_id=?")
        .bind(&ws)
        .fetch_all(&state.db)
        .await
        .map_err(err)?;
    for row in logs {
        let created: String = row.get("created_at");
        let Some(key) = bucket_key(&created, monthly) else {
            continue;
        };
        let slot = if row.get::<String, _>("status") == "sent" {
            0
        } else {
            3
        };
        if let Some(v) = current.get_mut(&key) {
            v[slot] += 1;
        } else if previous.contains(&key) {
            prev[slot] += 1;
        }
    }

    let messages = sqlx::query("SELECT intent, received_at FROM inbox_messages WHERE ours=0 AND workspace_id=?")
        .bind(&ws)
        .fetch_all(&state.db)
        .await
        .map_err(err)?;
    for row in messages {
        let received: Option<String> = row.get("received_at");
        let Some(received) = received else { continue };
        let Some(key) = bucket_key(&received, monthly) else {
            continue;
        };
        let positive = row.get::<Option<String>, _>("intent").as_deref() == Some("interested");
        if let Some(v) = current.get_mut(&key) {
            v[1] += 1;
            if positive {
                v[2] += 1;
            }
        } else if previous.contains(&key) {
            prev[1] += 1;
            if positive {
                prev[2] += 1;
            }
        }
    }

    let series: Vec<Value> = keys
        .iter()
        .map(|(key, label)| {
            let v = current.get(key).copied().unwrap_or([0; 4]);
            json!({"key": key, "label": label, "sent": v[0], "replied": v[1], "positive": v[2], "failed": v[3]})
        })
        .collect();
    let sum = |slot: usize| current.values().map(|v| v[slot]).sum::<i64>();
    let (sent, replied, positive, failed) = (sum(0), sum(1), sum(2), sum(3));
    let needs_attention =
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM inbox_messages WHERE intent IS NULL AND ours=0 AND workspace_id=?")
            .bind(&ws)
            .fetch_one(&state.db)
            .await
            .map_err(err)?;
    // `kind='campaign'` for the same reason the list uses it: a single carrying follow-ups
    // is a campaign to the scheduler but not one of the campaigns this counts.
    let active_campaigns =
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM campaigns WHERE status='active' AND kind='campaign' AND workspace_id=?")
            .bind(&ws)
            .fetch_one(&state.db)
            .await
            .map_err(err)?;

    Ok(json!({
        "range": range,
        "series": series,
        "totals": {"sent": sent, "replied": replied, "positive": positive, "failed": failed},
        "previous": {"sent": prev[0], "replied": prev[1], "positive": prev[2], "failed": prev[3]},
        "needsAttention": needs_attention,
        "activeCampaigns": active_campaigns
    }))
}

#[tauri::command]
async fn list_leads(state: State<'_, AppState>) -> Result<Vec<Value>> {
    let ws = active_workspace(&state.db).await;
    sqlx::query("SELECT id,email,first_name,last_name,company,title,website,list_name,status,custom_fields,source FROM leads WHERE workspace_id=? ORDER BY created_at DESC").bind(&ws).fetch_all(&state.db).await.map_err(err).map(|rows| rows.into_iter().map(|r| json!({"id":r.get::<String,_>("id"),"email":r.get::<String,_>("email"),"first_name":r.get::<Option<String>,_>("first_name"),"last_name":r.get::<Option<String>,_>("last_name"),"company":r.get::<Option<String>,_>("company"),"title":r.get::<Option<String>,_>("title"),"website":r.get::<Option<String>,_>("website"),"list_name":r.get::<String,_>("list_name"),"status":r.get::<String,_>("status"),"source":r.get::<Option<String>,_>("source"),"custom_fields":serde_json::from_str::<Value>(&r.get::<String,_>("custom_fields")).unwrap_or(json!({}))})).collect())
}
#[tauri::command]
async fn upsert_leads(state: State<'_, AppState>, leads: Vec<LeadInput>) -> Result<usize> {
    let mut tx = state.db.begin().await.map_err(err)?;
    // Imported leads belong to the workspace that imported them.
    let ws = active_workspace(&state.db).await;
    let mut n = 0;
    for l in leads {
        let email = l.email.trim().to_lowercase();
        if !email.contains('@') {
            continue;
        }
        if sqlx::query_scalar::<_, i64>("SELECT count(*) FROM suppressions WHERE email=?")
            .bind(&email)
            .fetch_one(&mut *tx)
            .await
            .map_err(err)?
            > 0
        {
            continue;
        }
        let t = now();
        // A lead email is unique across the database, so the update is guarded by the
        // workspace: the same address in another workspace is left exactly as it was
        // rather than being pulled across.
        sqlx::query("INSERT INTO leads(id,email,first_name,last_name,company,title,website,list_name,custom_fields,source,workspace_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET first_name=excluded.first_name,last_name=excluded.last_name,company=excluded.company,title=excluded.title,website=excluded.website,list_name=excluded.list_name,custom_fields=excluded.custom_fields,updated_at=excluded.updated_at WHERE leads.workspace_id=excluded.workspace_id")
            .bind(id())
            .bind(email)
            .bind(l.first_name)
            .bind(l.last_name)
            .bind(l.company)
            .bind(l.title)
            .bind(l.website)
            .bind(l.list_name.unwrap_or_else(||"Unassigned".into()))
            .bind(l.custom_fields.unwrap_or(json!({})).to_string())
            .bind(l.source.unwrap_or_else(|| "manual".into()))
            .bind(&ws)
            .bind(&t)
            .bind(&t)
            .execute(&mut *tx)
            .await
            .map_err(err)?;
        n += 1;
    }
    tx.commit().await.map_err(err)?;
    Ok(n)
}
/// Edits a lead in place. Email stays unique, so a clash with another lead is
/// rejected rather than silently merging the two records.
#[tauri::command]
async fn update_lead(state: State<'_, AppState>, input: LeadUpdate) -> Result<()> {
    let email = input.email.trim().to_lowercase();
    if !email.contains('@') {
        return Err("Enter a valid email address".into());
    }
    let clash = sqlx::query_scalar::<_, i64>("SELECT count(*) FROM leads WHERE email=? AND id<>?")
        .bind(&email)
        .bind(&input.id)
        .fetch_one(&state.db)
        .await
        .map_err(err)?;
    if clash > 0 {
        return Err("Another lead already uses that email".into());
    }
    // A missing `custom_fields` leaves the stored row alone; the editor always sends the
    // object it was given, so a field the form dropped is not silently erased.
    let custom = input.custom_fields.map(|value| value.to_string());
    let updated = sqlx::query(
        "UPDATE leads SET email=?,first_name=?,last_name=?,company=?,title=?,website=?,custom_fields=COALESCE(?,custom_fields),updated_at=? WHERE id=?",
    )
    .bind(&email)
    .bind(input.first_name)
    .bind(input.last_name)
    .bind(input.company)
    .bind(input.title)
    .bind(input.website)
    .bind(custom)
    .bind(now())
    .bind(&input.id)
    .execute(&state.db)
    .await
    .map_err(err)?
    .rows_affected();
    if updated == 0 {
        return Err("Lead not found".into());
    }
    Ok(())
}
/// Removes one lead. Enrolments, drafts and sequence rows cascade with the row.
#[tauri::command]
async fn delete_lead(state: State<'_, AppState>, id: String) -> Result<()> {
    sqlx::query("DELETE FROM leads WHERE id=?")
        .bind(&id)
        .execute(&state.db)
        .await
        .map_err(err)?;
    log(&state.db, "info", "lead_deleted", &id).await;
    Ok(())
}
/// Removes every lead in an imported list and reports how many were removed.
#[tauri::command]
async fn delete_lead_list(state: State<'_, AppState>, name: String) -> Result<usize> {
    let ws = active_workspace(&state.db).await;
    let removed = sqlx::query("DELETE FROM leads WHERE list_name=? AND workspace_id=?")
        .bind(&name)
        .bind(&ws)
        .execute(&state.db)
        .await
        .map_err(err)?
        .rows_affected() as usize;
    log(
        &state.db,
        "info",
        "lead_list_deleted",
        &format!("{} ({})", name, removed),
    )
    .await;
    Ok(removed)
}
#[tauri::command]
async fn suppress_lead(state: State<'_, AppState>, email: String, reason: String) -> Result<()> {
    let mut tx = state.db.begin().await.map_err(err)?;
    sqlx::query("INSERT OR REPLACE INTO suppressions(email,reason,created_at) VALUES(?,?,?)")
        .bind(email.to_lowercase())
        .bind(reason)
        .bind(now())
        .execute(&mut *tx)
        .await
        .map_err(err)?;
    sqlx::query("UPDATE leads SET status='suppressed',updated_at=? WHERE email=?")
        .bind(now())
        .bind(email.to_lowercase())
        .execute(&mut *tx)
        .await
        .map_err(err)?;
    tx.commit().await.map_err(err)
}
#[tauri::command]
async fn save_template(state: State<'_, AppState>, input: TemplateInput) -> Result<String> {
    if input.name.trim().is_empty()
        || input.subject.trim().is_empty()
        || input.body.trim().is_empty()
    {
        return Err("Template name, subject, and body are required".into());
    }
    let purpose = input
        .purpose
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "first_touch".to_string());
    let variants = input
        .variants
        .filter(|value| value.is_array())
        .unwrap_or_else(|| json!([]));
    let t = now();
    // A template is one message. Editing one rewrites it in place; campaigns that were
    // built from it keep the copy they took, which is the whole point of the copy.
    match input.id.filter(|value| !value.trim().is_empty()) {
        Some(existing) => {
            let updated = sqlx::query(
                "UPDATE templates SET name=?,subject=?,body=?,purpose=?,variants=?,updated_at=? WHERE id=?",
            )
            .bind(input.name.trim())
            .bind(input.subject.trim())
            .bind(&input.body)
            .bind(&purpose)
            .bind(variants.to_string())
            .bind(&t)
            .bind(&existing)
            .execute(&state.db)
            .await
            .map_err(err)?
            .rows_affected();
            if updated == 0 {
                return Err("That template no longer exists".into());
            }
            Ok(existing)
        }
        None => {
            let x = id();
            sqlx::query(
                "INSERT INTO templates(id,name,subject,body,purpose,variants,workspace_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
            )
            .bind(&x)
            .bind(input.name.trim())
            .bind(input.subject.trim())
            .bind(&input.body)
            .bind(&purpose)
            .bind(variants.to_string())
            .bind(active_workspace(&state.db).await)
            .bind(&t)
            .bind(&t)
            .execute(&state.db)
            .await
            .map_err(err)?;
            Ok(x)
        }
    }
}
const STARTER_TEMPLATES: &[(&str, &str, &str, &str)] = &[
    (
        "First touch — observation",
        "first_touch",
        "Quick idea for {{company|your team}}",
        "Hi {{first_name|there}},\n\nI noticed {{company|your team}} {{signal|is growing}} and had one specific thought about {{topic|your outbound}}.\n\nWorth a quick look?\n\n— {{sender_name|the team}}\n\nNot relevant? Reply \"stop\" and I won't follow up.",
    ),
    (
        "First touch — referral",
        "first_touch",
        "{{referrer|A colleague}} suggested I reach out",
        "Hi {{first_name|there}},\n\n{{referrer|A colleague}} mentioned {{company|your team}} is working on {{topic|outbound}}. We helped a similar team with one concrete change.\n\nOpen to a short note on what that looked like?\n\n— {{sender_name|the team}}\n\nReply \"stop\" to opt out.",
    ),
    (
        "First touch — very short",
        "first_touch",
        "{{company|Your team}} + one idea",
        "Hi {{first_name|there}},\n\nOne idea for {{company|your team}}: {{idea|tighten the first touch}}.\n\nWant the one-line version?\n\n— {{sender_name|the team}}",
    ),
    (
        "Follow-up — new value",
        "follow_up",
        "Re: Quick idea for {{company|your team}}",
        "Hi {{first_name|there}},\n\nAdding one thing I left out: {{proof_point|teams like yours cut manual follow-up in half}}.\n\nStill worth a look?\n\n— {{sender_name|the team}}",
    ),
    (
        "Follow-up — proof point",
        "follow_up",
        "Re: {{company|your team}}",
        "Hi {{first_name|there}},\n\nShort proof point: {{proof_point|a 40-person team removed 6 hours of weekly admin in a month}}.\n\nHappy to send the two-line summary.\n\n— {{sender_name|the team}}",
    ),
    (
        "Follow-up — different angle",
        "follow_up",
        "Re: one more angle on {{company|your team}}",
        "Hi {{first_name|there}},\n\nComing at this differently: {{angle|what happens to replies nobody sees for a day}}.\n\nIf it's not a fit, no problem.\n\n— {{sender_name|the team}}",
    ),
    (
        "Breakup — polite close",
        "breakup",
        "Closing the loop on {{company|your team}}",
        "Hi {{first_name|there}},\n\nI'll stop here to keep your inbox clear. If {{topic|this}} becomes relevant later, just reply and I'll pick it back up.\n\nAll the best,\n{{sender_name|the team}}",
    ),
    (
        "Breakup — short",
        "breakup",
        "Last note from me",
        "Hi {{first_name|there}},\n\nI'll leave it here. Reply anytime if it's worth a look.\n\n— {{sender_name|the team}}",
    ),
    (
        "Reply — ask for a meeting",
        "reply_positive",
        "Re: {{company|your team}}",
        "Hi {{first_name|there}},\n\nGlad it landed. Would 20 minutes this week work? I'll keep it to one screen of notes.\n\n— {{sender_name|the team}}",
    ),
    (
        "Reply — answer a question",
        "reply_question",
        "Re: {{company|your team}}",
        "Hi {{first_name|there}},\n\nGood question — short answer: {{answer|yes, it runs fully locally and sends only after approval}}.\n\nWant the longer version?\n\n— {{sender_name|the team}}",
    ),
    (
        "Reply — not now (60 days)",
        "reply_not_now",
        "Re: {{company|your team}}",
        "Hi {{first_name|there}},\n\nUnderstood — I'll check back in about 60 days. If anything changes sooner, just reply here.\n\n— {{sender_name|the team}}",
    ),
];

#[tauri::command]
async fn seed_templates(state: State<'_, AppState>) -> Result<usize> {
    let ws = active_workspace(&state.db).await;
    let existing = sqlx::query_scalar::<_, i64>("SELECT count(*) FROM templates WHERE workspace_id=?")
        .bind(&ws)
        .fetch_one(&state.db)
        .await
        .map_err(err)?;
    if existing > 0 {
        return Err("The template library already has templates".into());
    }
    let mut count = 0;
    for &(name, purpose, subject, body) in STARTER_TEMPLATES {
        let t = now();
        sqlx::query(
            "INSERT INTO templates(id,name,subject,body,purpose,variants,workspace_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .bind(id())
        .bind(name)
        .bind(subject)
        .bind(body)
        .bind(purpose)
        .bind("[]")
        .bind(&ws)
        .bind(&t)
        .bind(&t)
        .execute(&state.db)
        .await
        .map_err(err)?;
        count += 1;
    }
    Ok(count)
}
#[tauri::command]
async fn list_templates(state: State<'_, AppState>) -> Result<Vec<Value>> {
    let ws = active_workspace(&state.db).await;
    let rows = sqlx::query("SELECT id,name,subject,body,purpose,variants FROM templates WHERE workspace_id=? ORDER BY updated_at DESC")
        .bind(&ws)
        .fetch_all(&state.db)
        .await
        .map_err(err)?;
    Ok(rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<String, _>("id"),
                "name": r.get::<String, _>("name"),
                "subject": r.get::<String, _>("subject"),
                "body": r.get::<String, _>("body"),
                "purpose": r.get::<String, _>("purpose"),
                "variants": serde_json::from_str::<Value>(&r.get::<String, _>("variants")).unwrap_or(json!([])),
            })
        })
        .collect())
}

/// Replaces a campaign's first-touch subject lines. Position 0 is the original and the rest
/// are challengers; the list is only rewritten when it actually changed, so the autosave that
/// fires every few seconds does not churn rows.
async fn write_campaign_subjects(
    db: &SqlitePool,
    campaign_id: &str,
    lines: &[String],
) -> Result<()> {
    let existing: Vec<String> = sqlx::query_scalar(
        "SELECT subject FROM campaign_subjects WHERE campaign_id=? ORDER BY position",
    )
    .bind(campaign_id)
    .fetch_all(db)
    .await
    .map_err(err)?;
    if existing == lines {
        return Ok(());
    }
    let mut tx = db.begin().await.map_err(err)?;
    sqlx::query("DELETE FROM campaign_subjects WHERE campaign_id=?")
        .bind(campaign_id)
        .execute(&mut *tx)
        .await
        .map_err(err)?;
    let t = now();
    for (position, subject) in lines.iter().enumerate() {
        sqlx::query("INSERT INTO campaign_subjects(id,campaign_id,position,subject,created_at) VALUES(?,?,?,?,?)")
            .bind(id())
            .bind(campaign_id)
            .bind(position as i64)
            .bind(subject)
            .bind(&t)
            .execute(&mut *tx)
            .await
            .map_err(err)?;
    }
    tx.commit().await.map_err(err)
}

#[tauri::command]
async fn save_campaign(state: State<'_, AppState>, input: CampaignInput) -> Result<String> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err("A campaign needs a name".into());
    }
    let interval = input.interval_minutes.unwrap_or(5).clamp(1, 10080);
    let ws = active_workspace(&state.db).await;
    let list = input
        .list_name
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    // The first touch travels with the campaign. What is sent is this copy; `template_id`
    // only records which template it was copied from.
    let subject = input
        .subject
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let body = input
        .body
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    // The subject lines this campaign may open with. The list the form sent is the truth;
    // when it is absent or empty, the single `subject` line stands as the only one.
    let mut lines: Vec<String> = subject.clone().into_iter().collect();
    if let Some(sent) = input.subjects {
        let mut seen = std::collections::HashSet::new();
        let mut cleaned: Vec<String> = Vec::new();
        for line in sent {
            let line = line.trim().to_string();
            if !line.is_empty() && seen.insert(line.to_lowercase()) {
                cleaned.push(line);
            }
        }
        if !cleaned.is_empty() {
            lines = cleaned;
        }
    }
    // The campaign's own subject is the first line, so the single-subject fallback, a
    // follow-up's `Re:` and the list view all agree with the A/B list.
    let subject = lines.first().cloned();
    let existing = input.id.filter(|value| !value.trim().is_empty());
    // Stored only when the form sent rules, so a partial save cannot wipe them.
    let rules = input
        .stop_rules
        .as_ref()
        .map(|value| value.to_string())
        .filter(|value| value != "null");
    // The timezone is only a label for the schedule now; the instant is worked out where the
    // date, time and zone were picked, so the sender needs no timezone database.
    let timezone = input
        .timezone
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let scheduled = input
        .scheduled_at
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    // A cap of zero or less means "no cap of this campaign's own".
    let cap = input.daily_cap.filter(|cap| *cap > 0);
    let t = now();
    let campaign_id = match existing {
        Some(existing) => {
            let updated = sqlx::query("UPDATE campaigns SET name=?,template_id=?,subject=?,body=?,list_name=?,interval_minutes=?,account_id=?,stop_rules=COALESCE(?,stop_rules),timezone=?,scheduled_at=?,daily_cap=?,updated_at=? WHERE id=?")
                .bind(&name)
                .bind(input.template_id)
                .bind(subject)
                .bind(body)
                .bind(list)
                .bind(interval)
                .bind(input.account_id)
                .bind(rules)
                .bind(&timezone)
                .bind(&scheduled)
                .bind(cap)
                .bind(&t)
                .bind(&existing)
                .execute(&state.db)
                .await
                .map_err(err)?
                .rows_affected();
            if updated == 0 {
                return Err("That campaign no longer exists".into());
            }
            existing
        }
        None => {
            let fresh = id();
            sqlx::query("INSERT INTO campaigns(id,name,mode,template_id,subject,body,list_name,interval_minutes,account_id,schedule_json,stop_rules,timezone,scheduled_at,daily_cap,workspace_id,created_at,updated_at) VALUES(?,?,'draft',?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
                .bind(&fresh)
                .bind(&name)
                .bind(input.template_id)
                .bind(subject)
                .bind(body)
                .bind(list)
                .bind(interval)
                .bind(input.account_id)
                .bind(json!({}).to_string())
                .bind(rules)
                .bind(&timezone)
                .bind(&scheduled)
                .bind(cap)
                .bind(&ws)
                .bind(&t)
                .bind(&t)
                .execute(&state.db)
                .await
                .map_err(err)?;
            fresh
        }
    };
    // The A/B list travels beside the campaign, so an edit to it is saved with the copy.
    write_campaign_subjects(&state.db, &campaign_id, &lines).await?;
    Ok(campaign_id)
}
/// Replaces a campaign's follow-up sequence. Position is the array order, and the first
/// touch — step 0 — lives on the campaign itself, so it is never stored here. Each step
/// carries its own message: the copy taken when its template was picked.
#[tauri::command]
async fn save_steps(
    state: State<'_, AppState>,
    campaign_id: String,
    steps: Vec<StepInput>,
) -> Result<()> {
    /// A trimmed, non-empty string, which is how every nullable field here is stored.
    fn trimmed(value: &Option<String>) -> Option<&str> {
        value.as_deref().map(str::trim).filter(|value| !value.is_empty())
    }
    let mut tx = state.db.begin().await.map_err(err)?;
    sqlx::query("DELETE FROM sequence_steps WHERE campaign_id=?")
        .bind(&campaign_id)
        .execute(&mut *tx)
        .await
        .map_err(err)?;
    for (index, step) in steps.iter().enumerate() {
        let body = step.body.as_deref().map(str::trim).unwrap_or("");
        if body.is_empty() {
            continue;
        }
        let delay = step.delay_minutes.unwrap_or(0).max(0);
        sqlx::query("INSERT INTO sequence_steps(id,campaign_id,position,delay_minutes,template_id,body_md,body_html,body_text,subject_override,enabled,send_date) VALUES(?,?,?,?,?,?,?,?,?,1,?)")
            .bind(id())
            .bind(&campaign_id)
            .bind((index + 1) as i64)
            .bind(delay)
            .bind(trimmed(&step.template_id))
            .bind(body)
            .bind(trimmed(&step.body_html))
            .bind(trimmed(&step.body_text))
            .bind(trimmed(&step.subject))
            .bind(trimmed(&step.send_date))
            .execute(&mut *tx)
            .await
            .map_err(err)?;
    }
    tx.commit().await.map_err(err)?;
    Ok(())
}

#[tauri::command]
async fn list_campaigns(state: State<'_, AppState>) -> Result<Vec<Value>> {
    // Every campaign proper, in the workspace that is open. A single email that carries
    // follow-ups is stored as a campaign too, but as `kind='single'`, and it never
    // appears here.
    let ws = active_workspace(&state.db).await;
    sqlx::query("SELECT c.id,c.name,c.status,c.mode,c.approved_at,c.template_id,c.list_name,c.interval_minutes,c.account_id,c.last_sent_at,count(cl.lead_id) AS leads,sum(CASE WHEN cl.state='done' THEN 1 ELSE 0 END) AS sent,(SELECT count(*) FROM sequence_steps ss WHERE ss.campaign_id=c.id AND ss.enabled=1) AS followups FROM campaigns c LEFT JOIN campaign_leads cl ON cl.campaign_id=c.id WHERE c.kind='campaign' AND c.workspace_id=? GROUP BY c.id ORDER BY c.created_at DESC")
        .bind(&ws)
        .fetch_all(&state.db)
        .await
        .map_err(err)
        .map(|rs| {
            rs.iter()
                .map(|r| json!({
                    "id": r.get::<String, _>("id"),
                    "name": r.get::<String, _>("name"),
                    "kind": "campaign",
                    "status": r.get::<String, _>("status"),
                    "mode": r.get::<String, _>("mode"),
                    "approved_at": r.get::<Option<String>, _>("approved_at"),
                    "template_id": r.get::<Option<String>, _>("template_id"),
                    "list_name": r.get::<Option<String>, _>("list_name"),
                    "interval_minutes": r.get::<i64, _>("interval_minutes"),
                    "account_id": r.get::<Option<String>, _>("account_id"),
                    "last_sent_at": r.get::<Option<String>, _>("last_sent_at"),
                    "leads": r.get::<i64, _>("leads"),
                    "sent": r.get::<Option<i64>, _>("sent").unwrap_or(0),
                    "followups": r.get::<Option<i64>, _>("followups").unwrap_or(0)
                }))
                .collect()
        })
}
/// Everything the campaign page shows: its settings, per-state counts, and every
/// enrolled lead with the state it is in and when it was last sent to.
#[tauri::command]
async fn campaign_detail(state: State<'_, AppState>, campaign_id: String) -> Result<Value> {
    let c = sqlx::query("SELECT id,name,status,mode,approved_at,template_id,subject,body,list_name,interval_minutes,account_id,last_sent_at,created_at,stop_rules,timezone,scheduled_at,daily_cap FROM campaigns WHERE id=?")
        .bind(&campaign_id)
        .fetch_optional(&state.db)
        .await
        .map_err(err)?
        .ok_or("Campaign not found")?;

    // The first-touch subject lines, in order. Position 0 is the original; anything after it
    // is a challenger the audience is split across.
    let subjects: Vec<String> = sqlx::query_scalar(
        "SELECT subject FROM campaign_subjects WHERE campaign_id=? ORDER BY position",
    )
    .bind(&campaign_id)
    .fetch_all(&state.db)
    .await
    .map_err(err)?;

    let counted = sqlx::query(
        "SELECT state,count(*) AS n FROM campaign_leads WHERE campaign_id=? GROUP BY state",
    )
    .bind(&campaign_id)
    .fetch_all(&state.db)
    .await
    .map_err(err)?;
    let mut counts = serde_json::Map::new();
    for row in &counted {
        counts.insert(row.get::<String, _>("state"), json!(row.get::<i64, _>("n")));
    }

    // Enough per enrolment to draw a row, say which step it is on, and open its
    // conversation. `suppressed` is what makes an unsubscribed lead read as unsubscribed.
    let rows = sqlx::query("SELECT cl.lead_id,cl.state,cl.outcome,cl.step_position,cl.subject_variant,cl.next_due_at,cl.thread_ref,l.email,l.first_name,l.company,(SELECT max(s.created_at) FROM send_logs s WHERE s.campaign_id=cl.campaign_id AND s.lead_id=cl.lead_id) AS sent_at,(SELECT count(*) FROM send_logs s WHERE s.campaign_id=cl.campaign_id AND s.lead_id=cl.lead_id) AS sent_steps,(SELECT m.id FROM inbox_messages m WHERE m.thread_id=cl.thread_ref AND m.deleted_at IS NULL ORDER BY m.received_at DESC LIMIT 1) AS last_message_id,EXISTS(SELECT 1 FROM inbox_messages m WHERE m.thread_id=cl.thread_ref AND m.ours=0 AND m.deleted_at IS NULL) AS replied,EXISTS(SELECT 1 FROM suppressions WHERE suppressions.email=l.email) AS suppressed FROM campaign_leads cl JOIN leads l ON l.id=cl.lead_id WHERE cl.campaign_id=? ORDER BY l.rowid")
        .bind(&campaign_id)
        .fetch_all(&state.db)
        .await
        .map_err(err)?;
    let leads: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "lead_id": r.get::<String, _>("lead_id"),
                "state": r.get::<String, _>("state"),
                "outcome": r.get::<Option<String>, _>("outcome"),
                "step_position": r.get::<i64, _>("step_position"),
                "subject_variant": r.get::<Option<i64>, _>("subject_variant"),
                "next_due_at": r.get::<Option<String>, _>("next_due_at"),
                "email": r.get::<String, _>("email"),
                "first_name": r.get::<Option<String>, _>("first_name"),
                "company": r.get::<Option<String>, _>("company"),
                "sent_at": r.get::<Option<String>, _>("sent_at"),
                "sent_steps": r.get::<i64, _>("sent_steps"),
                "thread_id": r.get::<Option<String>, _>("thread_ref"),
                "last_message_id": r.get::<Option<String>, _>("last_message_id"),
                "replied": r.get::<i64, _>("replied") != 0,
                "suppressed": r.get::<i64, _>("suppressed") != 0,
            })
        })
        .collect();

    let step_rows = sqlx::query("SELECT position,template_id,subject_override,body_md,delay_minutes,send_date FROM sequence_steps WHERE campaign_id=? AND enabled=1 ORDER BY position")
        .bind(&campaign_id)
        .fetch_all(&state.db)
        .await
        .map_err(err)?;
    let steps: Vec<Value> = step_rows
        .iter()
        .map(|r| {
            json!({
                "position": r.get::<i64, _>("position"),
                "template_id": r.get::<Option<String>, _>("template_id"),
                "subject": r.get::<Option<String>, _>("subject_override"),
                "body": r.get::<Option<String>, _>("body_md"),
                "delay_minutes": r.get::<i64, _>("delay_minutes"),
                "send_date": r.get::<Option<String>, _>("send_date"),
            })
        })
        .collect();
    let sent: i64 = sqlx::query_scalar("SELECT count(*) FROM send_logs WHERE campaign_id=?")
        .bind(&campaign_id)
        .fetch_one(&state.db)
        .await
        .map_err(err)?;
    let positive: i64 = sqlx::query_scalar("SELECT count(*) FROM campaign_leads WHERE campaign_id=? AND outcome='positive'")
        .bind(&campaign_id)
        .fetch_one(&state.db)
        .await
        .map_err(err)?;
    // Every rule is on unless this campaign turned one off.
    let rules = c
        .get::<Option<String>, _>("stop_rules")
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or_else(|| json!({"reply": true, "bounce": true, "ooo": true}));

    // Everything this campaign sent, and every answer that came back. The stat row, the
    // funnel and the activity feed are all read off these two lists, so they are fetched
    // once and combined here rather than joined five different ways.
    let send_rows = sqlx::query("SELECT lead_id,step_position,created_at FROM send_logs WHERE campaign_id=? ORDER BY created_at")
        .bind(&campaign_id)
        .fetch_all(&state.db)
        .await
        .map_err(err)?;
    let sends: Vec<(String, i64, String)> = send_rows
        .iter()
        .map(|r| {
            (
                r.get::<Option<String>, _>("lead_id").unwrap_or_default(),
                r.get::<i64, _>("step_position"),
                r.get::<String, _>("created_at"),
            )
        })
        .collect();

    let answer_rows = sqlx::query("SELECT m.id,m.subject,m.raw_excerpt,m.received_at,cl.lead_id FROM campaign_leads cl JOIN inbox_messages m ON m.thread_id=cl.thread_ref AND m.ours=0 AND m.deleted_at IS NULL WHERE cl.campaign_id=? ORDER BY m.received_at")
        .bind(&campaign_id)
        .fetch_all(&state.db)
        .await
        .map_err(err)?;
    // A bounce only exists once the mailbox has synced it, so the classifier the inbox
    // already uses decides which of these is an answer and which is a failure report.
    struct Answer {
        lead_id: String,
        at: String,
        subject: String,
        message_id: String,
        bounce: bool,
    }
    let answers: Vec<Answer> = answer_rows
        .iter()
        .map(|r| {
            let subject = r.get::<Option<String>, _>("subject").unwrap_or_default();
            let excerpt = r.get::<Option<String>, _>("raw_excerpt").unwrap_or_default();
            Answer {
                lead_id: r.get::<String, _>("lead_id"),
                at: r.get::<Option<String>, _>("received_at").unwrap_or_default(),
                bounce: rule_category(&format!("{subject} {excerpt}")) == Some("bounce"),
                subject,
                message_id: r.get::<String, _>("id"),
            }
        })
        .collect();

    let waiting_rows = sqlx::query("SELECT step_position,count(*) AS n FROM campaign_leads WHERE campaign_id=? AND state='queued' GROUP BY step_position")
        .bind(&campaign_id)
        .fetch_all(&state.db)
        .await
        .map_err(err)?;
    let mut waiting: std::collections::HashMap<i64, i64> = std::collections::HashMap::new();
    for row in &waiting_rows {
        waiting.insert(row.get::<i64, _>("step_position"), row.get::<i64, _>("n"));
    }

    // A reply belongs to the step the lead had reached when it arrived: their last send at
    // or before that moment. Without this the funnel would credit every reply to step 0.
    let mut replied_leads: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut bounced_leads: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut replied_at: std::collections::HashMap<i64, std::collections::HashSet<String>> =
        std::collections::HashMap::new();
    for answer in &answers {
        if answer.bounce {
            bounced_leads.insert(answer.lead_id.clone());
            continue;
        }
        replied_leads.insert(answer.lead_id.clone());
        let reached = sends
            .iter()
            .filter(|(lead, _, at)| lead == &answer.lead_id && at.as_str() <= answer.at.as_str())
            .map(|(_, step, _)| *step)
            .max();
        if let Some(step) = reached {
            replied_at.entry(step).or_default().insert(answer.lead_id.clone());
        }
    }

    // One row per step that exists or has ever been sent, so a step added after some
    // sends still appears.
    let top = (steps.len() as i64).max(sends.iter().map(|(_, step, _)| *step).max().unwrap_or(0));
    let mut funnel: Vec<Value> = Vec::new();
    for position in 0..=top {
        funnel.push(json!({
            "position": position,
            "sent": sends.iter().filter(|(_, step, _)| *step == position).count(),
            "replied": replied_at.get(&position).map(|set| set.len()).unwrap_or(0),
            "pending": waiting.get(&position).copied().unwrap_or(0),
        }));
    }

    // How each subject line is doing, so an A/B test can be read rather than guessed. Only
    // built when there is more than one line; one line is not a test.
    let variant_of: std::collections::HashMap<String, i64> = rows
        .iter()
        .filter_map(|r| {
            r.get::<Option<i64>, _>("subject_variant")
                .map(|variant| (r.get::<String, _>("lead_id"), variant))
        })
        .collect();
    let mut subject_stats: Vec<Value> = Vec::new();
    if subjects.len() > 1 {
        for (position, line) in subjects.iter().enumerate() {
            let position = position as i64;
            subject_stats.push(json!({
                "position": position,
                "subject": line,
                "leads": variant_of.values().filter(|variant| **variant == position).count(),
                "sent": sends
                    .iter()
                    .filter(|(lead, step, _)| *step == 0 && variant_of.get(lead) == Some(&position))
                    .count(),
                "replied": replied_leads
                    .iter()
                    .filter(|lead| variant_of.get(*lead) == Some(&position))
                    .count(),
            }));
        }
    }

    let names: std::collections::HashMap<String, String> = rows
        .iter()
        .map(|r| {
            let name = r
                .get::<Option<String>, _>("first_name")
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| r.get::<String, _>("email"));
            (r.get::<String, _>("lead_id"), name)
        })
        .collect();
    let mut recent: Vec<Value> = Vec::new();
    for (lead, step, at) in &sends {
        recent.push(json!({
            "lead_id": lead,
            "name": names.get(lead).cloned().unwrap_or_default(),
            "kind": "sent",
            "step": step,
            "detail": "",
            "at": at,
            "message_id": Value::Null,
        }));
    }
    for answer in &answers {
        recent.push(json!({
            "lead_id": answer.lead_id,
            "name": names.get(&answer.lead_id).cloned().unwrap_or_default(),
            "kind": if answer.bounce { "bounced" } else { "replied" },
            "step": Value::Null,
            "detail": answer.subject,
            "at": answer.at,
            "message_id": answer.message_id,
        }));
    }
    recent.sort_by(|a, b| b["at"].as_str().unwrap_or("").cmp(a["at"].as_str().unwrap_or("")));
    recent.truncate(40);

    Ok(json!({
        "campaign": {
            "id": c.get::<String, _>("id"),
            "name": c.get::<String, _>("name"),
            "status": c.get::<String, _>("status"),
            "mode": c.get::<String, _>("mode"),
            "approved_at": c.get::<Option<String>, _>("approved_at"),
            "template_id": c.get::<Option<String>, _>("template_id"),
            "subject": c.get::<Option<String>, _>("subject"),
            "body": c.get::<Option<String>, _>("body"),
            "list_name": c.get::<Option<String>, _>("list_name"),
            "interval_minutes": c.get::<i64, _>("interval_minutes"),
            "account_id": c.get::<Option<String>, _>("account_id"),
            "last_sent_at": c.get::<Option<String>, _>("last_sent_at"),
            "created_at": c.get::<String, _>("created_at"),
            "timezone": c.get::<Option<String>, _>("timezone"),
            "scheduled_at": c.get::<Option<String>, _>("scheduled_at"),
            "daily_cap": c.get::<Option<i64>, _>("daily_cap"),
        },
        "counts": Value::Object(counts),
        "leads": leads,
        "steps": steps,
        "subjects": subjects,
        "subject_stats": subject_stats,
        "sent": sent,
        "stop_rules": rules,
        "stats": {
            "sent": sends.len(),
            "replied": replied_leads.len(),
            "positive": positive,
            "bounced": bounced_leads.len(),
        },
        "funnel": funnel,
        "recent": recent,
        // Sent as ids so a lead row can say "bounced" without re-running the classifier.
        "bounced": bounced_leads.iter().collect::<Vec<_>>(),
    }))
}

/// Copies a campaign and its sequence into a fresh draft. The audience is deliberately not
/// copied: a duplicate starts empty, so it cannot send to anyone by accident.
#[tauri::command]
async fn duplicate_campaign(state: State<'_, AppState>, campaign_id: String) -> Result<String> {
    let source = sqlx::query("SELECT name,template_id,subject,body,list_name,interval_minutes,account_id,stop_rules,schedule_json,workspace_id,timezone,scheduled_at,daily_cap FROM campaigns WHERE id=?")
        .bind(&campaign_id)
        .fetch_optional(&state.db)
        .await
        .map_err(err)?
        .ok_or("Campaign not found")?;
    let fresh = id();
    let t = now();
    let name = format!("{} (copy)", source.get::<String, _>("name"));
    sqlx::query("INSERT INTO campaigns(id,name,mode,template_id,subject,body,list_name,interval_minutes,account_id,schedule_json,stop_rules,timezone,scheduled_at,daily_cap,workspace_id,created_at,updated_at) VALUES(?,'draft',?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(&fresh)
        .bind(&name)
        .bind(source.get::<Option<String>, _>("template_id"))
        .bind(source.get::<Option<String>, _>("subject"))
        .bind(source.get::<Option<String>, _>("body"))
        .bind(source.get::<Option<String>, _>("list_name"))
        .bind(source.get::<i64, _>("interval_minutes"))
        .bind(source.get::<Option<String>, _>("account_id"))
        .bind(source.get::<String, _>("schedule_json"))
        .bind(source.get::<Option<String>, _>("stop_rules"))
        .bind(source.get::<Option<String>, _>("timezone"))
        .bind(source.get::<Option<String>, _>("scheduled_at"))
        .bind(source.get::<Option<i64>, _>("daily_cap"))
        .bind(source.get::<String, _>("workspace_id"))
        .bind(&t)
        .bind(&t)
        .execute(&state.db)
        .await
        .map_err(err)?;
    // Each step carries its own message, so the copy needs no template lookup.
    sqlx::query("INSERT INTO sequence_steps(id,campaign_id,position,delay_minutes,template_id,body_md,subject_override,enabled,send_date) SELECT lower(hex(randomblob(16))),?,position,delay_minutes,template_id,body_md,subject_override,enabled,send_date FROM sequence_steps WHERE campaign_id=?")
        .bind(&fresh)
        .bind(&campaign_id)
        .execute(&state.db)
        .await
        .map_err(err)?;
    // A duplicated campaign keeps its A/B subject lines, so a test can be picked up from it.
    sqlx::query("INSERT INTO campaign_subjects(id,campaign_id,position,subject,created_at) SELECT lower(hex(randomblob(16))),?,position,subject,? FROM campaign_subjects WHERE campaign_id=?")
        .bind(&fresh)
        .bind(&t)
        .bind(&campaign_id)
        .execute(&state.db)
        .await
        .map_err(err)?;
    log(&state.db, "info", "campaign_duplicated", &format!("{} -> {}", campaign_id, fresh)).await;
    Ok(fresh)
}

/// Writes one campaign's results as a CSV and returns the path it landed at. The webview
/// does not reliably honour a download link, so the file is written by the app itself.
#[tauri::command]
async fn export_campaign_csv(state: State<'_, AppState>, campaign_id: String) -> Result<String> {
    let rows = sqlx::query("SELECT coalesce(l.first_name,'') AS first_name,coalesce(l.company,'') AS company,l.email,cl.state,coalesce(cl.outcome,'') AS outcome,cl.step_position,coalesce(cl.next_due_at,'') AS next_due_at,coalesce((SELECT max(s.created_at) FROM send_logs s WHERE s.campaign_id=cl.campaign_id AND s.lead_id=cl.lead_id),'') AS sent_at FROM campaign_leads cl JOIN leads l ON l.id=cl.lead_id WHERE cl.campaign_id=? ORDER BY l.rowid")
        .bind(&campaign_id)
        .fetch_all(&state.db)
        .await
        .map_err(err)?;
    /// One CSV field: quoted, with its own quotes doubled.
    fn cell(value: &str) -> String {
        format!("\"{}\"", value.replace('"', "\"\""))
    }
    let mut csv = String::from("name,email,company,state,outcome,step,next_due_at,sent_at\n");
    for row in &rows {
        csv.push_str(&format!(
            "{},{},{},{},{},{},{},{}\n",
            cell(&row.get::<String, _>("first_name")),
            cell(&row.get::<String, _>("email")),
            cell(&row.get::<String, _>("company")),
            cell(&row.get::<String, _>("state")),
            cell(&row.get::<String, _>("outcome")),
            row.get::<i64, _>("step_position"),
            cell(&row.get::<String, _>("next_due_at")),
            cell(&row.get::<String, _>("sent_at")),
        ));
    }
    let name = sqlx::query_scalar::<_, String>("SELECT name FROM campaigns WHERE id=?")
        .bind(&campaign_id)
        .fetch_optional(&state.db)
        .await
        .map_err(err)?
        .unwrap_or_else(|| "campaign".into());
    let safe: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    // Downloads next to the user's other files; falls back to the temp directory.
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| std::env::temp_dir().display().to_string());
    let dir = std::path::Path::new(&home).join("Downloads");
    let dir = if dir.is_dir() { dir } else { std::env::temp_dir() };
    let path = dir.join(format!("{}-{}.csv", safe, &campaign_id[..8.min(campaign_id.len())]));
    std::fs::write(&path, csv).map_err(err)?;
    log(&state.db, "info", "campaign_exported", &path.display().to_string()).await;
    Ok(path.display().to_string())
}

/// Stops one lead inside one campaign. Never touches `sequence_steps`: that row is shared
/// by every lead in the campaign, so pausing it would end the step for all of them.
#[tauri::command]
async fn campaign_lead_action(
    state: State<'_, AppState>,
    campaign_id: String,
    lead_id: String,
    action: String,
) -> Result<()> {
    if !matches!(action.as_str(), "skip" | "pause") {
        return Err("Unknown action".into());
    }
    let outcome = if action == "skip" { Some("skipped") } else { None };
    sqlx::query("UPDATE campaign_leads SET state='paused',outcome=COALESCE(?,outcome),next_due_at=NULL WHERE campaign_id=? AND lead_id=? AND state='queued'")
        .bind(outcome)
        .bind(&campaign_id)
        .bind(&lead_id)
        .execute(&state.db)
        .await
        .map_err(err)?;
    sqlx::query("UPDATE jobs SET state='cancelled',updated_at=? WHERE state='queued' AND idempotency_key LIKE ?")
        .bind(now())
        .bind(format!("{}:{}:%", campaign_id, lead_id))
        .execute(&state.db)
        .await
        .map_err(err)?;
    Ok(())
}
/// The categories the knowledge base understands. Mirrored in src/lib/knowledge.ts.
const KNOWLEDGE_CATEGORIES: [&str; 7] = [
    "offer",
    "icp",
    "style",
    "proof",
    "objection",
    "product",
    "other",
];

#[tauri::command]
async fn save_knowledge(state: State<'_, AppState>, input: KnowledgeInput) -> Result<String> {
    let category = input.category.trim().to_lowercase();
    if !KNOWLEDGE_CATEGORIES.contains(&category.as_str()) {
        return Err(format!("Unknown knowledge category: {category}"));
    }
    let title = input.title.trim().to_string();
    if title.is_empty() || input.content.trim().is_empty() {
        return Err("A knowledge entry needs both a title and some content".into());
    }
    let tags = input
        .tags
        .filter(|value| value.is_array())
        .unwrap_or_else(|| json!([]));
    let t = now();
    let entry_id = match input.id.filter(|value| !value.trim().is_empty()) {
        Some(existing) => {
            let updated = sqlx::query(
                "UPDATE knowledge SET category=?,title=?,content=?,approved=?,tags=?,updated_at=? WHERE id=?",
            )
            .bind(&category)
            .bind(&title)
            .bind(&input.content)
            .bind(input.approved as i64)
            .bind(tags.to_string())
            .bind(&t)
            .bind(&existing)
            .execute(&state.db)
            .await
            .map_err(err)?
            .rows_affected();
            if updated == 0 {
                return Err("That knowledge entry no longer exists".into());
            }
            existing
        }
        None => {
            let fresh = id();
            sqlx::query(
                "INSERT INTO knowledge(id,category,title,content,approved,tags,source,workspace_id,created_at,updated_at) VALUES(?,?,?,?,?,?,'manual',?,?,?)",
            )
            .bind(&fresh)
            .bind(&category)
            .bind(&title)
            .bind(&input.content)
            .bind(input.approved as i64)
            .bind(tags.to_string())
            .bind(active_workspace(&state.db).await)
            .bind(&t)
            .bind(&t)
            .execute(&state.db)
            .await
            .map_err(err)?;
            fresh
        }
    };
    Ok(entry_id)
}
#[tauri::command]
async fn delete_knowledge(state: State<'_, AppState>, id: String) -> Result<()> {
    sqlx::query("DELETE FROM knowledge WHERE id=?")
        .bind(id)
        .execute(&state.db)
        .await
        .map_err(err)?;
    Ok(())
}
/// Removes a template. Nothing depends on it any more: a campaign keeps its own copy of the
/// message, so the references left behind are labels, and they are cleared rather than
/// blocking the delete.
#[tauri::command]
async fn delete_template(state: State<'_, AppState>, id: String) -> Result<()> {
    let mut tx = state.db.begin().await.map_err(err)?;
    for statement in [
        "UPDATE campaigns SET template_id=NULL WHERE template_id=?",
        "UPDATE sequence_steps SET template_id=NULL WHERE template_id=?",
        "DELETE FROM templates WHERE id=?",
    ] {
        sqlx::query(statement)
            .bind(&id)
            .execute(&mut *tx)
            .await
            .map_err(err)?;
    }
    tx.commit().await.map_err(err)?;
    log(&state.db, "info", "template_deleted", &id).await;
    Ok(())
}
#[tauri::command]
async fn list_knowledge(
    state: State<'_, AppState>,
    category: Option<String>,
    approved_only: Option<bool>,
) -> Result<Vec<Value>> {
    let mut builder = sqlx::QueryBuilder::new(
        "SELECT id,category,title,content,approved,tags,source,updated_at FROM knowledge WHERE 1=1",
    );
    builder
        .push(" AND workspace_id = ")
        .push_bind(active_workspace(&state.db).await);
    if let Some(name) = category.filter(|value| !value.trim().is_empty()) {
        builder.push(" AND category = ").push_bind(name);
    }
    if approved_only.unwrap_or(false) {
        builder.push(" AND approved = 1");
    }
    builder.push(" ORDER BY weight DESC, updated_at DESC");
    let rows = builder.build().fetch_all(&state.db).await.map_err(err)?;
    Ok(rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<String, _>("id"),
                "category": r.get::<String, _>("category"),
                "title": r.get::<String, _>("title"),
                "content": r.get::<String, _>("content"),
                "approved": r.get::<i64, _>("approved") != 0,
                "tags": serde_json::from_str::<Value>(&r.get::<String, _>("tags")).unwrap_or(json!([])),
                "source": r.get::<String, _>("source"),
                "updated_at": r.get::<String, _>("updated_at"),
            })
        })
        .collect())
}

/// Renders approved entries as one prompt block. This is the single place
/// knowledge reaches a model, used by agents and the reply classifier.
/// An empty category list means every approved entry.
async fn knowledge_context(db: &SqlitePool, categories: &[String]) -> String {
    let mut builder =
        sqlx::QueryBuilder::new("SELECT category,title,content FROM knowledge WHERE approved = 1");
    // A workspace's knowledge is the only knowledge its agents may read.
    builder
        .push(" AND workspace_id = ")
        .push_bind(active_workspace(db).await);
    let wanted: Vec<&String> = categories
        .iter()
        .filter(|value| !value.trim().is_empty())
        .collect();
    if !wanted.is_empty() {
        builder.push(" AND category IN (");
        {
            let mut separated = builder.separated(", ");
            for category in wanted {
                separated.push_bind(category);
            }
            separated.push_unseparated(")");
        }
    }
    builder.push(" ORDER BY weight DESC, updated_at DESC");
    let rows = match builder.build().fetch_all(db).await {
        Ok(rows) => rows,
        Err(_) => return String::new(),
    };

    const BUDGET: usize = 6000;
    let mut out = String::new();
    for row in rows {
        let block = format!(
            "## {} — {}\n{}\n\n",
            row.get::<String, _>("category").to_uppercase(),
            row.get::<String, _>("title"),
            row.get::<String, _>("content").trim()
        );
        if out.len() + block.len() > BUDGET {
            break;
        }
        out.push_str(&block);
    }
    out.trim_end().to_string()
}

/// The exact block a model would receive, so the UI can show it rather than guess.
#[tauri::command]
async fn preview_knowledge(
    state: State<'_, AppState>,
    categories: Option<Vec<String>>,
) -> Result<String> {
    Ok(knowledge_context(&state.db, &categories.unwrap_or_default()).await)
}

/// The loopback address Maily listens on for the OAuth redirect. Registered once in
/// each provider's console; the user never has to see or type it.
const DEFAULT_REDIRECT_URI: &str = "http://127.0.0.1:42813/callback";

fn valid_provider(provider: &str) -> Result<()> {
    if ["gmail", "microsoft"].contains(&provider) {
        Ok(())
    } else {
        Err("Unsupported provider".into())
    }
}

/// The app's own OAuth client for a provider, if one has been saved. Kept in the OS
/// credential vault (never SQLite); environment variables are a fallback so a build
/// can ship a client without any in-app setup. The client id is public, the secret is
/// not — both stay server-side, the UI only learns whether one exists.
fn app_oauth_client(provider: &str) -> Option<(String, Option<String>)> {
    if let Ok(raw) = vault("oauth_clients").and_then(|entry| entry.get_password().map_err(err)) {
        if let Ok(saved) = serde_json::from_str::<Value>(&raw) {
            if let Some(client_id) = saved[provider]["client_id"].as_str().filter(|id| !id.trim().is_empty()) {
                return Some((
                    client_id.to_string(),
                    saved[provider]["client_secret"].as_str().map(str::to_string),
                ));
            }
        }
    }
    let (id_key, secret_key) = if provider == "gmail" {
        ("MAILY_GMAIL_CLIENT_ID", "MAILY_GMAIL_CLIENT_SECRET")
    } else {
        ("MAILY_MICROSOFT_CLIENT_ID", "MAILY_MICROSOFT_CLIENT_SECRET")
    };
    std::env::var(id_key)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(|client_id| (client_id, std::env::var(secret_key).ok()))
}

/// A supplied value wins; otherwise the app's saved client is used.
fn oauth_client_for(provider: &str, supplied: Option<&str>) -> Result<(String, Option<String>)> {
    if let Some(value) = supplied.map(str::trim).filter(|value| !value.is_empty()) {
        return Ok((value.to_string(), None));
    }
    app_oauth_client(provider).ok_or_else(|| {
        format!("No OAuth client saved for {} yet — add one under Advanced.", if provider == "gmail" { "Gmail" } else { "Outlook" })
    })
}

/// Whether one-click connect is available per provider, plus the redirect Maily uses.
/// Never returns the client secret.
#[tauri::command]
async fn oauth_status() -> Result<Value> {
    Ok(json!({
        "redirect_uri": DEFAULT_REDIRECT_URI,
        "providers": {
            "gmail": app_oauth_client("gmail").is_some(),
            "microsoft": app_oauth_client("microsoft").is_some(),
        }
    }))
}

/// Saves the app's OAuth client for a provider so Connect is one click from now on.
#[tauri::command]
async fn save_oauth_client(provider: String, client_id: String, client_secret: Option<String>) -> Result<()> {
    valid_provider(&provider)?;
    let client_id = client_id.trim();
    if client_id.is_empty() {
        return Err("A client ID is required".into());
    }
    let mut saved = vault("oauth_clients")
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    saved[&provider] = json!({
        "client_id": client_id,
        "client_secret": client_secret.as_deref().map(str::trim).filter(|value| !value.is_empty()),
    });
    vault("oauth_clients")?
        .set_password(&saved.to_string())
        .map_err(err)?;
    Ok(())
}

#[tauri::command]
async fn start_oauth(state: State<'_, AppState>, config: OAuthConfig) -> Result<String> {
    valid_provider(&config.provider)?;
    let (client_id, _) = oauth_client_for(&config.provider, config.client_id.as_deref())?;
    let redirect_uri = config
        .redirect_uri
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_REDIRECT_URI)
        .to_string();
    let state_token = id();
    sqlx::query("INSERT INTO oauth_states(state,provider,created_at) VALUES(?,?,?)")
        .bind(&state_token)
        .bind(&config.provider)
        .bind(now())
        .execute(&state.db)
        .await
        .map_err(err)?;
    let (base, scope) = if config.provider == "gmail" {
        // postmaster.traffic.readonly is what v2 of the Postmaster Tools API accepts for
        // reading a domain's statistics. (v1's `postmaster.readonly` is retired.)
        ("https://accounts.google.com/o/oauth2/v2/auth","openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/postmaster.traffic.readonly")
    } else {
        ("https://login.microsoftonline.com/common/oauth2/v2.0/authorize","offline_access https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.Read User.Read")
    };
    Ok(format!("{}?client_id={}&redirect_uri={}&response_type=code&response_mode=query&scope={}&state={}&access_type=offline&prompt=consent",base,urlencoding::encode(&client_id),urlencoding::encode(&redirect_uri),urlencoding::encode(scope),state_token))
}
#[tauri::command]
async fn finish_oauth(state: State<'_, AppState>, data: OAuthCallback) -> Result<Value> {
    let provider: String = sqlx::query_scalar("SELECT provider FROM oauth_states WHERE state=?")
        .bind(&data.state)
        .fetch_optional(&state.db)
        .await
        .map_err(err)?
        .ok_or("OAuth state expired or invalid")?;
    if provider != data.provider {
        return Err("OAuth provider mismatch".into());
    }
    let endpoint = if provider == "gmail" {
        "https://oauth2.googleapis.com/token"
    } else {
        "https://login.microsoftonline.com/common/oauth2/v2.0/token"
    };
    // The one-click flow sends no client id: fall back to the app's saved client, and
    // only take a supplied secret when the caller actually supplied one.
    let (client_id, saved_secret) = oauth_client_for(&provider, data.client_id.as_deref())?;
    let client_secret = data
        .client_secret
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or(saved_secret);
    let redirect_uri = data
        .redirect_uri
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_REDIRECT_URI)
        .to_string();
    let mut form = vec![
        ("client_id", client_id.clone()),
        ("code", data.code),
        ("redirect_uri", redirect_uri),
        ("grant_type", "authorization_code".into()),
    ];
    if let Some(secret) = client_secret.clone() {
        form.push(("client_secret", secret));
    }
    // Read the body even when the status is an error: the provider's
    // `error_description` is the only useful thing to show, and returning early on
    // `error_for_status` would throw it away and leave "HTTP 400" as the message.
    let label = if provider == "gmail" { "Google" } else { "Microsoft" };
    let response = state
        .http
        .post(endpoint)
        .form(&form)
        .send()
        .await
        .map_err(err)?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let token: Value = serde_json::from_str(&body).unwrap_or_else(|_| json!({}));
    if !status.is_success() || token["access_token"].as_str().is_none() {
        let detail = token["error_description"]
            .as_str()
            .or_else(|| token["error"].as_str())
            .unwrap_or_else(|| body.trim());
        let hint = if client_secret.is_none() {
            " (no client secret was saved — Google requires one for desktop clients)"
        } else {
            ""
        };
        let message = format!("{label} refused the sign-in: {detail}{hint}");
        log(&state.db, "error", "oauth_token", &message).await;
        return Err(message);
    }
    let access = token["access_token"]
        .as_str()
        .ok_or("Provider did not issue access token")?
        .to_string();
    let profile_url = if provider == "gmail" {
        "https://www.googleapis.com/oauth2/v2/userinfo"
    } else {
        "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName"
    };
    let profile_response = state
        .http
        .get(profile_url)
        .bearer_auth(&access)
        .send()
        .await
        .map_err(err)?;
    let profile_status = profile_response.status();
    let profile_body = profile_response.text().await.unwrap_or_default();
    let profile: Value = serde_json::from_str(&profile_body).unwrap_or_else(|_| json!({}));
    if !profile_status.is_success() {
        let message = format!(
            "Signed in, but reading the address failed ({profile_status}): {}",
            profile_body.trim()
        );
        log(&state.db, "error", "oauth_profile", &message).await;
        return Err(message);
    }
    let email = profile["email"]
        .as_str()
        .or(profile["mail"].as_str())
        .or(profile["userPrincipalName"].as_str())
        .ok_or("Provider did not return an email address")?
        .to_lowercase();
    // Reuse the existing row's id when this email is already connected, so a reconnect
    // overwrites the same vault entry instead of orphaning the token under a new key.
    let account_id = sqlx::query_scalar::<_, String>("SELECT id FROM accounts WHERE email=?")
        .bind(&email)
        .fetch_optional(&state.db)
        .await
        .map_err(err)?
        .unwrap_or_else(id);
    // Store only what sending and refreshing actually read. The provider's full
    // response also carries an `id_token` (a JWT of well over a kilobyte) and the
    // scope list; written whole, that exceeds the Windows credential blob limit once
    // the OS encodes it as UTF-16.
    let expires_at = Utc::now().timestamp() + token["expires_in"].as_i64().unwrap_or(3600);
    let stored = json!({
        "access_token": access,
        "refresh_token": token["refresh_token"].as_str(),
        "expires_at": expires_at,
        "client_id": client_id,
        "client_secret": client_secret,
        "provider": provider.clone(),
    });
    save_token_blob(&vault(&format!("oauth:{}", account_id))?, &stored)?;
    let t = now();
    sqlx::query("INSERT INTO accounts(id,provider,email,display_name,health,last_health_at,workspace_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET health='healthy',last_health_at=excluded.last_health_at,workspace_id=excluded.workspace_id,updated_at=excluded.updated_at").bind(&account_id).bind(&provider).bind(&email).bind(profile["name"].as_str().or(profile["displayName"].as_str())).bind("healthy").bind(&t).bind(active_workspace(&state.db).await).bind(&t).bind(&t).execute(&state.db).await.map_err(err)?;
    sqlx::query("DELETE FROM oauth_states WHERE state=?")
        .bind(data.state)
        .execute(&state.db)
        .await
        .map_err(err)?;
    log(&state.db, "info", "account_connected", &email).await;
    Ok(json!({"email":email,"provider":provider}))
}

/// The accounts currently connected, for the Settings drawer.
#[tauri::command]
async fn list_accounts(state: State<'_, AppState>) -> Result<Vec<Value>> {
    let rows = sqlx::query("SELECT a.id,a.provider,a.email,a.health,a.daily_limit,a.hourly_limit,a.sent_today,a.last_health_at,a.last_synced_at,(a.sync_cursor IS NOT NULL) AS incremental,(SELECT count(*) FROM inbox_messages m WHERE m.account_id=a.id AND m.read_flag=0 AND m.archived=0 AND m.ours=0 AND m.deleted_at IS NULL) AS unread FROM accounts a WHERE a.workspace_id=? ORDER BY a.email")
        .bind(active_workspace(&state.db).await)
        .fetch_all(&state.db)
        .await
        .map_err(err)?;
    Ok(rows.iter().map(row_json).collect())
}

/// Sets an account's sending caps. `daily_limit` is already enforced by `send_job`;
/// this only exposes it. `hourly_limit` is stored but not yet enforced.
#[tauri::command]
async fn set_account_limits(
    state: State<'_, AppState>,
    id: String,
    daily_limit: i64,
    hourly_limit: i64,
) -> Result<()> {
    let updated = sqlx::query("UPDATE accounts SET daily_limit=?,hourly_limit=?,updated_at=? WHERE id=?")
        .bind(daily_limit.clamp(1, 2000))
        .bind(hourly_limit.clamp(1, 500))
        .bind(now())
        .bind(&id)
        .execute(&state.db)
        .await
        .map_err(err)?
        .rows_affected();
    if updated == 0 {
        return Err("That account no longer exists".into());
    }
    Ok(())
}

/// Forgets a connected account. The stored token is removed first so a failed
/// delete can never leave an account row pointing at credentials that still exist.
#[tauri::command]
async fn disconnect_account(state: State<'_, AppState>, id: String) -> Result<()> {
    if let Ok(entry) = vault(&format!("oauth:{}", id)) {
        let _ = entry.delete_credential();
    }
    // `campaign_leads.account_id` points at the account with a foreign key and no cascade,
    // so the references have to let go before the row can go. A null there means the same
    // thing it means everywhere else: send from whichever account is available.
    let mut tx = state.db.begin().await.map_err(err)?;
    for statement in [
        "UPDATE campaign_leads SET account_id=NULL WHERE account_id=?",
        "UPDATE campaigns SET account_id=NULL WHERE account_id=?",
        "UPDATE message_drafts SET account_id=NULL WHERE account_id=?",
        // This mailbox's mail is ours only while the mailbox is connected.
        "DELETE FROM inbox_messages WHERE account_id=?",
        "DELETE FROM accounts WHERE id=?",
    ] {
        sqlx::query(statement)
            .bind(&id)
            .execute(&mut *tx)
            .await
            .map_err(err)?;
    }
    tx.commit().await.map_err(err)?;
    log(&state.db, "info", "account_disconnected", &id).await;
    Ok(())
}

/// Waits for the operator's browser to land on the loopback redirect the provider
/// was given, then hands the `code` and `state` back to the UI. Only the query is
/// read, so any path under the redirect host works. The provider's exact
/// `redirect_uri` must be registered in its console before connecting.
#[tauri::command]
async fn await_oauth_redirect(
    port: u16,
    expected_state: String,
    timeout_seconds: Option<u64>,
) -> Result<Value> {
    let wait = std::time::Duration::from_secs(timeout_seconds.unwrap_or(300).clamp(15, 900));
    let outcome = tauri::async_runtime::spawn_blocking(move || -> Result<Value> {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind(("127.0.0.1", port)).map_err(|e| {
            format!("Could not listen on 127.0.0.1:{port} for the redirect — is another app using it? ({e})")
        })?;
        listener.set_nonblocking(true).map_err(err)?;
        let deadline = std::time::Instant::now() + wait;
        loop {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let _ = stream.set_nonblocking(false);
                    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(10)));
                    let mut buf = [0u8; 8192];
                    let read = stream.read(&mut buf).unwrap_or(0);
                    let request = String::from_utf8_lossy(&buf[..read]);
                    let target = request.split_whitespace().nth(1).unwrap_or("");
                    let query = target
                        .split_once('?')
                        .map(|(_, rest)| rest.to_string())
                        .unwrap_or_default();
                    let mut code = None;
                    let mut state_value = None;
                    let mut failure = None;
                    for pair in query.split('&') {
                        let (key, raw) = pair.split_once('=').unwrap_or((pair, ""));
                        let value = urlencoding::decode(raw)
                            .map(|owned| owned.into_owned())
                            .unwrap_or_else(|_| raw.to_string());
                        match key {
                            "code" => code = Some(value),
                            "state" => state_value = Some(value),
                            "error" | "error_description" => failure = Some(value),
                            _ => {}
                        }
                    }
                    // This page is written before the token exchange runs, so it must not
                    // claim success — the app is the only place that knows the outcome.
                    let message = if failure.is_some() {
                        "<h1>Connection failed</h1><p>You can close this tab and try again in Maily.</p>"
                    } else {
                        "<h1>Almost done</h1><p>Maily received the response. Close this tab and check the app for the result.</p>"
                    };
                    let page = format!(
                        "<!doctype html><meta charset=utf-8><title>Maily</title><body style=\"font:15px system-ui;padding:48px;color:#111\">{message}</body>"
                    );
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        page.len(),
                        page
                    );
                    let _ = stream.write_all(response.as_bytes());
                    let _ = stream.flush();
                    if let Some(failure) = failure {
                        return Err(format!("The provider refused the connection: {failure}"));
                    }
                    let code = code.ok_or("The redirect did not include an authorization code")?;
                    let state_value =
                        state_value.ok_or("The redirect did not include a state value")?;
                    if state_value != expected_state {
                        return Err(
                            "The OAuth state did not match; the redirect was not accepted".into(),
                        );
                    }
                    return Ok(json!({ "code": code, "state": state_value }));
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if std::time::Instant::now() >= deadline {
                        return Err("Timed out waiting for the browser to finish authorization".into());
                    }
                    std::thread::sleep(std::time::Duration::from_millis(120));
                }
                Err(e) => return Err(format!("Waiting for the browser failed: {e}")),
            }
        }
    })
    .await
    .map_err(err)?;
    outcome
}

/// Kinds a run may use. `followup` and `style_analysis` join the original five.
const AGENT_KINDS: [&str; 7] = [
    "research",
    "qualify",
    "draft",
    "followup",
    "classify_reply",
    "style_analysis",
    "followup_decision",
];

#[tauri::command]
async fn run_agent(state: State<'_, AppState>, input: AgentInput) -> Result<String> {
    run_agent_queued(
        state.inner(),
        &input.kind,
        &input.model,
        input.input,
        input.timeout_seconds,
        input.agent_id.as_deref(),
        input.lead_id.as_deref(),
        input.campaign_id.as_deref(),
    )
    .await
}

/// Queues one agent run and starts it, bounded by the shared semaphore.
async fn run_agent_queued(
    state: &AppState,
    kind: &str,
    model: &str,
    input: Value,
    timeout_seconds: Option<i64>,
    agent_id: Option<&str>,
    lead_id: Option<&str>,
    campaign_id: Option<&str>,
) -> Result<String> {
    if !AGENT_KINDS.contains(&kind) {
        return Err("Unsupported agent task".into());
    }
    // An agent with no model of its own follows the slot chosen in Settings, rather
    // than a model name baked into the app.
    let model = if model.trim().is_empty() {
        model_for(&state.db, slot_for_kind(kind)).await?
    } else {
        model.trim().to_string()
    };
    let x = id();
    let timeout = timeout_seconds.unwrap_or(120).clamp(10, 300);
    sqlx::query("INSERT INTO agent_runs(id,kind,state,model,input_json,timeout_seconds,agent_id,lead_id,campaign_id,workspace_id,created_at) VALUES(?,?,'queued',?,?,?,?,?,?,?,?)")
        .bind(&x)
        .bind(kind)
        .bind(&model)
        .bind(input.to_string())
        .bind(timeout)
        .bind(agent_id)
        .bind(lead_id)
        .bind(campaign_id)
        .bind(active_workspace(&state.db).await)
        .bind(now())
        .execute(&state.db)
        .await
        .map_err(err)?;
    let st = state.clone();
    let job_id = x.clone();
    tokio::spawn(async move {
        let _permit = st.agents.acquire().await;
        if let Err(e) = execute_agent(&st, &job_id).await {
            log(&st.db, "error", "agent", &e).await;
        }
    });
    Ok(x)
}
#[tauri::command]
async fn list_agent_runs(state: State<'_, AppState>, limit: Option<i64>) -> Result<Vec<Value>> {
    let rows = sqlx::query("SELECT id,kind,state,model,input_json,output_json,error,agent_id,lead_id,campaign_id,prompt_tokens,completion_tokens,cost,created_at,finished_at FROM agent_runs WHERE workspace_id=? ORDER BY created_at DESC LIMIT ?")
        .bind(active_workspace(&state.db).await)
        .bind(limit.unwrap_or(50).clamp(1, 200))
        .fetch_all(&state.db)
        .await
        .map_err(err)?;
    Ok(rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<String, _>("id"),
                "kind": r.get::<String, _>("kind"),
                "state": r.get::<String, _>("state"),
                "model": r.get::<String, _>("model"),
                "input": serde_json::from_str::<Value>(&r.get::<String, _>("input_json")).unwrap_or(json!({})),
                "output": r.get::<Option<String>, _>("output_json").and_then(|s| serde_json::from_str::<Value>(&s).ok()),
                "error": r.get::<Option<String>, _>("error"),
                "agent_id": r.get::<Option<String>, _>("agent_id"),
                "lead_id": r.get::<Option<String>, _>("lead_id"),
                "campaign_id": r.get::<Option<String>, _>("campaign_id"),
                "prompt_tokens": r.get::<i64, _>("prompt_tokens"),
                "completion_tokens": r.get::<i64, _>("completion_tokens"),
                "cost": r.get::<f64, _>("cost"),
                "created_at": r.get::<String, _>("created_at"),
                "finished_at": r.get::<Option<String>, _>("finished_at"),
            })
        })
        .collect())
}
#[tauri::command]
async fn list_agents(state: State<'_, AppState>) -> Result<Vec<Value>> {
    let rows = sqlx::query(
        "SELECT a.id,a.name,a.kind,a.model,a.system_prompt,a.knowledge_categories,a.enabled,a.updated_at,(SELECT COALESCE(SUM(r.cost),0.0) FROM agent_runs r WHERE r.agent_id=a.id) AS cost,(SELECT COUNT(*) FROM agent_runs r WHERE r.agent_id=a.id) AS runs FROM agent_defs a WHERE a.workspace_id=? ORDER BY a.kind,a.name",
    )
    .bind(active_workspace(&state.db).await)
    .fetch_all(&state.db)
    .await
    .map_err(err)?;
    Ok(rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<String, _>("id"),
                "name": r.get::<String, _>("name"),
                "kind": r.get::<String, _>("kind"),
                "model": r.get::<String, _>("model"),
                "system_prompt": r.get::<String, _>("system_prompt"),
                "knowledge_categories": serde_json::from_str::<Value>(&r.get::<String, _>("knowledge_categories")).unwrap_or(json!([])),
                "enabled": r.get::<i64, _>("enabled") != 0,
                "cost": r.get::<f64, _>("cost"),
                "runs": r.get::<i64, _>("runs"),
                "updated_at": r.get::<String, _>("updated_at"),
            })
        })
        .collect())
}
#[tauri::command]
async fn save_agent(state: State<'_, AppState>, input: AgentDefInput) -> Result<String> {
    // An empty model is allowed: the agent then follows the model chosen in Settings.
    if input.name.trim().is_empty() {
        return Err("An agent needs a name".into());
    }
    if !AGENT_KINDS.contains(&input.kind.as_str()) {
        return Err("Unsupported agent task".into());
    }
    let categories = input
        .knowledge_categories
        .filter(|value| value.is_array())
        .unwrap_or_else(|| json!([]));
    let prompt = input.system_prompt.unwrap_or_default();
    let enabled = input.enabled.unwrap_or(true) as i64;
    let t = now();
    let agent_id = match input.id.filter(|value| !value.trim().is_empty()) {
        Some(existing) => {
            let updated = sqlx::query(
                "UPDATE agent_defs SET name=?,kind=?,model=?,system_prompt=?,knowledge_categories=?,enabled=?,updated_at=? WHERE id=?",
            )
            .bind(input.name.trim())
            .bind(&input.kind)
            .bind(input.model.trim())
            .bind(&prompt)
            .bind(categories.to_string())
            .bind(enabled)
            .bind(&t)
            .bind(&existing)
            .execute(&state.db)
            .await
            .map_err(err)?
            .rows_affected();
            if updated == 0 {
                return Err("That agent no longer exists".into());
            }
            existing
        }
        None => {
            let fresh = id();
            sqlx::query(
                "INSERT INTO agent_defs(id,name,kind,model,system_prompt,knowledge_categories,enabled,workspace_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
            )
            .bind(&fresh)
            .bind(input.name.trim())
            .bind(&input.kind)
            .bind(input.model.trim())
            .bind(&prompt)
            .bind(categories.to_string())
            .bind(enabled)
            .bind(active_workspace(&state.db).await)
            .bind(&t)
            .bind(&t)
            .execute(&state.db)
            .await
            .map_err(err)?;
            fresh
        }
    };
    Ok(agent_id)
}
#[tauri::command]
async fn delete_agent(state: State<'_, AppState>, id: String) -> Result<()> {
    sqlx::query("DELETE FROM agent_defs WHERE id=?")
        .bind(id)
        .execute(&state.db)
        .await
        .map_err(err)?;
    Ok(())
}
/// Learns the operator's voice from their templates and anything sent since
/// send_logs started keeping bodies, and replaces the previous analysis entry.
#[tauri::command]
async fn analyze_style(state: State<'_, AppState>) -> Result<String> {
    // A style profile is learned from this workspace's own writing, never another's.
    let ws = active_workspace(&state.db).await;
    let templates =
        sqlx::query("SELECT name,subject,body FROM templates WHERE workspace_id=? ORDER BY updated_at DESC LIMIT 30")
            .bind(&ws)
            .fetch_all(&state.db)
            .await
            .map_err(err)?;
    let sent = sqlx::query("SELECT subject,body FROM send_logs WHERE body IS NOT NULL AND workspace_id=? ORDER BY created_at DESC LIMIT 30")
        .bind(&ws)
        .fetch_all(&state.db)
        .await
        .map_err(err)?;
    if templates.is_empty() && sent.is_empty() {
        return Err("Nothing to analyse yet — add a template or send something first".into());
    }

    let mut corpus = String::new();
    for row in &templates {
        corpus.push_str(&format!(
            "--- template: {}\nSubject: {}\n{}\n\n",
            row.get::<String, _>("name"),
            row.get::<String, _>("subject"),
            row.get::<String, _>("body")
        ));
    }
    for row in &sent {
        corpus.push_str(&format!(
            "--- sent message\nSubject: {}\n{}\n\n",
            row.get::<Option<String>, _>("subject").unwrap_or_default(),
            row.get::<Option<String>, _>("body").unwrap_or_default()
        ));
    }

    let model = model_for(&state.db, "style_model").await?;
    let prompt = format!(
        "Study the writing samples below and return strict JSON {{\"title\":\"...\",\"profile\":\"...\",\"rules\":[\"...\"]}}. The profile describes the author's voice in a short paragraph; each rule is one imperative do-or-do-not line a copywriter can follow. Say nothing that the samples do not support.\n\nSamples:\n{}",
        corpus.chars().take(12000).collect::<String>()
    );
    let outcome = llm_json(
        state.inner(),
        &model,
        Some("You analyse writing style and reply with strict JSON only."),
        &prompt,
        180,
    )
    .await?;

    let title = outcome.value["title"]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("Writing style profile")
        .to_string();
    let mut content = outcome.value["profile"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();
    if let Some(rules) = outcome.value["rules"].as_array() {
        let lines: Vec<String> = rules
            .iter()
            .filter_map(|rule| rule.as_str().map(|text| format!("- {}", text.trim())))
            .collect();
        if !lines.is_empty() {
            content.push_str("\n\nRules:\n");
            content.push_str(&lines.join("\n"));
        }
    }
    if content.is_empty() {
        return Err("The model returned an empty style profile".into());
    }

    sqlx::query("DELETE FROM knowledge WHERE category='style' AND source='analysis' AND workspace_id=?")
        .bind(active_workspace(&state.db).await)
        .execute(&state.db)
        .await
        .map_err(err)?;
    let entry = id();
    let t = now();
    sqlx::query("INSERT INTO knowledge(id,category,title,content,approved,tags,source,workspace_id,created_at,updated_at) VALUES(?,'style',?,?,1,'[\"analysis\"]','analysis',?,?,?)")
        .bind(&entry)
        .bind(&title)
        .bind(content.trim())
        .bind(active_workspace(&state.db).await)
        .bind(&t)
        .bind(&t)
        .execute(&state.db)
        .await
        .map_err(err)?;
    Ok(entry)
}
/// Base instructions for a kind, then the agent's own prompt, then the knowledge
/// base entries that agent is scoped to.
async fn build_agent_system(st: &AppState, kind: &str, agent_id: Option<&str>) -> String {
    let mut parts = vec![agent_system_prompt(kind)];
    let mut categories: Vec<String> = Vec::new();
    if let Some(agent_id) = agent_id {
        if let Ok(row) =
            sqlx::query("SELECT system_prompt,knowledge_categories FROM agent_defs WHERE id=?")
                .bind(agent_id)
                .fetch_one(&st.db)
                .await
        {
            let custom: String = row.get("system_prompt");
            if !custom.trim().is_empty() {
                parts.push(custom.trim().to_string());
            }
            categories =
                serde_json::from_str::<Vec<String>>(&row.get::<String, _>("knowledge_categories"))
                    .unwrap_or_default();
        }
    }
    let knowledge = knowledge_context(&st.db, &categories).await;
    if !knowledge.is_empty() {
        parts.push(format!("Knowledge base:\n{knowledge}"));
    }
    parts.join("\n\n")
}

/// A drafting run produces a proposal, never a send.
async fn file_draft(
    st: &AppState,
    run_id: &str,
    agent_id: Option<&str>,
    campaign_id: &str,
    lead_id: &str,
    node_id: Option<&str>,
    model: &str,
    value: &Value,
) {
    let subject = value["subject"].as_str().unwrap_or("").trim();
    let body = value["body"].as_str().unwrap_or("").trim();
    if subject.is_empty() || body.is_empty() {
        return;
    }
    let draft = id();
    let t = now();
    let _ = sqlx::query(
        "INSERT INTO email_drafts(id,campaign_id,lead_id,node_id,agent_id,run_id,subject,body,state,rationale,model,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'proposed',?,?,?,?)",
    )
    .bind(&draft)
    .bind(campaign_id)
    .bind(lead_id)
    .bind(node_id)
    .bind(agent_id)
    .bind(run_id)
    .bind(subject)
    .bind(body)
    .bind(value["rationale"].as_str())
    .bind(model)
    .bind(&t)
    .bind(&t)
    .execute(&st.db)
    .await;
}

async fn execute_agent(st: &AppState, run_id: &str) -> Result<()> {
    let r = sqlx::query("SELECT kind,model,input_json,timeout_seconds,agent_id,lead_id,campaign_id FROM agent_runs WHERE id=?")
        .bind(run_id)
        .fetch_one(&st.db)
        .await
        .map_err(err)?;
    let kind = r.get::<String, _>("kind");
    let model = r.get::<String, _>("model");
    let timeout = r.get::<i64, _>("timeout_seconds") as u64;
    let agent_id: Option<String> = r.get("agent_id");
    let lead_id: Option<String> = r.get("lead_id");
    let campaign_id: Option<String> = r.get("campaign_id");
    let input: Value =
        serde_json::from_str(&r.get::<String, _>("input_json")).unwrap_or_else(|_| json!({}));

    sqlx::query("UPDATE agent_runs SET state='running' WHERE id=?")
        .bind(run_id)
        .execute(&st.db)
        .await
        .map_err(err)?;

    let system = build_agent_system(st, &kind, agent_id.as_deref()).await;
    let outcome = llm_json(
        st,
        &model,
        Some(&system),
        &r.get::<String, _>("input_json"),
        timeout,
    )
    .await;

    match outcome {
        Ok(outcome) => {
            sqlx::query("UPDATE agent_runs SET state='completed',output_json=?,prompt_tokens=?,completion_tokens=?,cost=?,finished_at=? WHERE id=?")
                .bind(outcome.value.to_string())
                .bind(outcome.prompt_tokens)
                .bind(outcome.completion_tokens)
                .bind(outcome.cost)
                .bind(now())
                .bind(run_id)
                .execute(&st.db)
                .await
                .map_err(err)?;
            if matches!(kind.as_str(), "draft" | "followup") {
                if let (Some(campaign_id), Some(lead_id)) =
                    (campaign_id.as_deref(), lead_id.as_deref())
                {
                    file_draft(
                        st,
                        run_id,
                        agent_id.as_deref(),
                        campaign_id,
                        lead_id,
                        input["node_id"].as_str(),
                        &model,
                        &outcome.value,
                    )
                    .await;
                }
            }
            Ok(())
        }
        Err(e) => {
            // A failed run must be visible, not stranded in 'running'.
            sqlx::query("UPDATE agent_runs SET state='failed',error=?,finished_at=? WHERE id=?")
                .bind(&e)
                .bind(now())
                .bind(run_id)
                .execute(&st.db)
                .await
                .ok();
            Err(e)
        }
    }
}
/// The system prompt for an agent kind.
fn agent_system_prompt(kind: &str) -> String {
    let guidance = match kind {
        "draft" | "followup" => {
            "Write in the operator's voice. Never invent facts, metrics, names or claims that were not supplied."
        }
        "research" => {
            "Use only supplied facts and include source URLs. Say unknown when evidence is missing."
        }
        "qualify" => "Judge only on the supplied signals, and say unknown rather than guessing.",
        "classify_reply" => "Classify the reply into exactly one of the allowed labels.",
        _ => "Use only supplied facts.",
    };
    format!(
        "You are Maily's {} agent. Return strict JSON only. {}",
        kind, guidance
    )
}

#[tauri::command]
async fn save_openrouter_key(key: String) -> Result<()> {
    if key.trim().is_empty() {
        return Err("API key is empty".into());
    }
    vault("openrouter_api_key")?
        .set_password(key.trim())
        .map_err(err)
}
#[tauri::command]
async fn openrouter_key_status() -> Result<Value> {
    Ok(json!({"stored": vault("openrouter_api_key")?.get_password().is_ok()}))
}
/// Returns the stored OpenRouter key so its owner can reveal or copy it. Only ever
/// read on an explicit request from the local UI.
#[tauri::command]
async fn reveal_openrouter_key() -> Result<String> {
    openrouter_key()
}

#[tauri::command]
async fn clear_openrouter_key() -> Result<()> {
    if let Err(e) = vault("openrouter_api_key")?.delete_credential() {
        let message = e.to_string().to_lowercase();
        if !message.contains("no entry") && !message.contains("not found") {
            return Err(e.to_string());
        }
    }
    Ok(())
}
/// The OpenRouter catalog, cached in app_settings so the pickers stay usable offline.
#[tauri::command]
async fn list_openrouter_models(
    state: State<'_, AppState>,
    refresh: Option<bool>,
) -> Result<Vec<Value>> {
    if !refresh.unwrap_or(false) {
        if let Some(models) = setting(&state.db, "openrouter_models")
            .await
            .and_then(|cached| cached["models"].as_array().cloned())
        {
            if !models.is_empty() {
                return Ok(models);
            }
        }
    }
    let body: Value = state
        .http
        .get("https://openrouter.ai/api/v1/models")
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("Could not reach OpenRouter: {e}"))?
        .error_for_status()
        .map_err(err)?
        .json()
        .await
        .map_err(err)?;
    let models: Vec<Value> = body["data"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|m| {
            json!({
                "id": m["id"],
                "name": m["name"],
                "context_length": m["context_length"],
                "prompt_price": m["pricing"]["prompt"],
                "completion_price": m["pricing"]["completion"],
            })
        })
        .collect();
    if !models.is_empty() {
        sqlx::query("INSERT INTO app_settings(key,value,updated_at) VALUES('openrouter_models',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
            .bind(json!({"fetched_at": now(), "models": models}).to_string())
            .bind(now())
            .execute(&state.db)
            .await
            .map_err(err)?;
    }
    Ok(models)
}
/// Proves key, routing and JSON parsing work end to end.
#[tauri::command]
async fn test_llm(state: State<'_, AppState>, model: String) -> Result<Value> {
    let started = std::time::Instant::now();
    let outcome = llm_json(
        state.inner(),
        &model,
        Some("You reply with strict JSON only."),
        "Return exactly {\"ok\":true,\"word\":\"maily\"}.",
        45,
    )
    .await?;
    let elapsed = started.elapsed().as_millis() as i64;
    Ok(json!({
        "model": outcome.model,
        "latency_ms": elapsed,
        "sample": outcome.value,
        "cost": outcome.cost,
    }))
}
/// Every workspace, with what each one holds, and which one is open.
#[tauri::command]
async fn list_workspaces(state: State<'_, AppState>) -> Result<Value> {
    let rows = sqlx::query("SELECT w.id,w.name,(SELECT count(*) FROM leads l WHERE l.workspace_id=w.id) AS leads,(SELECT count(*) FROM campaigns c WHERE c.workspace_id=w.id AND c.kind='campaign') AS campaigns,(SELECT count(*) FROM accounts a WHERE a.workspace_id=w.id) AS accounts,(SELECT count(*) FROM templates t WHERE t.workspace_id=w.id) AS templates FROM workspaces w ORDER BY w.created_at")
        .fetch_all(&state.db)
        .await
        .map_err(err)?;
    Ok(json!({
        "active": active_workspace(&state.db).await,
        "workspaces": rows.iter().map(|r| json!({
            "id": r.get::<String,_>("id"),
            "name": r.get::<String,_>("name"),
            "leads": r.get::<i64,_>("leads"),
            "campaigns": r.get::<i64,_>("campaigns"),
            "accounts": r.get::<i64,_>("accounts"),
            "templates": r.get::<i64,_>("templates"),
        })).collect::<Vec<Value>>(),
    }))
}

/// Makes a workspace and switches to it: an empty workspace is the one you were about to
/// fill.
#[tauri::command]
async fn create_workspace(state: State<'_, AppState>, name: String) -> Result<String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("A workspace needs a name".into());
    }
    let fresh = id();
    let stamp = now();
    sqlx::query("INSERT INTO workspaces(id,name,created_at,updated_at) VALUES(?,?,?,?)")
        .bind(&fresh)
        .bind(&name)
        .bind(&stamp)
        .bind(&stamp)
        .execute(&state.db)
        .await
        .map_err(err)?;
    switch_to(&state.db, &fresh).await?;
    log(&state.db, "info", "workspace_created", &name).await;
    Ok(fresh)
}

#[tauri::command]
async fn rename_workspace(state: State<'_, AppState>, id: String, name: String) -> Result<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err("A workspace needs a name".into());
    }
    let updated = sqlx::query("UPDATE workspaces SET name=?,updated_at=? WHERE id=?")
        .bind(name)
        .bind(now())
        .bind(&id)
        .execute(&state.db)
        .await
        .map_err(err)?
        .rows_affected();
    if updated == 0 {
        return Err("That workspace no longer exists".into());
    }
    Ok(())
}

/// Points every scoped query at another workspace. Nothing is moved: the rows already
/// carry the id they belong to.
#[tauri::command]
async fn switch_workspace(state: State<'_, AppState>, id: String) -> Result<()> {
    let exists = sqlx::query_scalar::<_, i64>("SELECT count(*) FROM workspaces WHERE id=?")
        .bind(&id)
        .fetch_one(&state.db)
        .await
        .map_err(err)?;
    if exists == 0 {
        return Err("That workspace no longer exists".into());
    }
    switch_to(&state.db, &id).await
}

/// Writes the active workspace. Also used by `create_workspace`, so creating and
/// switching cannot disagree.
async fn switch_to(db: &SqlitePool, id: &str) -> Result<()> {
    sqlx::query("INSERT INTO app_settings(key,value,updated_at) VALUES('current_workspace',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
        .bind(json!(id).to_string())
        .bind(now())
        .execute(db)
        .await
        .map_err(err)?;
    Ok(())
}

#[tauri::command]
async fn get_settings(state: State<'_, AppState>) -> Result<Value> {
    let rows = sqlx::query("SELECT key,value FROM app_settings")
        .fetch_all(&state.db)
        .await
        .map_err(err)?;
    let mut values = serde_json::Map::new();
    for row in rows {
        values.insert(
            row.get("key"),
            serde_json::from_str(&row.get::<String, _>("value")).unwrap_or(Value::Null),
        );
    }
    Ok(Value::Object(values))
}
#[tauri::command]
async fn save_setting(state: State<'_, AppState>, input: SettingInput) -> Result<()> {
    sqlx::query("INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(input.key).bind(input.value.to_string()).bind(now()).execute(&state.db).await.map_err(err)?;
    Ok(())
}
#[tauri::command]
async fn test_ollama(state: State<'_, AppState>, url: String) -> Result<Vec<Value>> {
    let base = url.trim_end_matches('/');
    let response = state
        .http
        .get(format!("{base}/api/tags"))
        .timeout(std::time::Duration::from_secs(8))
        .send()
        .await
        .map_err(|_| "Could not reach Ollama. Check the server URL and confirm Ollama is running.")?
        .error_for_status()
        .map_err(err)?;
    let body: Value = response.json().await.map_err(err)?;
    Ok(body["models"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|m| json!({"name":m["name"],"size":m["size"],"modified_at":m["modified_at"]}))
        .collect())
}

#[tauri::command]
async fn list_lead_lists(state: State<'_, AppState>) -> Result<Vec<Value>> {
    sqlx::query("SELECT list_name,count(*) AS count FROM leads WHERE workspace_id=? GROUP BY list_name ORDER BY list_name")
        .bind(active_workspace(&state.db).await)
        .fetch_all(&state.db)
        .await
        .map_err(err)
        .map(|rows| {
            rows.iter()
                .map(|r| json!({"name": r.get::<String, _>("list_name"), "count": r.get::<i64, _>("count")}))
                .collect()
        })
}

/// Queues every lead in the campaign's list (or every active lead when the list is
/// empty) and starts the campaign. Doubles as resume: a paused or throttled campaign
/// goes back to `active`, and `INSERT OR IGNORE` leaves already-sent leads alone.
#[tauri::command]
async fn launch_campaign(state: State<'_, AppState>, campaign_id: String) -> Result<usize> {
    let c = sqlx::query("SELECT status,subject,body,list_name,workspace_id FROM campaigns WHERE id=?")
        .bind(&campaign_id)
        .fetch_optional(&state.db)
        .await
        .map_err(err)?
        .ok_or("Campaign not found")?;
    // The first email lives on the campaign itself now, so a template is no longer needed
    // to launch — the message is. What is sent is this copy, never a template.
    let written = |column: &str| {
        c.get::<Option<String>, _>(column)
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
    };
    if !written("subject") || !written("body") {
        return Err("Give the first email a subject and a message before launching".into());
    }
    if c.get::<String, _>("status") == "active" {
        return Err("Campaign is already running".into());
    }
    // Enrolment reads the campaign's own workspace, so a launch can never sweep up
    // another workspace's leads.
    let ws: String = c.get("workspace_id");
    let list = c
        .get::<Option<String>, _>("list_name")
        .unwrap_or_default()
        .trim()
        .to_string();
    let enrolled = if list.is_empty() {
        sqlx::query(
            "INSERT OR IGNORE INTO campaign_leads(campaign_id,lead_id,state) SELECT ?, id, 'queued' FROM leads WHERE status='active' AND workspace_id=? AND email NOT IN (SELECT email FROM suppressions) ORDER BY rowid",
        )
        .bind(&campaign_id)
        .bind(&ws)
        .execute(&state.db)
        .await
        .map_err(err)?
        .rows_affected()
    } else {
        sqlx::query(
            "INSERT OR IGNORE INTO campaign_leads(campaign_id,lead_id,state) SELECT ?, id, 'queued' FROM leads WHERE status='active' AND list_name=? AND workspace_id=? AND email NOT IN (SELECT email FROM suppressions) ORDER BY rowid",
        )
        .bind(&campaign_id)
        .bind(&list)
        .bind(&ws)
        .execute(&state.db)
        .await
        .map_err(err)?
        .rows_affected()
    };
    // Split the audience across the subject lines, so an A/B test is decided up front rather
    // than by send order: a lead's variant is its position among the campaign's enrolments,
    // modulo the number of lines. Enrolment happened in the order the scheduler sends (by
    // lead rowid), so the split is an even A/B/A/B, and a lead keeps the line it was given.
    let variants: i64 = sqlx::query_scalar("SELECT count(*) FROM campaign_subjects WHERE campaign_id=?")
        .bind(&campaign_id)
        .fetch_one(&state.db)
        .await
        .map_err(err)?;
    if variants > 1 {
        sqlx::query("UPDATE campaign_leads SET subject_variant=(SELECT count(*) FROM campaign_leads c WHERE c.campaign_id=campaign_leads.campaign_id AND c.rowid<campaign_leads.rowid) % ? WHERE campaign_id=? AND subject_variant IS NULL")
            .bind(variants)
            .bind(&campaign_id)
            .execute(&state.db)
            .await
            .map_err(err)?;
    }
    // Launching is itself the approval; stamping approved_at is what the send path checks.
    sqlx::query("UPDATE campaigns SET status='active',approved_at=COALESCE(approved_at,?),updated_at=? WHERE id=?")
        .bind(now())
        .bind(now())
        .bind(&campaign_id)
        .execute(&state.db)
        .await
        .map_err(err)?;
    log(
        &state.db,
        "info",
        "campaign_launched",
        &format!("{} newly queued", enrolled),
    )
    .await;
    Ok(enrolled as usize)
}

#[tauri::command]
async fn pause_campaign(state: State<'_, AppState>, campaign_id: String) -> Result<()> {
    sqlx::query("UPDATE campaigns SET status='paused',updated_at=? WHERE id=?")
        .bind(now())
        .bind(&campaign_id)
        .execute(&state.db)
        .await
        .map_err(err)?;
    Ok(())
}

#[tauri::command]
async fn delete_campaign(state: State<'_, AppState>, campaign_id: String) -> Result<()> {
    let mut tx = state.db.begin().await.map_err(err)?;
    // Queued sends are keyed by `campaign:lead:...`, so clear them before the campaign
    // row goes away and the scheduler can no longer resolve it.
    sqlx::query("DELETE FROM jobs WHERE idempotency_key LIKE ?")
        .bind(format!("{}:%", campaign_id))
        .execute(&mut *tx)
        .await
        .map_err(err)?;
    for table in [
        "campaign_leads",
        "campaign_edges",
        "campaign_nodes",
        "sequence_steps",
    ] {
        sqlx::query(&format!("DELETE FROM {} WHERE campaign_id=?", table))
            .bind(&campaign_id)
            .execute(&mut *tx)
            .await
            .map_err(err)?;
    }
    let removed = sqlx::query("DELETE FROM campaigns WHERE id=?")
        .bind(&campaign_id)
        .execute(&mut *tx)
        .await
        .map_err(err)?
        .rows_affected();
    if removed == 0 {
        return Err("Campaign not found".into());
    }
    tx.commit().await.map_err(err)?;
    Ok(())
}

/// The scheduler tick. Sends at most one email per active campaign, spaced by the
/// campaign's interval, to the next lead whose current step has come due. Due times are
/// persisted, so a follow-up that fell due while the app was closed sends on the first
/// tick after launch. A campaign with no account capacity is throttled, and comes back
/// automatically when capacity returns.
async fn process_due(st: &AppState) -> Result<()> {
    reset_sent_today(st).await;

    // A single (`kind='single'`) has no template — its body lives on each step — but it
    // runs through this same tick, because a follow-up is a follow-up.
    let campaigns = sqlx::query(
        "SELECT id,status,account_id,interval_minutes,last_sent_at,workspace_id,scheduled_at,daily_cap FROM campaigns WHERE status IN ('active','throttled') AND (template_id IS NOT NULL OR kind='single')",
    )
    .fetch_all(&st.db)
    .await
    .map_err(err)?;

    for row in campaigns {
        let campaign_id: String = row.get("id");
        let status: String = row.get("status");
        let account: Option<String> = row.get("account_id");
        let interval: i64 = row.get("interval_minutes");
        let last: Option<String> = row.get("last_sent_at");
        // Sending is not gated by the workspace on screen — mail still goes out — but it
        // is gated by the campaign's own workspace, so it never borrows another's mailbox.
        let ws: String = row.get("workspace_id");
        let scheduled: Option<String> = row.get("scheduled_at");
        let cap: Option<i64> = row.get("daily_cap");

        if status == "throttled" {
            if account_available(st, account.as_deref(), Some(&ws)).await? {
                sqlx::query("UPDATE campaigns SET status='active',updated_at=? WHERE id=?")
                    .bind(now())
                    .bind(&campaign_id)
                    .execute(&st.db)
                    .await
                    .map_err(err)?;
            } else {
                continue;
            }
        }

        // A campaign can be held until a date and time. Until then nothing goes out and the
        // campaign keeps its place; once it is due, the pace takes over. There is no daily
        // window, so mail may leave at any hour. Compared to the second, so the two
        // timestamps' suffixes cannot decide it.
        if let Some(at) = scheduled.as_deref() {
            let due = Utc::now().format("%Y-%m-%dT%H:%M:%S").to_string();
            if at.get(..19).unwrap_or(at) > due.as_str() {
                continue;
            }
        }

        // The campaign's own cap sits on top of the account limits, so whichever is lower
        // decides and a mailbox is never pushed past what it is configured to send. It
        // counts UTC days, the same days the account counters roll on.
        if let Some(cap) = cap.filter(|cap| *cap > 0) {
            let sent_today: i64 =
                sqlx::query_scalar("SELECT count(*) FROM send_logs WHERE campaign_id=? AND created_at>=?")
                    .bind(&campaign_id)
                    .bind(day_start())
                    .fetch_one(&st.db)
                    .await
                    .map_err(err)?;
            if sent_today >= cap {
                continue;
            }
        }

        if !interval_elapsed(last.as_deref(), interval) {
            continue;
        }

        // The lead whose current step has come due. A fresh enrolment has no due time
        // and counts as due immediately.
        let due = sqlx::query(
            "SELECT cl.lead_id,cl.step_position FROM campaign_leads cl JOIN leads l ON l.id=cl.lead_id WHERE cl.campaign_id=? AND cl.state='queued' AND l.status='active' AND l.email NOT IN (SELECT email FROM suppressions) AND (cl.next_due_at IS NULL OR cl.next_due_at<=?) ORDER BY (cl.next_due_at IS NULL) DESC, cl.next_due_at ASC, l.rowid ASC LIMIT 1",
        )
        .bind(&campaign_id)
        .bind(now())
        .fetch_optional(&st.db)
        .await
        .map_err(err)?;

        let Some(due) = due else {
            // Nothing due right now. The campaign is finished only when no lead is
            // still waiting on a later step; otherwise it stays active and comes back
            // when the next due time arrives.
            let pending: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM campaign_leads cl JOIN leads l ON l.id=cl.lead_id WHERE cl.campaign_id=? AND cl.state='queued' AND l.status='active' AND l.email NOT IN (SELECT email FROM suppressions)",
            )
            .bind(&campaign_id)
            .fetch_one(&st.db)
            .await
            .map_err(err)?;
            if pending == 0 {
                sqlx::query("UPDATE campaigns SET status='done',updated_at=? WHERE id=?")
                    .bind(now())
                    .bind(&campaign_id)
                    .execute(&st.db)
                    .await
                    .map_err(err)?;
            }
            continue;
        };

        let lead_id: String = due.get("lead_id");
        let step: i64 = due.get("step_position");

        let Some(account_id) = choose_account(st, account.as_deref(), Some(&ws)).await? else {
            sqlx::query("UPDATE campaigns SET status='throttled',updated_at=? WHERE id=?")
                .bind(now())
                .bind(&campaign_id)
                .execute(&st.db)
                .await
                .map_err(err)?;
            log(&st.db, "warn", "campaign_throttled", &campaign_id).await;
            continue;
        };

        let (jid, payload) = ensure_job(st, &campaign_id, &lead_id, &account_id, step).await?;
        match send_job(st, &jid, &payload).await {
            Ok(thread_ref) => {
                if let Some(thread_ref) = thread_ref {
                    sqlx::query("UPDATE campaign_leads SET thread_ref=? WHERE campaign_id=? AND lead_id=?")
                        .bind(thread_ref)
                        .bind(&campaign_id)
                        .bind(&lead_id)
                        .execute(&st.db)
                        .await
                        .map_err(err)?;
                }
                advance_step(st, &campaign_id, &lead_id, step).await?;
                sqlx::query("UPDATE campaigns SET last_sent_at=?,updated_at=? WHERE id=?")
                    .bind(now())
                    .bind(now())
                    .bind(&campaign_id)
                    .execute(&st.db)
                    .await
                    .map_err(err)?;
            }
            Err(e) => {
                log(
                    &st.db,
                    "warn",
                    "campaign_send",
                    &format!("{}: {}", lead_id, e),
                )
                .await
            }
        }
    }
    Ok(())
}

/// Moves a lead to the next enabled follow-up after `from_step`, or finishes the
/// sequence when there is none left. The next step's wait is resolved here, so the due
/// time is persisted and survives an app restart.
async fn advance_step(st: &AppState, campaign_id: &str, lead_id: &str, from_step: i64) -> Result<()> {
    let next = sqlx::query(
        "SELECT position,delay_minutes,delay_days,send_date FROM sequence_steps WHERE campaign_id=? AND enabled=1 AND position>? ORDER BY position LIMIT 1",
    )
    .bind(campaign_id)
    .bind(from_step)
    .fetch_optional(&st.db)
    .await
    .map_err(err)?;

    match next {
        Some(step) => {
            let position: i64 = step.get("position");
            let delay: i64 = step.get("delay_minutes");
            let days: Option<i64> = step.get("delay_days");
            let send_date: Option<String> = step.get("send_date");
            sqlx::query("UPDATE campaign_leads SET step_position=?,next_due_at=?,state='queued' WHERE campaign_id=? AND lead_id=?")
                .bind(position)
                .bind(step_due_at(delay, days.unwrap_or(0), send_date.as_deref()))
                .bind(campaign_id)
                .bind(lead_id)
                .execute(&st.db)
                .await
                .map_err(err)?;
        }
        None => {
            sqlx::query("UPDATE campaign_leads SET state='done',outcome='completed',next_due_at=NULL WHERE campaign_id=? AND lead_id=?")
                .bind(campaign_id)
                .bind(lead_id)
                .execute(&st.db)
                .await
                .map_err(err)?;
        }
    }
    Ok(())
}

/// A wait of 0-20 minutes added to every scheduled send so a list does not go out in
/// lockstep. Derived from the clock, so no random-number dependency is pulled in.
fn jitter_minutes() -> i64 {
    (Utc::now().timestamp_nanos_opt().unwrap_or(0).unsigned_abs() % 21) as i64
}

/// When a follow-up becomes due: an explicit calendar date wins over the delay, and
/// either is delayed by a little jitter. `delay_days` counts calendar days from now —
/// which is the previous step's send, since the next due time is computed right after a
/// send. The result is formatted like `now()` so the two compare correctly in SQL.
fn step_due_at(delay_minutes: i64, delay_days: i64, send_date: Option<&str>) -> String {
    let base = Utc::now();
    let jitter = chrono::Duration::minutes(jitter_minutes());
    if let Some(date) = send_date.map(str::trim).filter(|value| !value.is_empty()) {
        if let Ok(day) = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d") {
            let days = (day - base.date_naive()).num_days();
            return if days > 0 {
                (base + chrono::Duration::days(days) + jitter).to_rfc3339()
            } else {
                (base + jitter).to_rfc3339()
            };
        }
    }
    (base
        + chrono::Duration::minutes(delay_minutes.max(0) + delay_days.max(0) * 1440)
        + jitter)
        .to_rfc3339()
}

/// The first instant of today, UTC, as the timestamps being compared are written. What a
/// campaign's own daily cap counts against.
fn day_start() -> String {
    format!("{}T00:00:00", Utc::now().date_naive())
}

/// Resets each account's daily counter on the first tick after the date rolls over.
async fn reset_sent_today(st: &AppState) {
    let _ = sqlx::query("UPDATE accounts SET sent_today=0,sent_date=date('now') WHERE sent_date IS NULL OR sent_date < date('now')")
        .execute(&st.db)
        .await;
}

/// The account a campaign sends from: its pinned one, or the least-busy connected
/// account that still has daily capacity.
async fn choose_account(
    st: &AppState,
    pinned: Option<&str>,
    workspace: Option<&str>,
) -> Result<Option<String>> {
    if let Some(id) = pinned {
        let capable = sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM accounts WHERE id=? AND sent_today < daily_limit AND (? IS NULL OR workspace_id=?)",
        )
        .bind(id)
        .bind(workspace)
        .bind(workspace)
        .fetch_one(&st.db)
        .await
        .map_err(err)?;
        return Ok((capable > 0).then(|| id.to_string()));
    }
    // A campaign sends from a mailbox in its own workspace, never another one's.
    sqlx::query_scalar::<_, String>(
        "SELECT id FROM accounts WHERE sent_today < daily_limit AND (? IS NULL OR workspace_id=?) ORDER BY sent_today LIMIT 1",
    )
    .bind(workspace)
    .bind(workspace)
    .fetch_optional(&st.db)
    .await
    .map_err(err)
}

async fn account_available(st: &AppState, pinned: Option<&str>, workspace: Option<&str>) -> Result<bool> {
    choose_account(st, pinned, workspace)
        .await
        .map(|value| value.is_some())
}

/// Whether `minutes` have elapsed since the last send (no previous send always counts).
fn interval_elapsed(last: Option<&str>, minutes: i64) -> bool {
    let Some(last) = last else { return true };
    match chrono::DateTime::parse_from_rfc3339(last) {
        Ok(then) => (Utc::now() - then.with_timezone(&Utc)).num_seconds() >= minutes.max(0) * 60,
        Err(_) => true,
    }
}

async fn ensure_job(
    st: &AppState,
    campaign_id: &str,
    lead_id: &str,
    account_id: &str,
    step: i64,
) -> Result<(String, String)> {
    // One idempotency key per step, so a follow-up is a distinct, once-only send.
    let key = format!("{}:{}:step:{}", campaign_id, lead_id, step);
    if let Some(existing) = sqlx::query("SELECT id,payload FROM jobs WHERE idempotency_key=?")
        .bind(&key)
        .fetch_optional(&st.db)
        .await
        .map_err(err)?
    {
        return Ok((existing.get("id"), existing.get("payload")));
    }
    let job = id();
    let payload = json!({"campaign_id":campaign_id,"lead_id":lead_id,"account_id":account_id,"step_position":step}).to_string();
    sqlx::query("INSERT INTO jobs(id,kind,run_at,idempotency_key,payload,created_at,updated_at) VALUES(?,'send',?,?,?,?,?)")
        .bind(&job)
        .bind(now())
        .bind(&key)
        .bind(&payload)
        .bind(now())
        .bind(now())
        .execute(&st.db)
        .await
        .map_err(err)?;
    Ok((job, payload))
}

/// Substitutes `{{key}}` and `{{key|fallback}}` from `lookup`. `escape` is for text on its
/// way into HTML, where a substituted value is content and never markup: a company called
/// `Barnes & Noble` must not become an entity, and a name containing `<` must not open a tag.
fn resolve_variables(text: &str, lookup: &dyn Fn(&str) -> Option<String>, escape: bool) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        match after.find("}}") {
            Some(end) => {
                let (key, fallback) = match after[..end].split_once('|') {
                    Some((key, fallback)) => (key.trim(), Some(fallback.trim())),
                    None => (after[..end].trim(), None),
                };
                let value = match lookup(key).filter(|value| !value.is_empty()) {
                    Some(value) => value,
                    None => fallback.unwrap_or("").to_string(),
                };
                if escape {
                    out.push_str(&escape_html(&value));
                } else {
                    out.push_str(&value);
                }
                rest = &after[end + 2..];
            }
            None => {
                out.push_str("{{");
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// The characters that would otherwise be read as markup. A substituted value is a name, a
/// company, or a column out of a spreadsheet: none of it is HTML, and none of it is ours.
fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// The lead columns a message may interpolate, which is exactly the set the lookup below
/// resolves. Everything else a message can use comes from the headers the import preserved
/// in `custom_fields`, which is why the editor asks for this list instead of keeping one of
/// its own: what it offers and what will actually be filled in cannot drift apart.
const STANDARD_VARIABLES: &[&str] = &[
    "first_name",
    "last_name",
    "company",
    "title",
    "website",
    "list_name",
    "email",
];

fn render(text: &str, lead: &sqlx::sqlite::SqliteRow) -> String {
    resolve_variables(text, &lead_lookup(lead), false)
}

/// The same variables, resolved into HTML rather than text: a campaign step keeps its
/// `{{variables}}` because one step goes to every lead, and this is where they become one
/// lead's words. The substitution is escaped — the value lands inside markup.
fn render_html(text: &str, lead: &sqlx::sqlite::SqliteRow) -> String {
    resolve_variables(text, &lead_lookup(lead), true)
}

/// What a message may ask a lead for: its own columns first, then every header the import
/// preserved in `custom_fields`, so a template can use {{Any CSV Header}} without a schema
/// change.
fn lead_lookup(lead: &sqlx::sqlite::SqliteRow) -> impl Fn(&str) -> Option<String> + '_ {
    let custom = lead
        .try_get::<String, _>("custom_fields")
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
    move |key: &str| -> Option<String> {
        let standard = match key {
            "first_name" => lead.get::<Option<String>, _>("first_name"),
            "last_name" => lead.get::<Option<String>, _>("last_name"),
            "company" => lead.get::<Option<String>, _>("company"),
            "title" => lead.get::<Option<String>, _>("title"),
            "website" => lead.get::<Option<String>, _>("website"),
            "list_name" => Some(lead.get::<String, _>("list_name")),
            "email" => Some(lead.get::<String, _>("email")),
            _ => None,
        };
        if standard.is_some() {
            return standard;
        }
        if let Some(Value::Object(fields)) = &custom {
            if let Some(value) = fields.get(key) {
                return Some(match value {
                    Value::String(value) => value.clone(),
                    Value::Number(value) => value.to_string(),
                    Value::Bool(value) => value.to_string(),
                    _ => String::new(),
                });
            }
        }
        None
    }
}

/// The variables a message may use: the lead's own columns, then every header the lead
/// import kept. Read from the leads that are actually in the workspace rather than a list
/// written down here, so an imported column becomes usable the moment it exists.
#[tauri::command]
async fn message_variables(state: State<'_, AppState>) -> Result<Value> {
    let ws = active_workspace(&state.db).await;
    let rows = sqlx::query("SELECT custom_fields FROM leads WHERE workspace_id=? AND custom_fields IS NOT NULL AND custom_fields<>''")
        .bind(&ws)
        .fetch_all(&state.db)
        .await
        .map_err(err)?;
    let mut headers = std::collections::BTreeSet::new();
    for row in rows {
        let raw: String = row.get("custom_fields");
        if let Ok(Value::Object(fields)) = serde_json::from_str::<Value>(&raw) {
            for (key, value) in fields {
                // A column that never held a value is nothing worth offering.
                let filled = match &value {
                    Value::String(text) => !text.trim().is_empty(),
                    Value::Null => false,
                    _ => true,
                };
                if filled {
                    headers.insert(key);
                }
            }
        }
    }
    Ok(json!({ "standard": STANDARD_VARIABLES, "custom": headers }))
}

/// Marker returned by `deliver` when the provider rejects the token, so the caller can
/// refresh once and retry instead of failing the whole send.
const AUTH_EXPIRED: &str = "__auth_expired__";

/// A currently valid access token for an account, refreshing from the stored refresh
/// token when it is missing, expired, or (with `force`) explicitly rejected. The
/// refreshed token is written back to the vault so later sends reuse it.
async fn access_token(st: &AppState, account_id: &str, provider: &str, force: bool) -> Result<String> {
    let entry = vault(&format!("oauth:{}", account_id))?;
    let raw = entry
        .get_password()
        .map_err(|_| "Account credentials unavailable; reconnect required".to_string())?;
    let mut token: Value = serde_json::from_str(&raw).map_err(err)?;
    if !force {
        if let Some(access) = token["access_token"].as_str() {
            // Refresh two minutes early so a token cannot expire mid-request.
            let still_valid = token["expires_at"]
                .as_i64()
                .map(|at| Utc::now().timestamp() < at - 120)
                .unwrap_or(false);
            if still_valid {
                return Ok(access.to_string());
            }
        }
    }
    let access = refresh_token(st, &mut token, provider).await?;
    save_token_blob(&entry, &token)?;
    Ok(access)
}

/// Exchanges the stored refresh token for a new access token, updating `token` in place
/// with the new access token, expiry, and any rotated refresh token.
async fn refresh_token(st: &AppState, token: &mut Value, provider: &str) -> Result<String> {
    let refresh = token["refresh_token"]
        .as_str()
        .ok_or("Account has no refresh token; reconnect it in Settings")?
        .to_string();
    let client_id = token["client_id"]
        .as_str()
        .ok_or("Account is missing its OAuth client id; reconnect it in Settings")?
        .to_string();
    let endpoint = if provider == "gmail" {
        "https://oauth2.googleapis.com/token"
    } else {
        "https://login.microsoftonline.com/common/oauth2/v2.0/token"
    };
    let mut form = vec![
        ("client_id", client_id),
        ("refresh_token", refresh),
        ("grant_type", "refresh_token".to_string()),
    ];
    if let Some(secret) = token["client_secret"].as_str() {
        form.push(("client_secret", secret.to_string()));
    }
    let response: Value = st
        .http
        .post(endpoint)
        .form(&form)
        .send()
        .await
        .map_err(err)?
        .error_for_status()
        .map_err(err)?
        .json()
        .await
        .map_err(err)?;
    let access = response["access_token"]
        .as_str()
        .ok_or("Provider did not return a refreshed access token; reconnect in Settings")?
        .to_string();
    let expires_at = Utc::now().timestamp() + response["expires_in"].as_i64().unwrap_or(3600);
    if let Some(obj) = token.as_object_mut() {
        obj.insert("access_token".into(), Value::String(access.clone()));
        obj.insert("expires_at".into(), json!(expires_at));
        if let Some(rotated) = response["refresh_token"].as_str() {
            obj.insert("refresh_token".into(), Value::String(rotated.to_string()));
        }
    }
    Ok(access)
}

/// The permissions an account's token actually carries. A provider that refuses a send
/// with a bare 403 is almost always answering a token that was granted less than it
/// asked for, and this is the only way to find that out without opening the consent
/// screen in the provider's console.
async fn token_scopes(st: &AppState, account_id: &str, provider: &str) -> Result<Vec<String>> {
    let access = access_token(st, account_id, provider, false).await?;
    if provider == "gmail" {
        let body: Value = st
            .http
            .get("https://oauth2.googleapis.com/tokeninfo")
            .query(&[("access_token", access.as_str())])
            .send()
            .await
            .map_err(err)?
            .json()
            .await
            .map_err(err)?;
        return Ok(body["scope"]
            .as_str()
            .unwrap_or_default()
            .split_whitespace()
            // `.../auth/gmail.send` reads better as `gmail.send`.
            .map(|scope| scope.rsplit('/').next().unwrap_or(scope).to_string())
            .collect());
    }
    // A Microsoft access token is a JWT and its payload lists the granted scopes.
    // Nothing is verified here — this only reports what the token says about itself.
    let payload = access
        .split('.')
        .nth(1)
        .ok_or("Microsoft issued a token that is not a JWT")?;
    let claims: Value = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(payload.trim_end_matches('='))
            .map_err(|_| "Microsoft issued a token that is not a JWT")?,
    )
    .map_err(err)?;
    Ok(claims["scp"]
        .as_str()
        .unwrap_or_default()
        .split_whitespace()
        .map(str::to_string)
        .collect())
}

/// The scope a provider requires before it will send anything.
fn sending_scope(provider: &str) -> &'static str {
    if provider == "gmail" {
        "gmail.send"
    } else {
        "Mail.Send"
    }
}

fn grants_sending(scopes: &[String], provider: &str) -> bool {
    let wanted = sending_scope(provider);
    scopes.iter().any(|scope| scope.eq_ignore_ascii_case(wanted))
}

/// Whether an account's token may send. A token that cannot be inspected is not evidence
/// of a problem, so the send itself is left to be the judge.
async fn can_send(st: &AppState, account_id: &str, provider: &str) -> bool {
    match token_scopes(st, account_id, provider).await {
        Ok(scopes) => grants_sending(&scopes, provider),
        Err(_) => true,
    }
}

/// Addresses in a `Cc:`/`Bcc:` header or a Graph recipient list. Comma and semicolon
/// both separate, because that is how they get pasted in.
fn recipient_list(value: &str) -> Vec<String> {
    value
        .split([',', ';'])
        .map(str::trim)
        .filter(|address| address.contains('@'))
        .map(str::to_string)
        .collect()
}

/// The raw MIME for a message. A rendered email goes out as `multipart/alternative`, so
/// a plain-text reader still gets a sane body; a campaign template has no HTML and stays
/// a single `text/plain` part. Every part is base64 so no line of the body can be
/// mistaken for a MIME boundary.
fn mime_message(mail: &Mail) -> String {
    let mut raw = String::new();
    raw.push_str(&format!("From: {}\r\n", mail.from));
    raw.push_str(&format!("To: {}\r\n", mail.to));
    if !mail.cc.trim().is_empty() {
        raw.push_str(&format!("Cc: {}\r\n", mail.cc));
    }
    // Gmail delivers the blind copies and strips this header from what the recipient
    // sees, which is the only way a Bcc can travel through the API.
    if !mail.bcc.trim().is_empty() {
        raw.push_str(&format!("Bcc: {}\r\n", mail.bcc));
    }
    raw.push_str(&format!("Subject: {}\r\n", mail.subject));
    raw.push_str("MIME-Version: 1.0\r\n");
    let Some(html) = mail.html else {
        raw.push_str("Content-Type: text/plain; charset=\"UTF-8\"\r\n\r\n");
        raw.push_str(mail.text);
        return raw;
    };
    let boundary = format!("maily-{}", Uuid::new_v4().simple());
    raw.push_str(&format!(
        "Content-Type: multipart/alternative; boundary=\"{boundary}\"\r\n\r\n"
    ));
    for (kind, content) in [("text/plain", mail.text), ("text/html", html)] {
        raw.push_str(&format!("--{boundary}\r\n"));
        raw.push_str(&format!("Content-Type: {kind}; charset=\"UTF-8\"\r\n"));
        raw.push_str("Content-Transfer-Encoding: base64\r\n\r\n");
        let encoded = STANDARD.encode(content);
        for chunk in encoded.as_bytes().chunks(76) {
            raw.push_str(&String::from_utf8_lossy(chunk));
            raw.push_str("\r\n");
        }
    }
    raw.push_str(&format!("--{boundary}--\r\n"));
    raw
}

/// A provider response as a `Result`. A rejected token maps to the marker the send path
/// retries on; anything else carries the provider's own explanation, because "403
/// Forbidden" on its own says nothing about what was actually wrong.
async fn checked(response: reqwest::Response) -> Result<reqwest::Response> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let body = response.text().await.unwrap_or_default();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(AUTH_EXPIRED.to_string());
    }
    Err(provider_message(status, &body))
}

/// The provider's reason, dug out of its error body when it sends one. Google and
/// Microsoft both hang the readable part off `error.message`, with a machine-readable
/// code alongside it.
fn provider_message(status: reqwest::StatusCode, body: &str) -> String {
    let parsed = serde_json::from_str::<Value>(body).ok();
    let message = parsed
        .as_ref()
        .and_then(|value| value["error"]["message"].as_str())
        .map(str::to_string)
        .filter(|text| !text.trim().is_empty())
        .unwrap_or_else(|| body.trim().chars().take(300).collect());
    let reason = parsed
        .as_ref()
        .and_then(|value| {
            value["error"]["errors"]
                .as_array()
                .and_then(|list| list.first())
                .and_then(|first| first["reason"].as_str())
                .or_else(|| value["error"]["status"].as_str())
                .or_else(|| value["error"]["code"].as_str())
        })
        .unwrap_or("")
        .to_string();
    // A bare 403 is how Google reports a token that is allowed to read but not to send.
    // Nothing about that improves by trying again.
    let hint = if status == reqwest::StatusCode::FORBIDDEN {
        let lower = format!("{reason} {message}").to_lowercase();
        if lower.contains("permission") || lower.contains("scope") {
            " — this account is connected without permission to send. Disconnect it and connect it again in Settings."
        } else {
            " — the provider refused the message itself."
        }
    } else {
        ""
    };
    let reason = if reason.is_empty() {
        String::new()
    } else {
        format!(" [{reason}]")
    };
    format!("{status}{reason}: {message}{hint}")
}

/// Posts one message through the provider. Gmail threads from `Mail::thread` (a thread
/// id); Microsoft from the same field (the RFC Message-ID of the message being replied
/// to). Missing threading data never blocks a send. Returns the parsed response.
async fn deliver(st: &AppState, provider: &str, access: &str, mail: &Mail<'_>) -> Result<Value> {
    let response = if provider == "gmail" {
        let mut request = json!({"raw": URL_SAFE_NO_PAD.encode(mime_message(mail))});
        if let Some(thread) = mail.thread {
            request["threadId"] = json!(thread);
        }
        st.http
            .post("https://gmail.googleapis.com/gmail/v1/users/me/messages/send")
            .bearer_auth(access)
            .json(&request)
            .send()
            .await
            .map_err(err)?
    } else {
        // Graph takes one body and no plain-text alternative, so a rendered message
        // arrives as HTML and a template arrives as text.
        let mut message = json!({
            "subject": mail.subject,
            "body": {
                "contentType": if mail.html.is_some() { "HTML" } else { "Text" },
                "content": mail.html.unwrap_or(mail.text),
            },
            "toRecipients": [{"emailAddress":{"address": mail.to}}],
        });
        let cc = recipient_list(mail.cc);
        if !cc.is_empty() {
            message["ccRecipients"] = json!(cc
                .iter()
                .map(|a| json!({"emailAddress":{"address":a}}))
                .collect::<Vec<_>>());
        }
        let bcc = recipient_list(mail.bcc);
        if !bcc.is_empty() {
            message["bccRecipients"] = json!(bcc
                .iter()
                .map(|a| json!({"emailAddress":{"address":a}}))
                .collect::<Vec<_>>());
        }
        if let Some(reference) = mail.thread {
            message["internetMessageHeaders"] = json!([
                {"name":"In-Reply-To","value":format!("<{}>", reference)},
                {"name":"References","value":format!("<{}>", reference)}
            ]);
        }
        st.http
            .post("https://graph.microsoft.com/v1.0/me/sendMail")
            .bearer_auth(access)
            .json(&json!({"message": message}))
            .send()
            .await
            .map_err(err)?
    };
    let response = checked(response).await?;
    if provider == "gmail" {
        response.json().await.map_err(err)
    } else {
        Ok(json!({}))
    }
}

/// Sends one step and returns the thread reference to remember for this lead, if the
/// send just opened a thread that follow-ups must join.
async fn send_job(st: &AppState, jid: &str, payload: &str) -> Result<Option<String>> {
    let p: Value = serde_json::from_str(payload).map_err(err)?;
    let campaign = p["campaign_id"].as_str().ok_or("Missing campaign id")?;
    let lead_id = p["lead_id"].as_str().ok_or("Missing lead id")?;
    let account_id = p["account_id"].as_str().ok_or("Missing account id")?;
    let step = p["step_position"].as_i64().unwrap_or(0);
    let lead=sqlx::query("SELECT * FROM leads WHERE id=? AND status='active' AND email NOT IN (SELECT email FROM suppressions)").bind(lead_id).fetch_optional(&st.db).await.map_err(err)?.ok_or("Lead is suppressed, inactive, or missing")?;
    let c=sqlx::query("SELECT status,approved_at,kind,workspace_id FROM campaigns WHERE id=?").bind(campaign).fetch_optional(&st.db).await.map_err(err)?.ok_or("Campaign not found")?;
    if c.get::<String, _>("status") != "active"
        || c.get::<Option<String>, _>("approved_at").is_none()
    {
        return Err("Campaign is paused, cancelled, or unapproved".into());
    }
    let kind: String = c.get("kind");
    let ws: String = c.get("workspace_id");

    // A follow-up replies in the thread the first email opened.
    let thread_ref: Option<String> = sqlx::query_scalar("SELECT thread_ref FROM campaign_leads WHERE campaign_id=? AND lead_id=?")
        .bind(campaign)
        .bind(lead_id)
        .fetch_optional(&st.db)
        .await
        .map_err(err)?
        .flatten()
        .filter(|_| step > 0);

    // The message source. It is always a stored copy: a single's step, a campaign's step,
    // and a campaign's first touch all carry their own message. No template is read here,
    // which is what stops an edit to one from changing what goes out.
    let (subject_source, markdown_source, body, html_source, step_id): (
        String,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
    ) = if kind == "single" {
            let row = sqlx::query("SELECT id,body_md,body_html,body_text,subject_override FROM sequence_steps WHERE campaign_id=? AND position=? AND enabled=1")
                .bind(campaign)
                .bind(step)
                .fetch_optional(&st.db)
                .await
                .map_err(err)?
                .ok_or("This follow-up step no longer exists")?;
            // The subject the sender typed, else the original's title with a `Re:`.
            let subject = match row
                .get::<Option<String>, _>("subject_override")
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
            {
                Some(written) => written,
                None => {
                    let original: Option<String> = sqlx::query_scalar::<_, Option<String>>(
                        "SELECT subject FROM send_logs WHERE campaign_id=? ORDER BY created_at LIMIT 1",
                    )
                    .bind(campaign)
                    .fetch_optional(&st.db)
                    .await
                    .map_err(err)?
                    .flatten();
                    let original = original.unwrap_or_default();
                    let original = original.trim();
                    if original.is_empty() || original.to_lowercase().starts_with("re:") {
                        original.to_string()
                    } else {
                        format!("Re: {original}")
                    }
                }
            };
            let text = row
                .get::<Option<String>, _>("body_text")
                .or_else(|| row.get::<Option<String>, _>("body_md"))
                .unwrap_or_default();
            let html = row
                .get::<Option<String>, _>("body_html")
                .filter(|value| !value.trim().is_empty());
            (
                subject,
                row.get::<Option<String>, _>("body_md"),
                text,
                html,
                Some(row.get::<String, _>("id")),
            )
        } else if step == 0 {
            // The campaign's first touch: the copy taken when it was set up.
            let source = sqlx::query("SELECT subject,body FROM campaigns WHERE id=?")
                .bind(campaign)
                .fetch_optional(&st.db)
                .await
                .map_err(err)?
                .ok_or("Campaign not found")?;
            let body = source
                .get::<Option<String>, _>("body")
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .ok_or("This campaign has no first message yet")?;
            // The campaign's own subject is the fallback; when the audience was split, this
            // lead's line is the one its variant points at. Selection happens before the
            // variables are resolved, so each line interpolates like any other.
            let fallback = source
                .get::<Option<String>, _>("subject")
                .map(|value| value.trim().to_string())
                .unwrap_or_default();
            let subject = match sqlx::query_scalar::<_, Option<i64>>(
                "SELECT subject_variant FROM campaign_leads WHERE campaign_id=? AND lead_id=?",
            )
            .bind(campaign)
            .bind(lead_id)
            .fetch_optional(&st.db)
            .await
            .map_err(err)?
            .flatten()
            {
                Some(index) => sqlx::query_scalar::<_, String>(
                    "SELECT subject FROM campaign_subjects WHERE campaign_id=? AND position=?",
                )
                .bind(campaign)
                .bind(index)
                .fetch_optional(&st.db)
                .await
                .map_err(err)?
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or(fallback),
                None => fallback,
            };
            (subject, None, body, None, None)
        } else {
            // A campaign follow-up carries its own copy too, so this is a plain read. It
            // deliberately hands back no step id: this row is shared by every lead in the
            // campaign, and one lead replying must not cancel the step for the rest.
            let row = sqlx::query("SELECT subject_override,body_md,body_html,body_text FROM sequence_steps WHERE campaign_id=? AND position=? AND enabled=1")
                .bind(campaign)
                .bind(step)
                .fetch_optional(&st.db)
                .await
                .map_err(err)?
                .ok_or("This follow-up step no longer exists")?;
            let markdown = row.get::<Option<String>, _>("body_md");
            let text = row
                .get::<Option<String>, _>("body_text")
                .or_else(|| markdown.clone())
                .unwrap_or_default();
            let html = row
                .get::<Option<String>, _>("body_html")
                .filter(|value| !value.trim().is_empty());
            let subject = row
                .get::<Option<String>, _>("subject_override")
                .map(|value| value.trim().to_string())
                .unwrap_or_default();
            (subject, markdown, text, html, None)
        };

    // The guard for a single, evaluated in one transaction right before the send, so a
    // reply or a suppression that landed since the last tick can never be overtaken. A
    // step that fails the guard is marked `skipped` with the reason rather than retried.
    if let Some(step_id) = &step_id {
        let mut tx = st.db.begin().await.map_err(err)?;
        let status: Option<String> = sqlx::query_scalar("SELECT status FROM sequence_steps WHERE id=?")
            .bind(step_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(err)?;
        if status.as_deref() != Some("pending") {
            tx.rollback().await.ok();
            return Err("This follow-up is no longer pending".into());
        }
        let replied: i64 = match &thread_ref {
            Some(thread) => sqlx::query_scalar(
                "SELECT count(*) FROM inbox_messages WHERE ours=0 AND deleted_at IS NULL AND thread_id=?",
            )
            .bind(thread)
            .fetch_one(&mut *tx)
            .await
            .map_err(err)?,
            None => 0,
        };
        if replied > 0 {
            sqlx::query("UPDATE sequence_steps SET status='cancelled',skip_reason='replied' WHERE id=?")
                .bind(step_id)
                .execute(&mut *tx)
                .await
                .map_err(err)?;
            tx.commit().await.map_err(err)?;
            return Err("The thread has a reply; follow-up cancelled".into());
        }
        let suppressed: i64 = sqlx::query_scalar("SELECT count(*) FROM suppressions WHERE email=?")
            .bind(lead.get::<String, _>("email"))
            .fetch_one(&mut *tx)
            .await
            .map_err(err)?;
        if suppressed > 0 {
            sqlx::query("UPDATE sequence_steps SET status='skipped',skip_reason='suppressed' WHERE id=?")
                .bind(step_id)
                .execute(&mut *tx)
                .await
                .map_err(err)?;
            tx.commit().await.map_err(err)?;
            return Err("Lead is suppressed; follow-up skipped".into());
        }
        tx.commit().await.map_err(err)?;
    } else if step > 0 {
        // A campaign's step row is shared by every lead in it, so the reply check has to be
        // per lead and it must not touch the row: one lead answering stops that lead's
        // follow-ups only, and everyone else still gets this step. Evaluated in one
        // transaction right before the send, so a reply that landed since the last tick is
        // still seen.
        let mut tx = st.db.begin().await.map_err(err)?;
        let state: Option<String> =
            sqlx::query_scalar("SELECT state FROM campaign_leads WHERE campaign_id=? AND lead_id=?")
                .bind(campaign)
                .bind(lead_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(err)?;
        if state.as_deref() != Some("queued") {
            tx.rollback().await.ok();
            return Err("That lead is no longer waiting on this step".into());
        }
        let replied: i64 = match &thread_ref {
            Some(thread) => sqlx::query_scalar(
                "SELECT count(*) FROM inbox_messages WHERE ours=0 AND deleted_at IS NULL AND thread_id=?",
            )
            .bind(thread)
            .fetch_one(&mut *tx)
            .await
            .map_err(err)?,
            None => 0,
        };
        if replied > 0 {
            // Stop this lead and only this lead. The step stays `pending` for everyone else.
            sqlx::query("UPDATE campaign_leads SET state='paused' WHERE campaign_id=? AND lead_id=? AND state='queued'")
                .bind(campaign)
                .bind(lead_id)
                .execute(&mut *tx)
                .await
                .map_err(err)?;
            sqlx::query("UPDATE jobs SET state='cancelled',updated_at=? WHERE state='queued' AND idempotency_key LIKE ?")
                .bind(now())
                .bind(format!("{}:{}:%", campaign, lead_id))
                .execute(&mut *tx)
                .await
                .map_err(err)?;
            tx.commit().await.map_err(err)?;
            log(&st.db, "info", "followup_held", &format!("{} replied", lead_id)).await;
            return Err("The thread has a reply; follow-up held".into());
        }
        tx.commit().await.map_err(err)?;
    }
    let a = sqlx::query("SELECT provider,email,daily_limit,sent_today FROM accounts WHERE id=?")
        .bind(account_id)
        .fetch_one(&st.db)
        .await
        .map_err(err)?;
    if a.get::<i64, _>("sent_today") >= a.get::<i64, _>("daily_limit") {
        return Err("Account daily sending limit reached".into());
    }
    let provider = a.get::<String, _>("provider");
    let from = a.get::<String, _>("email");
    let to = lead.get::<String, _>("email");
    let mut subject = render(&subject_source, &lead);
    // A template's body still resolves its variables against the lead; a single's step
    // arrived already rendered, so this is a no-op for it.
    let body = render(&body, &lead);
    // A campaign step keeps its `{{variables}}` in the stored HTML, because the one step
    // goes to every lead; this is where they become this lead's words. A single's step
    // arrived resolved already, which resolves to itself.
    let html = html_source.as_deref().map(|html| render_html(html, &lead));
    // Never send a literal placeholder: block the send and flag the lead for review.
    if subject.contains("{{")
        || body.contains("{{")
        || html.as_deref().is_some_and(|html| html.contains("{{"))
    {
        sqlx::query("UPDATE leads SET status='needs_attention',updated_at=? WHERE id=?")
            .bind(now())
            .bind(lead_id)
            .execute(&st.db)
            .await
            .map_err(err)?;
        log(&st.db, "warn", "template_variable_missing", lead_id).await;
        return Err("Template has unresolved variables; send blocked and lead flagged".into());
    }
    if thread_ref.is_some() && !subject.to_lowercase().starts_with("re:") {
        subject = format!("Re: {}", subject);
    }
    // Both halves when the step carries a rendered pair, the text alone when there is none —
    // a campaign's first touch is still written as plain text.
    let mail = Mail {
        from: &from,
        to: &to,
        cc: "",
        bcc: "",
        subject: &subject,
        text: &body,
        html: html.as_deref(),
        thread: thread_ref.as_deref(),
    };
    let mut access = access_token(st, account_id, &provider, false).await?;
    let response = match deliver(st, &provider, &access, &mail).await {
        Ok(response) => response,
        Err(e) if e == AUTH_EXPIRED => {
            access = access_token(st, account_id, &provider, true).await?;
            deliver(st, &provider, &access, &mail).await?
        }
        Err(e) => return Err(e),
    };
    // The first email is the one that opens the thread; capture its reference so
    // follow-ups can reply into it. Best effort: failure just leaves follow-ups
    // unthreaded, it never blocks the send.
    let captured = if step == 0 && thread_ref.is_none() {
        thread_reference(st, &provider, &access, &response).await
    } else {
        None
    };
    // The conversation this step joined, so the reply it earns can be read against the
    // step that prompted it. Gmail reports the thread on the send itself; Microsoft's
    // sendMail returns nothing, so the reference the opening step captured stands in.
    let thread_id = response["threadId"]
        .as_str()
        .map(str::to_string)
        .or_else(|| thread_ref.clone())
        .or_else(|| captured.clone());
    sqlx::query("INSERT INTO send_logs(id,job_id,campaign_id,lead_id,account_id,to_email,provider_message_id,thread_id,subject,body,markdown,html,step_position,status,workspace_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'sent',?,?)")
        .bind(id())
        .bind(jid)
        .bind(campaign)
        .bind(lead_id)
        .bind(account_id)
        .bind(&to)
        .bind(response["id"].as_str())
        .bind(&thread_id)
        .bind(&subject)
        .bind(&body)
        .bind(&markdown_source)
        .bind(&html)
        .bind(step)
        .bind(&ws)
        .bind(now())
        .execute(&st.db)
        .await
        .map_err(err)?;
    // The step is away: it is no longer pending, so the guard cannot re-send it.
    if let Some(step_id) = &step_id {
        sqlx::query("UPDATE sequence_steps SET status='sent',sent_at=?,skip_reason=NULL WHERE id=?")
            .bind(now())
            .bind(step_id)
            .execute(&st.db)
            .await
            .map_err(err)?;
    }
    sqlx::query("UPDATE accounts SET sent_today=sent_today+1,health='healthy',last_health_at=?,updated_at=? WHERE id=?").bind(now()).bind(now()).bind(account_id).execute(&st.db).await.map_err(err)?;
    Ok(captured)
}

/// Answers inside the original conversation rather than starting a second thread with
/// the same person. Gmail joins by the thread id it reports for the original message.
/// Microsoft has no reply call that takes HTML, so it builds the reply draft, replaces
/// its body, then sends it.
async fn deliver_reply(
    st: &AppState,
    provider: &str,
    access: &str,
    mail: &Mail<'_>,
    original: &str,
) -> Result<Value> {
    if provider != "gmail" {
        let draft: Value = checked(
            st.http
                .post(format!(
                    "https://graph.microsoft.com/v1.0/me/messages/{original}/createReply"
                ))
                .bearer_auth(access)
                .json(&json!({}))
                .send()
                .await
                .map_err(err)?,
        )
        .await?
        .json()
        .await
        .map_err(err)?;
        let draft_id = draft["id"]
            .as_str()
            .ok_or("Microsoft did not return a reply to fill in")?;
        checked(
            st.http
                .patch(format!(
                    "https://graph.microsoft.com/v1.0/me/messages/{draft_id}"
                ))
                .bearer_auth(access)
                .json(&json!({
                    // createReply titles the draft itself; this keeps a subject the
                    // sender changed.
                    "subject": mail.subject,
                    "body": {
                        "contentType": if mail.html.is_some() { "HTML" } else { "Text" },
                        "content": mail.html.unwrap_or(mail.text),
                    },
                }))
                .send()
                .await
                .map_err(err)?,
        )
        .await?;
        checked(
            st.http
                .post(format!(
                    "https://graph.microsoft.com/v1.0/me/messages/{draft_id}/send"
                ))
                .bearer_auth(access)
                .send()
                .await
                .map_err(err)?,
        )
        .await?;
        return Ok(json!({}));
    }
    let detail: Value = checked(
        st.http
            .get(format!(
                "https://gmail.googleapis.com/gmail/v1/users/me/messages/{original}?format=minimal"
            ))
            .bearer_auth(access)
            .send()
            .await
            .map_err(err)?,
    )
    .await?
    .json()
    .await
    .map_err(err)?;
    let mut request = json!({"raw": URL_SAFE_NO_PAD.encode(mime_message(mail))});
    if let Some(thread) = detail["threadId"].as_str() {
        request["threadId"] = json!(thread);
    }
    let response = checked(
        st.http
            .post("https://gmail.googleapis.com/gmail/v1/users/me/messages/send")
            .bearer_auth(access)
            .json(&request)
            .send()
            .await
            .map_err(err)?,
    )
    .await?;
    response.json().await.map_err(err)
}

/// What an account's token is allowed to do. The account list shows this, because a
/// token that can read but not send is invisible until a message is refused.
#[tauri::command]
async fn account_permissions(state: State<'_, AppState>, id: String) -> Result<Value> {
    let account = sqlx::query("SELECT provider,email FROM accounts WHERE id=?")
        .bind(&id)
        .fetch_optional(&state.db)
        .await
        .map_err(err)?
        .ok_or("That account is no longer connected")?;
    let provider: String = account.get("provider");
    let scopes = token_scopes(state.inner(), &id, &provider).await?;
    let can_send = grants_sending(&scopes, &provider);
    Ok(json!({
        "email": account.get::<String,_>("email"),
        "provider": provider,
        "scopes": scopes,
        "can_send": can_send,
    }))
}

/// Sends one email written by hand, outside every campaign. Campaigns stay the only
/// path that renders a template and walks a sequence; this sends exactly what was typed.
#[tauri::command]
async fn send_message(state: State<'_, AppState>, input: MessageInput) -> Result<Value> {
    let db = &state.db;
    let markdown = input.markdown.trim().to_string();
    if markdown.is_empty() {
        return Err("Write the message first".into());
    }
    // The composer renders the HTML and its text alternative, so the Preview tab and the
    // delivered mail come from one function. An empty render means plain text only.
    let html = input.html.trim().to_string();
    let text = input.text.trim().to_string();
    let cc = input.cc.clone().unwrap_or_default().join(", ");
    let bcc = input.bcc.clone().unwrap_or_default().join(", ");
    // A reply already knows who it answers and which account received the original, so
    // the answer goes back from the same address, onto the same conversation.
    let reply = match input.reply_to.as_deref() {
        Some(message_id) => Some(
            sqlx::query("SELECT account_id,provider_message_id,thread_id,from_email,subject FROM inbox_messages WHERE id=?")
                .bind(message_id)
                .fetch_optional(db)
                .await
                .map_err(err)?
                .ok_or("That message is no longer in the inbox")?,
        ),
        None => None,
    };
    let to = if let Some(row) = &reply {
        row.get::<Option<String>, _>("from_email")
            .map(|value| extract_email(&value))
            .filter(|value| !value.is_empty())
            .ok_or("That reply has no sender address to answer")?
    } else if let Some(address) = input.to.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        extract_email(address)
    } else if let Some(lead_id) = input.lead_id.as_deref() {
        sqlx::query_scalar::<_, String>("SELECT email FROM leads WHERE id=?")
            .bind(lead_id)
            .fetch_optional(db)
            .await
            .map_err(err)?
            .ok_or("That lead no longer exists")?
    } else {
        return Err("Add a recipient".into());
    };
    if !to.contains('@') {
        return Err("That does not look like an email address".into());
    }
    if sqlx::query_scalar::<_, i64>("SELECT count(*) FROM suppressions WHERE email=?")
        .bind(&to)
        .fetch_one(db)
        .await
        .map_err(err)?
        > 0
    {
        return Err(format!("{to} is on the suppression list"));
    }
    // A subject the sender typed always wins, so an edited one is never silently
    // discarded. A reply that nobody retitled answers under the original's title.
    let subject = match input.subject.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        Some(written) => written.to_string(),
        None => match &reply {
            Some(row) => {
                let theirs = row.get::<Option<String>, _>("subject").unwrap_or_default();
                let theirs = theirs.trim();
                if theirs.is_empty() {
                    "Re:".to_string()
                } else if theirs.to_lowercase().starts_with("re:") {
                    theirs.to_string()
                } else {
                    format!("Re: {theirs}")
                }
            }
            None => return Err("Add a subject".into()),
        },
    };
    // An explicitly chosen account wins; a reply otherwise answers from the account
    // that received the message, and a fresh message from the first connected one.
    let account_id = match input
        .account_id
        .clone()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| reply.as_ref().map(|row| row.get::<String, _>("account_id")))
    {
        Some(id) => id,
        None => sqlx::query_scalar::<_, String>("SELECT id FROM accounts WHERE workspace_id=? ORDER BY email LIMIT 1")
            .bind(active_workspace(db).await)
            .fetch_optional(db)
            .await
            .map_err(err)?
            .ok_or("Connect an email account in Settings first")?,
    };
    let account = sqlx::query("SELECT provider,email,daily_limit,sent_today FROM accounts WHERE id=?")
        .bind(&account_id)
        .fetch_optional(db)
        .await
        .map_err(err)?
        .ok_or("That sending account is no longer connected")?;
    if account.get::<i64, _>("sent_today") >= account.get::<i64, _>("daily_limit") {
        return Err("That account has reached its daily sending limit".into());
    }
    let provider = account.get::<String, _>("provider");
    let from = account.get::<String, _>("email");
    // A token that can read but not send is the usual reason a first message is refused,
    // and the provider answers that with a bare 403 that does not explain itself. Asking
    // the token what it may do turns that into something the sender can act on.
    if !can_send(state.inner(), &account_id, &provider).await {
        let scopes = token_scopes(state.inner(), &account_id, &provider)
            .await
            .unwrap_or_default();
        return Err(format!(
            "{from} is connected without permission to send email — it only has {}. Disconnect it in Settings and connect it again, accepting the sending permission when the browser asks.",
            if scopes.is_empty() {
                "no usable permissions".to_string()
            } else {
                scopes.join(", ")
            }
        ));
    }
    let original = reply
        .as_ref()
        .and_then(|row| row.get::<Option<String>, _>("provider_message_id"));
    let mail = Mail {
        from: &from,
        to: &to,
        cc: &cc,
        bcc: &bcc,
        subject: &subject,
        text: &text,
        html: (!html.is_empty()).then_some(html.as_str()),
        thread: None,
    };
    // Refresh on expiry, and retry once with a forced refresh if the provider still
    // rejects the token — the same contract the campaign sender uses.
    let mut access = access_token(state.inner(), &account_id, &provider, false).await?;
    let mut delivered: Option<Value> = None;
    for attempt in 0..2 {
        let result = match original.as_deref() {
            Some(original) => {
                deliver_reply(state.inner(), &provider, &access, &mail, original).await
            }
            None => deliver(state.inner(), &provider, &access, &mail).await,
        };
        match result {
            Ok(response) => {
                delivered = Some(response);
                break;
            }
            Err(e) if e == AUTH_EXPIRED && attempt == 0 => {
                access = access_token(state.inner(), &account_id, &provider, true).await?;
            }
            Err(e) => return Err(e),
        }
    }
    let response = delivered.ok_or("The message was not sent")?;
    // send_logs.job_id is not nullable, so a hand-written send records a completed job of
    // its own. That also files it in the same history the thread view already reads.
    let lead_id = match input.lead_id.clone() {
        Some(lead_id) => Some(lead_id),
        None => sqlx::query_scalar::<_, String>("SELECT id FROM leads WHERE email=?")
            .bind(&to)
            .fetch_optional(db)
            .await
            .map_err(err)?,
    };
    // The conversation the message landed in. A reply already knows it from the message
    // it answers; otherwise Gmail reports it on the send. Microsoft's sendMail returns
    // nothing, so a fresh Outlook message has no thread to record.
    let thread_id = reply
        .as_ref()
        .and_then(|row| row.get::<Option<String>, _>("thread_id"))
        .filter(|value| !value.trim().is_empty())
        .or_else(|| response["threadId"].as_str().map(str::to_string));
    let job = id();
    let stamp = now();
    sqlx::query("INSERT INTO jobs(id,kind,state,run_at,idempotency_key,payload,created_at,updated_at) VALUES(?,'manual','done',?,?,?,?,?)")
        .bind(&job)
        .bind(&stamp)
        .bind(format!("manual:{job}"))
        .bind(&json!({"to":&to,"subject":&subject,"account_id":&account_id}).to_string())
        .bind(&stamp)
        .bind(&stamp)
        .execute(db)
        .await
        .map_err(err)?;
    sqlx::query(
        "INSERT INTO send_logs(id,job_id,campaign_id,lead_id,account_id,to_email,cc,bcc,provider_message_id,thread_id,subject,body,markdown,html,step_position,status,workspace_id,created_at) \
         VALUES(?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,0,'sent',?,?)",
    )
    .bind(id())
    .bind(&job)
    .bind(&lead_id)
    .bind(&account_id)
    .bind(&to)
    .bind(&cc)
    .bind(&bcc)
    .bind(response["id"].as_str())
    .bind(&thread_id)
    .bind(&subject)
    .bind(&text)
    .bind(&markdown)
    .bind(&html)
    .bind(active_workspace(db).await)
    .bind(now())
    .execute(db)
    .await
    .map_err(err)?;
    // The message is away, so its autosaved draft has nothing left to hold.
    if let Some(draft) = input.draft_id.as_deref().filter(|value| !value.trim().is_empty()) {
        sqlx::query("DELETE FROM message_drafts WHERE id=?")
            .bind(draft)
            .execute(db)
            .await
            .map_err(err)?;
    }
    sqlx::query("UPDATE accounts SET sent_today=sent_today+1,health='healthy',last_health_at=?,updated_at=? WHERE id=?")
        .bind(now())
        .bind(now())
        .bind(&account_id)
        .execute(db)
        .await
        .map_err(err)?;
    // Follow-ups turn a single email into a hidden campaign: one lead, N steps, driven
    // by the same scheduler. Nothing else about the send changes.
    let list = input.followups.as_deref().unwrap_or_default();
    if !list.is_empty() {
        schedule_single_followups(
            state.inner(),
            list,
            &account_id,
            lead_id.as_deref(),
            &to,
            thread_id.as_deref(),
            input.stop_rules.as_ref(),
        )
        .await?;
    }
    // A hand-written reply is itself an answer in the thread, so it ends any follow-up
    // still waiting there — the same rule an inbound reply triggers.
    if input.reply_to.is_some() {
        stop_lead_sequence(db, &to, "reply").await?;
    }
    log(db, "info", "message_sent", &format!("{to} — {subject}")).await;
    Ok(json!({"to":to,"subject":subject,"from":from,"lead_id":lead_id,"followups":list.len()}))
}

/// Stores a single email's follow-ups as a hidden campaign: `kind='single'`, one lead,
/// one step per follow-up. The one scheduler walks it, so a single is a campaign that
/// simply never appears in the Campaigns list.
#[allow(clippy::too_many_arguments)]
async fn schedule_single_followups(
    st: &AppState,
    followups: &[FollowupInput],
    account_id: &str,
    lead_id: Option<&str>,
    lead_email: &str,
    thread_id: Option<&str>,
    stop_rules: Option<&Value>,
) -> Result<String> {
    let db = &st.db;
    // A single sends to exactly one lead; make one when the recipient has never been
    // saved, so the scheduler has a row to hang the steps on.
    let lead = match lead_id {
        Some(existing) => existing.to_string(),
        None => match sqlx::query_scalar::<_, String>("SELECT id FROM leads WHERE email=?")
            .bind(lead_email)
            .fetch_optional(db)
            .await
            .map_err(err)?
        {
            Some(found) => found,
            None => {
                let fresh = id();
                sqlx::query("INSERT INTO leads(id,email,list_name,status,source,custom_fields,created_at,updated_at) VALUES(?,?,'Single emails','active','single','{}',?,?)")
                    .bind(&fresh)
                    .bind(lead_email)
                    .bind(now())
                    .bind(now())
                    .execute(db)
                    .await
                    .map_err(err)?;
                fresh
            }
        },
    };
    let campaign = id();
    let stamp = now();
    let rules = stop_rules
        .cloned()
        .unwrap_or_else(|| json!({"reply":true,"bounce":true,"ooo":true}));
    // Launching a single is the approval; what the sender pressed Send on is what goes.
    sqlx::query("INSERT INTO campaigns(id,name,mode,kind,status,approved_at,template_id,list_name,interval_minutes,account_id,schedule_json,stop_rules,workspace_id,created_at,updated_at) VALUES(?,?,'autonomous','single','active',?,NULL,NULL,1,?,?,?,?,?,?)")
        .bind(&campaign)
        .bind(lead_email)
        .bind(&stamp)
        .bind(account_id)
        .bind(json!({}).to_string())
        .bind(rules.to_string())
        .bind(active_workspace(db).await)
        .bind(&stamp)
        .bind(&stamp)
        .execute(db)
        .await
        .map_err(err)?;

    // `delay_days` is a wait measured from the previous step's own send; `scheduled_at`
    // is the running total from this send, kept only so the list can show a date.
    let mut cumulative = 0i64;
    for (index, step) in followups.iter().enumerate() {
        let position = (index + 1) as i64;
        let days = step.delay_days.unwrap_or(3).max(0);
        cumulative += days;
        // A step pinned to a day goes out on that day; one measured in days waits its
        // running total from the send that opened the thread.
        let send_date = step
            .send_date
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let scheduled_at = match send_date {
            Some(date) => format!("{}T09:00:00+00:00", date),
            None => (Utc::now() + chrono::Duration::days(cumulative)).to_rfc3339(),
        };
        sqlx::query("INSERT INTO sequence_steps(id,campaign_id,position,delay_minutes,delay_days,send_date,template_id,body_md,body_html,body_text,subject_override,status,scheduled_at,enabled) VALUES(?,?,?,0,?,?,NULL,?,?,?,?,'pending',?,1)")
            .bind(id())
            .bind(&campaign)
            .bind(position)
            .bind(days)
            .bind(send_date)
            .bind(step.body_md.trim())
            .bind(step.body_html.as_deref())
            .bind(step.body_text.as_deref())
            .bind(
                step.subject_override
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty()),
            )
            .bind(&scheduled_at)
            .execute(db)
            .await
            .map_err(err)?;
    }

    // The one lead waits on step 1, carrying the thread the original opened so every
    // follow-up replies into it. A first step pinned to a day waits for that day.
    let first = followups.first();
    let due = step_due_at(
        0,
        first.and_then(|step| step.delay_days).unwrap_or(3),
        first
            .and_then(|step| step.send_date.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty()),
    );
    sqlx::query("INSERT INTO campaign_leads(campaign_id,lead_id,account_id,state,step_position,next_due_at,thread_ref) VALUES(?,?,?,'queued',1,?,?)")
        .bind(&campaign)
        .bind(&lead)
        .bind(account_id)
        .bind(&due)
        .bind(thread_id)
        .execute(db)
        .await
        .map_err(err)?;
    log(
        db,
        "info",
        "single_scheduled",
        &format!("{} follow-ups for {}", followups.len(), lead_email),
    )
    .await;
    Ok(campaign)
}

/// The provider's reference for the thread an email opened, so follow-ups can join it.
/// Gmail returns a thread id; Graph's sendMail returns no body, so the message just
/// filed in Sent Items is read back for its RFC Message-ID.
async fn thread_reference(
    st: &AppState,
    provider: &str,
    access: &str,
    response: &Value,
) -> Option<String> {
    if provider == "gmail" {
        return response["threadId"].as_str().map(str::to_string);
    }
    let sent: Value = st
        .http
        .get("https://graph.microsoft.com/v1.0/me/sentItems/messages?$top=1&$orderby=sentDateTime%20desc&$select=internetMessageId")
        .bearer_auth(access)
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()?;
    sent["value"][0]["internetMessageId"]
        .as_str()
        .map(str::to_string)
}
fn extract_email(value: &str) -> String {
    let trimmed = value.trim();
    if let (Some(start), Some(end)) = (trimmed.find('<'), trimmed.find('>')) {
        if end > start + 1 {
            return trimmed[start + 1..end].trim().to_lowercase();
        }
    }
    trimmed.to_lowercase()
}

/// Cheap keyword rules run before the model, per the classification pipeline.
fn rule_category(text: &str) -> Option<&'static str> {
    let has = |needles: &[&str]| needles.iter().any(|needle| text.contains(needle));
    if has(&[
        "unsubscribe",
        "opt out",
        "opt-out",
        "remove me",
        "take me off",
    ]) {
        return Some("unsubscribe");
    }
    if has(&[
        "out of office",
        "automatic reply",
        "auto-reply",
        "on leave",
        "annual leave",
        "away until",
    ]) {
        return Some("out_of_office");
    }
    if has(&[
        "undeliverable",
        "delivery status notification",
        "mail delivery failed",
        "address not found",
        "mailbox full",
        "550 ",
    ]) {
        return Some("bounce");
    }
    if has(&[
        "not interested",
        "no thanks",
        "no thank you",
        "pass on this",
    ]) {
        return Some("not_interested");
    }
    if has(&[
        "not now",
        "reach out later",
        "next quarter",
        "circle back",
        "in a few months",
    ]) {
        return Some("not_now");
    }
    if has(&[
        "wrong person",
        "not the right person",
        "speak to",
        "reach out to",
        "forwarded your",
    ]) {
        return Some("referral");
    }
    if has(&[
        "interested",
        "let's chat",
        "happy to talk",
        "book a call",
        "send me more",
        "sounds good",
    ]) {
        return Some("interested");
    }
    None
}

fn channel_for(category: &str) -> &'static str {
    match category {
        "interested" => "ch-interested",
        "question" => "ch-question",
        "not_now" => "ch-not-now",
        "not_interested" => "ch-not-interested",
        "referral" => "ch-referral",
        "out_of_office" => "ch-ooo",
        "unsubscribe" => "ch-unsubscribe",
        "bounce" => "ch-bounce",
        _ => "ch-review",
    }
}

async fn set_category(
    db: &SqlitePool,
    message_id: &str,
    category: &str,
    confidence: f64,
    by: &str,
) -> Result<()> {
    let intent = if category == "interested" {
        Some("interested")
    } else {
        None
    };
    sqlx::query("UPDATE inbox_messages SET category=?,confidence=?,classified_by=?,channel_id=?,intent=?,read_flag=0 WHERE id=?")
        .bind(category)
        .bind(confidence)
        .bind(by)
        .bind(channel_for(category))
        .bind(intent)
        .bind(message_id)
        .execute(db)
        .await
        .map_err(err)?;
    Ok(())
}

/// A reply at any point must stop this lead's pending work before any further send.
/// A single has no campaign queue of its own beyond its one lead, so its scheduled
/// follow-ups are cancelled here too — a reply ends the whole sequence either way.
async fn stop_lead_sequence(db: &SqlitePool, email: &str, rule: &str) -> Result<()> {
    let lead: Option<String> = sqlx::query_scalar("SELECT id FROM leads WHERE email=?")
        .bind(email)
        .fetch_optional(db)
        .await
        .map_err(err)?;
    if let Some(lead_id) = lead {
        // The rule belongs to a campaign, not to the lead, so a lead who answered in one
        // campaign can still be written to in another that turned the rule off. `instr`
        // avoids needing JSON1 compiled in.
        let off = format!("\"{}\":false", rule);
        sqlx::query("UPDATE jobs SET state='cancelled',updated_at=? WHERE state='queued' AND idempotency_key LIKE ? AND substr(idempotency_key,1,instr(idempotency_key,':')-1) IN (SELECT id FROM campaigns WHERE stop_rules IS NULL OR instr(stop_rules,?)=0)")
            .bind(now())
            .bind(format!("%:{}:%", lead_id))
            .bind(&off)
            .execute(db)
            .await
            .map_err(err)?;
        sqlx::query("UPDATE campaign_leads SET state='paused',next_due_at=NULL WHERE lead_id=? AND state='queued' AND campaign_id IN (SELECT id FROM campaigns WHERE stop_rules IS NULL OR instr(stop_rules,?)=0)")
            .bind(&lead_id)
            .bind(&off)
            .execute(db)
            .await
            .map_err(err)?;
        // Only a single gives up its steps here. A campaign's step row is shared by every
        // lead enrolled in it, so cancelling it would end that step for all of them —
        // pausing the one lead above is what stops it for this lead alone.
        sqlx::query("UPDATE sequence_steps SET status='cancelled',skip_reason=? WHERE status='pending' AND campaign_id IN (SELECT c.id FROM campaigns c JOIN campaign_leads cl ON cl.campaign_id=c.id WHERE c.kind='single' AND cl.lead_id=? AND (c.stop_rules IS NULL OR instr(c.stop_rules,?)=0))")
            .bind(rule)
            .bind(&lead_id)
            .bind(&off)
            .execute(db)
            .await
            .map_err(err)?;
        log(db, "info", "sequence_stopped", &lead_id).await;
    }
    Ok(())
}

/// An out-of-office reply is not an answer to what was sent. It pauses the lead's
/// pending work instead of cancelling it: the due times move out and the sequence
/// resumes on its own.
async fn pause_lead_sequence(db: &SqlitePool, email: &str, days: i64) -> Result<()> {
    let lead: Option<String> = sqlx::query_scalar("SELECT id FROM leads WHERE email=?")
        .bind(email)
        .fetch_optional(db)
        .await
        .map_err(err)?;
    if let Some(lead_id) = lead {
        let resume = (Utc::now() + chrono::Duration::days(days.max(1))) .to_rfc3339();
        sqlx::query("UPDATE campaign_leads SET next_due_at=? WHERE lead_id=? AND state='queued' AND campaign_id IN (SELECT id FROM campaigns WHERE stop_rules IS NULL OR instr(stop_rules,'\"ooo\":false')=0)")
            .bind(&resume)
            .bind(&lead_id)
            .execute(db)
            .await
            .map_err(err)?;
        log(db, "info", "sequence_paused", &lead_id).await;
    }
    Ok(())
}

/// The decoded bodies of a Gmail message. Gmail nests MIME parts inside each other, so
/// this walks the tree and takes the first text/plain and text/html it finds. Anything
/// that will not decode is skipped rather than failing the whole sync.
fn gmail_bodies(payload: &Value) -> (Option<String>, Option<String>) {
    fn walk(part: &Value, html: &mut Option<String>, text: &mut Option<String>) {
        let mime = part["mimeType"].as_str().unwrap_or("");
        if let Some(data) = part["body"]["data"].as_str() {
            // Gmail returns unpadded base64url, but some servers pad it anyway.
            let cleaned = data.trim_end_matches('=');
            if let Ok(bytes) = URL_SAFE_NO_PAD.decode(cleaned) {
                if let Ok(value) = String::from_utf8(bytes) {
                    match mime {
                        "text/html" if html.is_none() => *html = Some(value),
                        "text/plain" if text.is_none() => *text = Some(value),
                        _ => {}
                    }
                }
            }
        }
        for child in part["parts"].as_array().cloned().unwrap_or_default() {
            walk(&child, html, text);
        }
    }
    let mut html = None;
    let mut text = None;
    walk(payload, &mut html, &mut text);
    (html, text)
}

/// Whether an address belongs to one of the connected accounts. Mail from it is our own
/// outgoing copy rather than something received.
async fn is_our_address(db: &SqlitePool, email: &str) -> Result<bool> {
    if email.trim().is_empty() {
        return Ok(false);
    }
    Ok(sqlx::query_scalar::<_, i64>("SELECT count(*) FROM accounts WHERE lower(email)=?")
        .bind(email)
        .fetch_one(db)
        .await
        .map_err(err)?
        > 0)
}

/// Stores one received message. Re-syncing one already held never duplicates it, but it
/// does fill in what it was stored without — the body, and the thread it belongs to,
/// which anything stored before those existed has none of.
async fn store_message(
    st: &AppState,
    account_id: &str,
    provider_message_id: &str,
    thread_id: &str,
    from: &str,
    subject: &str,
    received_at: &str,
    excerpt: &str,
    body_html: Option<&str>,
    body_text: Option<&str>,
    // Whether the provider puts this message in the inbox. Gmail's history reports the
    // whole mailbox, so this is what separates mail sent to us from everything else;
    // a folder-scoped read is already settled and passes `true`.
    in_inbox: bool,
) -> Result<usize> {
    let email = extract_email(from);
    // Mail from one of our own addresses is a copy of something we sent, and it is kept
    // so the conversation reads whole — but it is marked as ours, kept out of the Inbox,
    // and it must never be read as an answer. Anything else outside the inbox is not
    // ours to hold at all.
    let ours = is_our_address(&st.db, &email).await?;
    if !ours && !in_inbox {
        return Ok(0);
    }
    let thread = (!thread_id.trim().is_empty()).then_some(thread_id);
    // The mail lands in whichever workspace owns the mailbox it arrived on.
    let ws: String = sqlx::query_scalar("SELECT workspace_id FROM accounts WHERE id=?")
        .bind(account_id)
        .fetch_optional(&st.db)
        .await
        .map_err(err)?
        .unwrap_or_else(|| DEFAULT_WORKSPACE.to_string());
    let inserted = sqlx::query("INSERT OR IGNORE INTO inbox_messages(id,account_id,provider_message_id,thread_id,from_email,subject,received_at,raw_excerpt,body_html,body_text,read_flag,ours,workspace_id) VALUES(?,?,?,?,?,?,?,?,?,?,0,?,?)")
        .bind(id())
        .bind(account_id)
        .bind(provider_message_id)
        .bind(thread)
        .bind(&email)
        .bind(subject)
        .bind(received_at)
        .bind(excerpt)
        .bind(body_html)
        .bind(body_text)
        .bind(i64::from(ours))
        .bind(&ws)
        .execute(&st.db)
        .await
        .map_err(err)?
        .rows_affected();
    if inserted > 0 {
        // A reply at any point stops the sequence this lead was walking. An automatic
        // out-of-office is the one exception: it pauses, and the sequence resumes later.
        // Our own mail does nothing — sending to someone is not them answering.
        if !ours {
            // An out-of-office pauses rather than stops, and a bounce is a failed send
            // rather than an answer, so it stops the lead under its own rule.
            match rule_category(&format!("{subject} {excerpt}")) {
                Some("out_of_office") => pause_lead_sequence(&st.db, &email, 3).await?,
                Some("bounce") => stop_lead_sequence(&st.db, &email, "bounce").await?,
                _ => stop_lead_sequence(&st.db, &email, "reply").await?,
            }
        }
        return Ok(1);
    }
    sqlx::query("UPDATE inbox_messages SET body_html=COALESCE(body_html,?),body_text=COALESCE(body_text,?),thread_id=COALESCE(thread_id,?),ours=? WHERE account_id=? AND provider_message_id=?")
        .bind(body_html)
        .bind(body_text)
        .bind(thread)
        .bind(i64::from(ours))
        .bind(account_id)
        .bind(provider_message_id)
        .execute(&st.db)
        .await
        .map_err(err)?;
    Ok(0)
}

/// How long between inbox polls when nothing says otherwise.
const DEFAULT_POLL_SECONDS: i64 = 300;
/// What an account reads on its first sync, and again once its position has aged out at
/// the provider. Every pass after that is incremental.
const BACKFILL_WINDOW: &str = "newer_than:7d";
const BACKFILL_LIMIT: &str = "25";

/// The interval between polls, or `None` when polling is switched off. Read every tick,
/// so changing the setting does not need a restart.
async fn poll_seconds(db: &SqlitePool) -> Option<u64> {
    let seconds = setting(db, "inbox_poll_seconds")
        .await
        .and_then(|value| value.as_i64())
        .unwrap_or(DEFAULT_POLL_SECONDS);
    (seconds > 0).then_some(seconds as u64)
}

/// The position an account has read up to. Gmail calls it a history id and Microsoft a
/// delta link, and either way it is the only thing that makes a sync incremental.
async fn account_cursor(db: &SqlitePool, account_id: &str) -> Option<String> {
    sqlx::query_scalar::<_, Option<String>>("SELECT sync_cursor FROM accounts WHERE id=?")
        .bind(account_id)
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
        .flatten()
        .filter(|value| !value.trim().is_empty())
}

async fn store_cursor(db: &SqlitePool, account_id: &str, cursor: &str) -> Result<()> {
    sqlx::query("UPDATE accounts SET sync_cursor=?,last_synced_at=?,updated_at=? WHERE id=?")
        .bind(cursor)
        .bind(now())
        .bind(now())
        .bind(account_id)
        .execute(db)
        .await
        .map_err(err)?;
    Ok(())
}

/* ---------------- Gmail ---------------- */

/// The mailbox's current history id: the position a fresh marker starts from.
async fn gmail_marker(st: &AppState, access: &str) -> Result<String> {
    let profile: Value = checked(
        st.http
            .get("https://gmail.googleapis.com/gmail/v1/users/me/profile")
            .bearer_auth(access)
            .send()
            .await
            .map_err(err)?,
    )
    .await?
    .json()
    .await
    .map_err(err)?;
    profile["historyId"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "Gmail did not report a history id".to_string())
}

/// Everything Gmail has added since a marker, with the marker to store afterwards.
/// `None` means the marker is too old to be honoured — Gmail keeps about a week of
/// history — so the caller has to plant a fresh one.
async fn gmail_since(
    st: &AppState,
    access: &str,
    start: &str,
) -> Result<Option<(Vec<(String, String)>, String)>> {
    let mut found: Vec<(String, String)> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut newest = start.to_string();
    let mut page: Option<String> = None;
    loop {
        let mut request = st
            .http
            .get("https://gmail.googleapis.com/gmail/v1/users/me/history")
            // 500 is the most Gmail will return in one page, so a backlog costs fewest
            // round trips.
            .query(&[("startHistoryId", start), ("maxResults", "500")]);
        if let Some(token) = page.as_deref() {
            request = request.query(&[("pageToken", token)]);
        }
        let response = request.bearer_auth(access).send().await.map_err(err)?;
        if response.status().as_u16() == 404 {
            return Ok(None);
        }
        let body: Value = response
            .error_for_status()
            .map_err(err)?
            .json()
            .await
            .map_err(err)?;
        for entry in body["history"].as_array().cloned().unwrap_or_default() {
            for added in entry["messagesAdded"].as_array().cloned().unwrap_or_default() {
                let message = &added["message"];
                let message_id = message["id"].as_str().unwrap_or_default().to_string();
                if message_id.is_empty() || !seen.insert(message_id.clone()) {
                    continue;
                }
                found.push((
                    message_id,
                    message["threadId"].as_str().unwrap_or_default().to_string(),
                ));
            }
        }
        // The response carries the mailbox's id as of this read, so a pass that found
        // nothing still moves the marker forward. Left where it was, it would lag until
        // mail happened and eventually age out — losing the trail it exists to keep.
        if let Some(current) = body["historyId"].as_str() {
            newest = current.to_string();
        }
        match body["nextPageToken"].as_str() {
            Some(token) => page = Some(token.to_string()),
            None => break,
        }
    }
    Ok(Some((found, newest)))
}

/// The first pass of an account, and the one after its marker aged out: take a fresh
/// marker, then read the recent window. The marker is taken first on purpose, so a
/// message arriving during the backfill is still returned by the next history call and
/// nothing falls between the two.
async fn gmail_replant(st: &AppState, access: &str) -> Result<(Vec<(String, String)>, String)> {
    let marker = gmail_marker(st, access).await?;
    let list: Value = checked(
        st.http
            .get("https://gmail.googleapis.com/gmail/v1/users/me/messages")
            .query(&[("q", BACKFILL_WINDOW), ("maxResults", BACKFILL_LIMIT)])
            .bearer_auth(access)
            .send()
            .await
            .map_err(err)?,
    )
    .await?
    .json()
    .await
    .map_err(err)?;
    let mut references = Vec::new();
    for reference in list["messages"].as_array().cloned().unwrap_or_default() {
        let message_id = reference["id"].as_str().unwrap_or_default().to_string();
        if message_id.is_empty() {
            continue;
        }
        references.push((
            message_id,
            reference["threadId"].as_str().unwrap_or_default().to_string(),
        ));
    }
    Ok((references, marker))
}

/// Stores one Gmail message, if it is mail somebody sent us. Our own sent and draft
/// copies come through the history stream too, and those belong to the Sent view.
async fn store_gmail_message(
    st: &AppState,
    account_id: &str,
    access: &str,
    message_id: &str,
    thread_id: &str,
) -> Result<usize> {
    // `full` rather than `metadata`: the reading pane needs the message, not a preview.
    let detail: Value = checked(
        st.http
            .get(format!(
                "https://gmail.googleapis.com/gmail/v1/users/me/messages/{message_id}?format=full"
            ))
            .bearer_auth(access)
            .send()
            .await
            .map_err(err)?,
    )
    .await?
    .json()
    .await
    .map_err(err)?;
    // The history stream carries every change in the mailbox, our own sent and draft
    // copies included, so which labels a message carries is what says where it lives.
    let in_inbox = detail["labelIds"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .any(|label| label.as_str().is_some_and(|name| name == "INBOX"));
    let headers = detail["payload"]["headers"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let header = |name: &str| {
        headers
            .iter()
            .find(|h| h["name"].as_str().unwrap_or("").eq_ignore_ascii_case(name))
            .and_then(|h| h["value"].as_str())
            .unwrap_or("")
            .to_string()
    };
    let received = detail["internalDate"]
        .as_str()
        .unwrap_or_default()
        .parse::<i64>()
        .unwrap_or(0);
    let received_at = chrono::DateTime::from_timestamp_millis(received)
        .map(|d| d.to_rfc3339())
        .unwrap_or_else(now);
    let (body_html, body_text) = gmail_bodies(&detail["payload"]);
    store_message(
        st,
        account_id,
        message_id,
        thread_id,
        &header("From"),
        &header("Subject"),
        &received_at,
        detail["snippet"].as_str().unwrap_or(""),
        body_html.as_deref(),
        body_text.as_deref(),
        in_inbox,
    )
    .await
}

/// One Gmail account's pass. With a marker this is only what has arrived since the last
/// look; without one, or with one Gmail has forgotten, it is the recent window plus a
/// fresh marker to carry on from.
async fn sync_gmail(st: &AppState, account_id: &str, access: &str) -> Result<usize> {
    let (references, cursor) = match account_cursor(&st.db, account_id).await {
        Some(start) => match gmail_since(st, access, &start).await? {
            Some(found) => found,
            None => gmail_replant(st, access).await?,
        },
        None => gmail_replant(st, access).await?,
    };
    let mut added = 0;
    for (message_id, thread_id) in references {
        added += store_gmail_message(st, account_id, access, &message_id, &thread_id).await?;
    }
    store_cursor(&st.db, account_id, &cursor).await?;
    Ok(added)
}

/* ---------------- Microsoft ---------------- */

const GRAPH_FIELDS: &str = "id,conversationId,subject,from,receivedDateTime,bodyPreview,body";

/// A delta link is followed exactly as Microsoft returned it, so it is checked to be
/// Microsoft's own before it is used.
fn graph_delta_link(cursor: &str) -> Option<&str> {
    cursor
        .starts_with("https://graph.microsoft.com/")
        .then_some(cursor)
}

/// Follows a page set to its end, collecting messages and the delta link that continues
/// from there. `None` means Microsoft has dropped the position and it must be re-planted.
async fn graph_pages(
    st: &AppState,
    access: &str,
    first: &str,
) -> Result<Option<(Vec<Value>, String)>> {
    let mut messages = Vec::new();
    let mut next = first.to_string();
    loop {
        let response = st
            .http
            .get(&next)
            .bearer_auth(access)
            .send()
            .await
            .map_err(err)?;
        // Gone: the stored position is too old to resume from.
        if response.status().as_u16() == 410 {
            return Ok(None);
        }
        let status = response.status();
        let body: Value = response.json().await.map_err(err)?;
        if !status.is_success() {
            // A token Microsoft will not accept, as opposed to one it has forgotten.
            if body["error"]["code"].as_str() == Some("syncStateNotFound") {
                return Ok(None);
            }
            let detail = body["error"]["message"].as_str().unwrap_or("no detail");
            return Err(format!("Microsoft refused the position ({status}): {detail}"));
        }
        messages.extend(body["value"].as_array().cloned().unwrap_or_default());
        if let Some(link) = body["@odata.nextLink"].as_str() {
            next = link.to_string();
            continue;
        }
        let link = body["@odata.deltaLink"]
            .as_str()
            .ok_or_else(|| "Microsoft returned no continuation link".to_string())?;
        return Ok(Some((messages, link.to_string())));
    }
}

/// The first Microsoft pass, and the one after a dropped position. A first delta has no
/// start, so it is bounded by date; the delta link that comes back makes every later
/// pass incremental.
async fn graph_replant(st: &AppState, access: &str) -> Result<(Vec<Value>, String)> {
    let since = (Utc::now() - chrono::Duration::days(7))
        .format("%Y-%m-%dT%H:%M:%SZ")
        .to_string();
    let url = format!(
        "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$filter=receivedDateTime%20ge%20{since}&$select={GRAPH_FIELDS}"
    );
    graph_pages(st, access, &url)
        .await?
        .ok_or_else(|| "Microsoft would not start a sync for this account".to_string())
}

async fn store_graph_message(st: &AppState, account_id: &str, message: &Value) -> Result<usize> {
    let message_id = message["id"].as_str().unwrap_or_default();
    // Graph reports one body and says which kind it is, so it lands on whichever side of
    // the message the reading pane asks for.
    let content = message["body"]["content"].as_str().unwrap_or("");
    let is_html = message["body"]["contentType"]
        .as_str()
        .is_some_and(|kind| kind.eq_ignore_ascii_case("html"));
    store_message(
        st,
        account_id,
        message_id,
        message["conversationId"].as_str().unwrap_or_default(),
        message["from"]["emailAddress"]["address"].as_str().unwrap_or(""),
        message["subject"].as_str().unwrap_or(""),
        message["receivedDateTime"].as_str().unwrap_or(""),
        message["bodyPreview"].as_str().unwrap_or(""),
        is_html.then_some(content),
        (!is_html).then_some(content),
        // The read is scoped to the inbox folder, so everything it returns is in there.
        true,
    )
    .await
}

/// One Microsoft account's pass, over the inbox folder alone — which is why our own sent
/// copies never arrive here the way they do through Gmail's history.
async fn sync_graph(st: &AppState, account_id: &str, access: &str) -> Result<usize> {
    let stored = account_cursor(&st.db, account_id).await;
    let link = stored.as_deref().and_then(graph_delta_link);
    let (messages, cursor) = match link {
        Some(link) => match graph_pages(st, access, link).await? {
            Some(found) => found,
            None => graph_replant(st, access).await?,
        },
        None => graph_replant(st, access).await?,
    };

    let mut added = 0;
    let mut gone: Vec<String> = Vec::new();
    for message in messages {
        let message_id = message["id"].as_str().unwrap_or_default().to_string();
        if message_id.is_empty() {
            continue;
        }
        // A delta reports both ends of the collection: a message filed out of the inbox
        // comes back marked as removed, and our copy has to follow it out.
        if message.get("@removed").is_some() {
            gone.push(message_id);
            continue;
        }
        added += store_graph_message(st, account_id, &message).await?;
    }
    for message_id in gone {
        sqlx::query("UPDATE inbox_messages SET archived=1 WHERE account_id=? AND provider_message_id=?")
            .bind(account_id)
            .bind(&message_id)
            .execute(&st.db)
            .await
            .map_err(err)?;
    }
    store_cursor(&st.db, account_id, &cursor).await?;
    Ok(added)
}

/* ---------------- Both ---------------- */

/// One pass over every connected account. Only what is new since each account's stored
/// position is read, so the trail grows instead of being rebuilt from the same window.
async fn sync_accounts(st: &AppState, only: Option<&str>) -> Result<usize> {
    let accounts = sqlx::query("SELECT id,provider FROM accounts")
        .fetch_all(&st.db)
        .await
        .map_err(err)?;
    let mut total = 0usize;
    for account in accounts {
        let account_id: String = account.get("id");
        if only.is_some_and(|wanted| wanted != account_id) {
            continue;
        }
        let provider: String = account.get("provider");
        let access = match access_token(st, &account_id, &provider, false).await {
            Ok(access) => access,
            Err(e) => {
                log(&st.db, "error", "inbox_sync", &format!("{account_id}: {e}")).await;
                continue;
            }
        };
        let pass = if provider == "gmail" {
            sync_gmail(st, &account_id, &access).await
        } else {
            sync_graph(st, &account_id, &access).await
        };
        match pass {
            Ok(added) => total += added,
            // One unreachable mailbox must not stop the others being read.
            Err(e) => log(&st.db, "error", "inbox_sync", &format!("{account_id}: {e}")).await,
        }
    }
    Ok(total)
}

#[tauri::command]
async fn sync_inbox(state: State<'_, AppState>, account_id: Option<String>) -> Result<usize> {
    // A poll and a click can land together; one waits rather than interleaving on the
    // same cursor.
    let _permit = state.sync.acquire().await.map_err(err)?;
    sync_accounts(state.inner(), account_id.as_deref()).await
}

/// Keeps the trail current without anyone pressing anything. A pass that is still running
/// is skipped rather than queued: a large mailbox must not build a backlog behind itself.
async fn inbox_poller(st: AppState) {
    let mut last: Option<std::time::Instant> = None;
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(20));
    loop {
        tick.tick().await;
        let Some(seconds) = poll_seconds(&st.db).await else {
            continue;
        };
        if last.is_some_and(|at| at.elapsed().as_secs() < seconds) {
            continue;
        }
        last = Some(std::time::Instant::now());
        let Ok(_permit) = st.sync.try_acquire() else {
            continue;
        };
        match sync_accounts(&st, None).await {
            Ok(0) => {}
            Ok(added) => {
                log(
                    &st.db,
                    "info",
                    "inbox_poll",
                    &format!("{added} new message(s)"),
                )
                .await;
                // The views refetch on this rather than polling counts of their own.
                let _ = st.app.emit("inbox:new", added);
            }
            Err(e) => log(&st.db, "error", "inbox_poll", &e).await,
        }
    }
}

/// Classify unmatched replies: cheap rules first, then the local model when asked.
#[tauri::command]
async fn classify_inbox(state: State<'_, AppState>, use_agent: Option<bool>) -> Result<usize> {
    // Our own mail is not a reply and has no intent to judge.
    let rows = sqlx::query("SELECT id,subject,raw_excerpt FROM inbox_messages WHERE ours=0 AND (classified_by IS NULL OR classified_by='rule') ORDER BY received_at DESC LIMIT 50")
        .fetch_all(&state.db)
        .await
        .map_err(err)?;
    let mut classified = 0usize;
    for row in rows {
        let message_id: String = row.get("id");
        let subject = row.get::<Option<String>, _>("subject").unwrap_or_default();
        let excerpt = row
            .get::<Option<String>, _>("raw_excerpt")
            .unwrap_or_default();
        let text = format!("{} {}", subject, excerpt).to_lowercase();
        if let Some(category) = rule_category(&text) {
            set_category(&state.db, &message_id, category, 0.9, "rule").await?;
            classified += 1;
            continue;
        }
        if use_agent.unwrap_or(false) {
            if let Some((category, confidence)) =
                classify_with_model(&state, &format!("{} {}", subject, excerpt)).await
            {
                if confidence >= 0.7 {
                    set_category(&state.db, &message_id, &category, confidence, "agent").await?;
                    classified += 1;
                    continue;
                }
            }
        }
        set_category(&state.db, &message_id, "needs_review", 0.0, "rule").await?;
        classified += 1;
    }
    Ok(classified)
}

async fn classify_with_model(st: &AppState, text: &str) -> Option<(String, f64)> {
    let prompt = format!(
        "Classify this cold-email reply into exactly one of: interested, question, not_now, not_interested, referral, out_of_office, unsubscribe, bounce. Return strict JSON {{\"category\":\"...\",\"confidence\":0.0}}. Reply: {}",
        text
    );
    let model = model_for(&st.db, "classifier_model").await.ok()?;
    let outcome = llm_json(st, &model, None, &prompt, 45).await.ok()?;
    let category = outcome.value["category"].as_str()?.to_string();
    let allowed = [
        "interested",
        "question",
        "not_now",
        "not_interested",
        "referral",
        "out_of_office",
        "unsubscribe",
        "bounce",
    ];
    if !allowed.contains(&category.as_str()) {
        return None;
    }
    Some((
        category,
        outcome.value["confidence"].as_f64().unwrap_or(0.0),
    ))
}

#[tauri::command]
async fn list_channels(state: State<'_, AppState>, account_id: Option<String>) -> Result<Vec<Value>> {
    // The rail's counts follow the workspace and the mailbox the Inbox is narrowed to.
    let ws = active_workspace(&state.db).await;
    let filter = if account_id.is_some() { " AND m.account_id=?" } else { "" };
    let sql = format!("SELECT c.id,c.name,c.color,c.sort,(SELECT count(*) FROM inbox_messages m WHERE m.channel_id=c.id AND m.read_flag=0 AND m.ours=0 AND m.workspace_id=?{filter}) AS unread,(SELECT count(*) FROM inbox_messages m WHERE m.channel_id=c.id AND m.ours=0 AND m.workspace_id=?{filter}) AS total FROM channels c ORDER BY c.sort");
    let mut query = sqlx::query(&sql);
    for _ in 0..2 {
        query = query.bind(&ws);
        if let Some(account) = account_id.as_deref() {
            query = query.bind(account);
        }
    }
    query
        .fetch_all(&state.db)
        .await
        .map_err(err)
        .map(|rows| {
            rows.iter()
                .map(|r| json!({"id":r.get::<String,_>("id"),"name":r.get::<String,_>("name"),"color":r.get::<String,_>("color"),"unread":r.get::<i64,_>("unread"),"total":r.get::<i64,_>("total")}))
                .collect()
        })
}

#[tauri::command]
async fn list_inbox(
    state: State<'_, AppState>,
    view: Option<String>,
    channel_id: Option<String>,
    unread_only: Option<bool>,
    sort: Option<String>,
    account_id: Option<String>,
) -> Result<Vec<Value>> {
    let view = view.unwrap_or_else(|| "inbox".to_string());
    let ws = active_workspace(&state.db).await;
    // Sent and Drafts read their own tables; these three are the mailbox proper.
    let mut sql = String::from(
        // `ours` rows are copies of mail we sent. They belong to the conversation, not to
        // the list of things waiting for an answer.
        "SELECT m.id,m.account_id,m.from_email,m.subject,m.received_at,m.raw_excerpt,m.category,m.confidence,m.classified_by,m.channel_id,m.read_flag,m.snoozed_until,m.archived,l.first_name,l.company,l.title FROM inbox_messages m LEFT JOIN leads l ON l.email=m.from_email WHERE m.deleted_at IS NULL AND m.ours=0 AND m.workspace_id=?",
    );
    sql.push_str(if view == "archived" {
        " AND m.archived=1"
    } else {
        " AND m.archived=0"
    });
    if view == "new" || unread_only.unwrap_or(false) {
        sql.push_str(" AND m.read_flag=0");
    }
    if channel_id.is_some() {
        sql.push_str(" AND m.channel_id=?");
    }
    // Narrowing to one mailbox is a filter like any other.
    if account_id.is_some() {
        sql.push_str(" AND m.account_id=?");
    }
    sql.push_str(match sort.as_deref() {
        Some("oldest") => " ORDER BY m.received_at ASC",
        Some("sender") => " ORDER BY m.from_email ASC, m.received_at DESC",
        _ => " ORDER BY m.received_at DESC",
    });
    sql.push_str(" LIMIT 200");
    let mut query = sqlx::query(&sql).bind(&ws);
    if let Some(channel) = &channel_id {
        query = query.bind(channel);
    }
    if let Some(account) = &account_id {
        query = query.bind(account);
    }
    let rows = query.fetch_all(&state.db).await.map_err(err)?;
    Ok(rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<String,_>("id"),
                "account_id": r.get::<String,_>("account_id"),
                "from_email": r.get::<Option<String>,_>("from_email"),
                "subject": r.get::<Option<String>,_>("subject"),
                "received_at": r.get::<Option<String>,_>("received_at"),
                "raw_excerpt": r.get::<Option<String>,_>("raw_excerpt"),
                "category": r.get::<Option<String>,_>("category"),
                "confidence": r.get::<Option<f64>,_>("confidence"),
                "classified_by": r.get::<Option<String>,_>("classified_by"),
                "channel_id": r.get::<Option<String>,_>("channel_id"),
                "read": r.get::<i64,_>("read_flag") != 0,
                "snoozed_until": r.get::<Option<String>,_>("snoozed_until"),
                "archived": r.get::<i64,_>("archived") != 0,
                "lead_name": r.get::<Option<String>,_>("first_name"),
                "company": r.get::<Option<String>,_>("company"),
                "title": r.get::<Option<String>,_>("title"),
            })
        })
        .collect())
}

#[tauri::command]
async fn set_inbox_channel(
    state: State<'_, AppState>,
    message_id: String,
    channel_id: String,
) -> Result<()> {
    // A human correction always wins over rule/agent classification.
    sqlx::query("UPDATE inbox_messages SET channel_id=?,classified_by='user' WHERE id=?")
        .bind(channel_id)
        .bind(message_id)
        .execute(&state.db)
        .await
        .map_err(err)?;
    Ok(())
}

#[tauri::command]
async fn mark_inbox_read(state: State<'_, AppState>, message_id: String, read: bool) -> Result<()> {
    sqlx::query("UPDATE inbox_messages SET read_flag=? WHERE id=?")
        .bind(if read { 1 } else { 0 })
        .bind(message_id)
        .execute(&state.db)
        .await
        .map_err(err)?;
    Ok(())
}

#[tauri::command]
async fn snooze_inbox(state: State<'_, AppState>, message_id: String, until: String) -> Result<()> {
    sqlx::query("UPDATE inbox_messages SET snoozed_until=?,read_flag=1 WHERE id=?")
        .bind(until)
        .bind(message_id)
        .execute(&state.db)
        .await
        .map_err(err)?;
    Ok(())
}

/// A timestamp a provider wrote, in whichever RFC 3339 shape it chose. Gmail hands back
/// `+00:00` and Microsoft `Z`, so they are parsed rather than compared as text — the two
/// shapes do not sort against each other.
fn moment(value: &str) -> Option<chrono::DateTime<Utc>> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|at| at.with_timezone(&Utc))
}

/// One line of a message, for the conversation list.
fn preview(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default()
        .chars()
        .take(160)
        .collect()
}

/// The exchange with one person: their messages and ours, in the order they happened.
/// Ours come from `send_logs` where Maily wrote them, and from the mailbox itself where
/// they went out some other way. Both halves in one list is what makes a sign useful —
/// without ours in here, everything would be from them and there would be nothing to tell
/// apart.
async fn conversation(
    db: &SqlitePool,
    account_id: &str,
    thread: Option<&str>,
    email: &str,
    opened: &str,
) -> Result<Vec<Value>> {
    // A thread scopes this to its own conversation. Without one the address stands in, so
    // mail stored before threads were recorded still reads together.
    let thread = thread.filter(|value| !value.trim().is_empty());
    let (scope, key) = match thread {
        Some(thread) => ("thread_id=?", thread),
        None => ("from_email=?", email),
    };

    let mine = sqlx::query(&format!(
        "SELECT id,ours,provider_message_id,from_email,subject,received_at,raw_excerpt,body_html,body_text \
         FROM inbox_messages WHERE account_id=? AND deleted_at IS NULL AND {scope} ORDER BY received_at"
    ))
    .bind(account_id)
    .bind(key)
    .fetch_all(db)
    .await
    .map_err(err)?;

    let select = "SELECT s.id,s.subject,s.body,s.html,s.created_at,s.status,s.provider_message_id,c.name AS campaign \
                  FROM send_logs s LEFT JOIN campaigns c ON c.id=s.campaign_id";
    let mut sent = sqlx::query(&format!(
        "{select} WHERE {} ORDER BY s.created_at",
        if thread.is_some() { "s.thread_id=?" } else { "s.to_email=?" }
    ))
    .bind(key)
    .fetch_all(db)
    .await
    .map_err(err)?;

    // A conversation with nothing logged in it falls back to the address, so a reply to
    // something sent before threads were recorded still shows what prompted it.
    if sent.is_empty() && thread.is_some() {
        sent = sqlx::query(&format!("{select} WHERE s.to_email=? ORDER BY s.created_at"))
            .bind(email)
            .fetch_all(db)
            .await
            .map_err(err)?;
    }

    // A message Maily sent also comes back through the sync as a copy of itself, and
    // `send_logs` holds the better record — as written, with the campaign that wrote it —
    // so the copy stands down.
    let logged: HashSet<String> = sent
        .iter()
        .filter_map(|row| row.get::<Option<String>, _>("provider_message_id"))
        .collect();

    let mut entries: Vec<(Option<chrono::DateTime<Utc>>, Value)> = Vec::new();

    for row in &sent {
        let at: String = row.get("created_at");
        entries.push((
            moment(&at),
            json!({
                "id": row.get::<String,_>("id"),
                "direction": "out",
                "origin": "maily",
                "campaign": row.get::<Option<String>,_>("campaign"),
                "status": row.get::<String,_>("status"),
                "at": at,
                "subject": row.get::<Option<String>,_>("subject"),
                "preview": preview(row.get::<Option<String>,_>("body").as_deref().unwrap_or_default()),
                "html": row.get::<Option<String>,_>("html"),
                "text": row.get::<Option<String>,_>("body"),
            }),
        ));
    }

    for row in &mine {
        let ours = row.get::<i64, _>("ours") != 0;
        let provider: Option<String> = row.get("provider_message_id");
        if ours && provider.as_ref().is_some_and(|id| logged.contains(id)) {
            continue;
        }
        let at: Option<String> = row.get("received_at");
        let id: String = row.get("id");
        entries.push((
            at.as_deref().and_then(moment),
            json!({
                "id": id,
                "direction": if ours { "out" } else { "in" },
                "origin": if ours { "you" } else { "them" },
                "from_email": row.get::<Option<String>,_>("from_email"),
                // Which message the pane has open, so the list can show where you are in it.
                "opened": id == opened,
                "at": at,
                "subject": row.get::<Option<String>,_>("subject"),
                "preview": row.get::<Option<String>,_>("raw_excerpt")
                    .or_else(|| row.get::<Option<String>,_>("body_text"))
                    .unwrap_or_default(),
                "html": row.get::<Option<String>,_>("body_html"),
                "text": row.get::<Option<String>,_>("body_text"),
            }),
        ));
    }

    entries.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(entries.into_iter().map(|(_, entry)| entry).collect())
}

#[tauri::command]
async fn inbox_thread(state: State<'_, AppState>, message_id: String) -> Result<Value> {
    let message = sqlx::query("SELECT m.id,m.account_id,m.from_email,m.subject,m.received_at,m.raw_excerpt,m.body_html,m.body_text,m.thread_id,m.category,m.confidence,m.classified_by,m.channel_id,m.read_flag,m.archived,l.id AS lead_id,l.first_name,l.last_name,l.email AS lead_email,l.company,l.title,l.website FROM inbox_messages m LEFT JOIN leads l ON l.email=m.from_email WHERE m.id=?")
        .bind(&message_id)
        .fetch_optional(&state.db)
        .await
        .map_err(err)?
        .ok_or("Message not found")?;
    let email: Option<String> = message.get("from_email");
    let thread: Option<String> = message.get("thread_id");
    let account_id: String = message.get("account_id");
    // The whole exchange with this person, read against the message that is open, so
    // "what did Maily send and what came back" is one list rather than an inference.
    let conversation = match &email {
        Some(address) => {
            conversation(&state.db, &account_id, thread.as_deref(), address, &message_id).await?
        }
        None => Vec::new(),
    };
    Ok(json!({
        "id": message.get::<String,_>("id"),
        "from_email": email,
        "subject": message.get::<Option<String>,_>("subject"),
        "received_at": message.get::<Option<String>,_>("received_at"),
        "raw_excerpt": message.get::<Option<String>,_>("raw_excerpt"),
        // The body the reading pane renders, and the archive state of the row.
        "body_html": message.get::<Option<String>,_>("body_html"),
        "body_text": message.get::<Option<String>,_>("body_text"),
        "archived": message.get::<i64,_>("archived") != 0,
        "category": message.get::<Option<String>,_>("category"),
        "confidence": message.get::<Option<f64>,_>("confidence"),
        "classified_by": message.get::<Option<String>,_>("classified_by"),
        "channel_id": message.get::<Option<String>,_>("channel_id"),
        "read": message.get::<i64,_>("read_flag") != 0,
        "account_id": message.get::<Option<String>,_>("account_id"),
        // The lead's own columns, so the composer can fill {{variables}} from the same
        // values the campaign renderer would use.
        "lead": {
            "id": message.get::<Option<String>,_>("lead_id"),
            "name": message.get::<Option<String>,_>("first_name"),
            "last_name": message.get::<Option<String>,_>("last_name"),
            "email": message.get::<Option<String>,_>("lead_email"),
            "company": message.get::<Option<String>,_>("company"),
            "title": message.get::<Option<String>,_>("title"),
            "website": message.get::<Option<String>,_>("website")
        },
        "conversation": conversation
    }))
}

/// The counts the Inbox rail shows, in one round trip. Narrowed to the workspace, and to
/// one mailbox when one is selected.
#[tauri::command]
async fn inbox_counts(state: State<'_, AppState>, account_id: Option<String>) -> Result<Value> {
    let ws = active_workspace(&state.db).await;
    let solely = if account_id.is_some() { " AND account_id=?" } else { "" };
    let sql = format!(
        "SELECT \
         (SELECT count(*) FROM inbox_messages WHERE deleted_at IS NULL AND archived=0 AND ours=0 AND workspace_id=?{solely}) AS inbox, \
         (SELECT count(*) FROM inbox_messages WHERE deleted_at IS NULL AND archived=0 AND read_flag=0 AND ours=0 AND workspace_id=?{solely}) AS unread, \
         (SELECT count(*) FROM inbox_messages WHERE deleted_at IS NULL AND archived=1 AND ours=0 AND workspace_id=?{solely}) AS archived, \
         (SELECT count(*) FROM send_logs WHERE workspace_id=?{solely}) AS sent, \
         (SELECT count(*) FROM message_drafts WHERE workspace_id=?{solely}) AS drafts, \
         (SELECT count(*) FROM sequence_steps s JOIN campaigns c ON c.id=s.campaign_id WHERE s.status='pending' AND c.workspace_id=?) AS scheduled",
    );
    let mut query = sqlx::query(&sql);
    // One workspace bind per subquery, with the mailbox bind slotted in where it appears.
    for _ in 0..5 {
        query = query.bind(&ws);
        if let Some(account) = account_id.as_deref() {
            query = query.bind(account);
        }
    }
    query = query.bind(&ws);
    let row = query.fetch_one(&state.db).await.map_err(err)?;
    Ok(json!({
        "inbox": row.get::<i64,_>("inbox"),
        "unread": row.get::<i64,_>("unread"),
        "archived": row.get::<i64,_>("archived"),
        "sent": row.get::<i64,_>("sent"),
        "drafts": row.get::<i64,_>("drafts"),
        "scheduled": row.get::<i64,_>("scheduled"),
    }))
}

/// The scheduled follow-ups hanging off the conversation a message belongs to. Only a
/// single puts them there, so this reads the lead's single campaign.
#[tauri::command]
async fn thread_followups(state: State<'_, AppState>, message_id: String) -> Result<Value> {
    let email: Option<String> = sqlx::query_scalar("SELECT from_email FROM inbox_messages WHERE id=?")
        .bind(&message_id)
        .fetch_optional(&state.db)
        .await
        .map_err(err)?
        .flatten();
    let empty = json!({"paused": false, "pending": 0, "campaign_id": null, "steps": []});
    let Some(email) = email else { return Ok(empty) };
    let campaign = sqlx::query(
        "SELECT c.id,c.status FROM campaigns c JOIN campaign_leads cl ON cl.campaign_id=c.id JOIN leads l ON l.id=cl.lead_id WHERE c.kind='single' AND l.email=? ORDER BY c.created_at DESC LIMIT 1",
    )
    .bind(&email)
    .fetch_optional(&state.db)
    .await
    .map_err(err)?;
    let Some(campaign) = campaign else { return Ok(empty) };
    let campaign_id: String = campaign.get("id");
    let status: String = campaign.get("status");
    let rows = sqlx::query("SELECT s.id,s.position,s.delay_days,s.body_md,s.subject_override,s.status,s.scheduled_at,s.sent_at,cl.next_due_at FROM sequence_steps s LEFT JOIN campaign_leads cl ON cl.campaign_id=s.campaign_id WHERE s.campaign_id=? ORDER BY s.position")
        .bind(&campaign_id)
        .fetch_all(&state.db)
        .await
        .map_err(err)?;
    let steps: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<String,_>("id"),
                "position": r.get::<i64,_>("position"),
                "delay_days": r.get::<Option<i64>,_>("delay_days"),
                "body_md": r.get::<Option<String>,_>("body_md"),
                "subject_override": r.get::<Option<String>,_>("subject_override"),
                "status": r.get::<String,_>("status"),
                "scheduled_at": r.get::<Option<String>,_>("scheduled_at"),
                "sent_at": r.get::<Option<String>,_>("sent_at"),
                "due_at": r.get::<Option<String>,_>("next_due_at"),
            })
        })
        .collect();
    let pending = steps.iter().filter(|step| step["status"] == "pending").count();
    Ok(json!({
        "paused": status == "paused",
        "pending": pending,
        "campaign_id": campaign_id,
        "steps": steps,
    }))
}

/// Everything still waiting to go out: one pending step against the lead it waits for.
#[tauri::command]
async fn list_scheduled(state: State<'_, AppState>, limit: Option<i64>) -> Result<Vec<Value>> {
    let rows = sqlx::query("SELECT s.id,s.campaign_id,s.position,s.delay_days,s.body_md,s.scheduled_at,c.kind,c.name AS campaign,c.status AS campaign_status,l.email AS lead_email,l.first_name,l.company,cl.next_due_at FROM sequence_steps s JOIN campaigns c ON c.id=s.campaign_id LEFT JOIN campaign_leads cl ON cl.campaign_id=s.campaign_id AND cl.step_position=s.position LEFT JOIN leads l ON l.id=cl.lead_id WHERE s.status='pending' AND c.status IN ('active','throttled','paused') ORDER BY COALESCE(cl.next_due_at, s.scheduled_at) ASC LIMIT ?")
        .bind(limit.unwrap_or(200).clamp(1, 500))
        .fetch_all(&state.db)
        .await
        .map_err(err)?;
    Ok(rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<String,_>("id"),
                "campaign_id": r.get::<String,_>("campaign_id"),
                "position": r.get::<i64,_>("position"),
                "kind": r.get::<String,_>("kind"),
                "campaign": r.get::<Option<String>,_>("campaign"),
                "campaign_status": r.get::<Option<String>,_>("campaign_status"),
                "lead_email": r.get::<Option<String>,_>("lead_email"),
                "lead_name": r.get::<Option<String>,_>("first_name"),
                "company": r.get::<Option<String>,_>("company"),
                "due_at": r.get::<Option<String>,_>("next_due_at").or_else(|| r.get::<Option<String>,_>("scheduled_at")),
                "body_md": r.get::<Option<String>,_>("body_md"),
            })
        })
        .collect())
}

/// Brings one follow-up forward so the next tick sends it, right now.
#[tauri::command]
async fn followup_send_now(state: State<'_, AppState>, step_id: String) -> Result<()> {
    let row = sqlx::query("SELECT campaign_id,position FROM sequence_steps WHERE id=?")
        .bind(&step_id)
        .fetch_optional(&state.db)
        .await
        .map_err(err)?
        .ok_or("That follow-up no longer exists")?;
    let campaign: String = row.get("campaign_id");
    let position: i64 = row.get("position");
    sqlx::query("UPDATE sequence_steps SET status='pending',skip_reason=NULL WHERE id=?")
        .bind(&step_id)
        .execute(&state.db)
        .await
        .map_err(err)?;
    sqlx::query("UPDATE campaign_leads SET step_position=?,next_due_at=?,state='queued' WHERE campaign_id=?")
        .bind(position)
        .bind(now())
        .bind(&campaign)
        .execute(&state.db)
        .await
        .map_err(err)?;
    sqlx::query("UPDATE campaigns SET status='active',approved_at=COALESCE(approved_at,?),updated_at=? WHERE id=?")
        .bind(now())
        .bind(now())
        .bind(&campaign)
        .execute(&state.db)
        .await
        .map_err(err)?;
    Ok(())
}

/// Drops one follow-up for good.
#[tauri::command]
async fn followup_cancel(state: State<'_, AppState>, step_id: String) -> Result<()> {
    sqlx::query("UPDATE sequence_steps SET status='cancelled',skip_reason='cancelled by hand' WHERE id=?")
        .bind(&step_id)
        .execute(&state.db)
        .await
        .map_err(err)?;
    Ok(())
}

/// One edited follow-up: its wait and its message, re-rendered by the composer so the
/// stored html and text stay the one renderer's output.
#[derive(Deserialize)]
struct FollowupUpdate {
    id: String,
    delay_days: Option<i64>,
    body_md: Option<String>,
    body_html: Option<String>,
    body_text: Option<String>,
    subject_override: Option<String>,
}

#[tauri::command]
async fn followup_update(state: State<'_, AppState>, input: FollowupUpdate) -> Result<()> {
    sqlx::query("UPDATE sequence_steps SET delay_days=COALESCE(?,delay_days),body_md=COALESCE(?,body_md),body_html=COALESCE(?,body_html),body_text=COALESCE(?,body_text),subject_override=? WHERE id=?")
        .bind(input.delay_days.map(|days| days.max(0)))
        .bind(input.body_md.as_deref())
        .bind(input.body_html.as_deref())
        .bind(input.body_text.as_deref())
        .bind(input.subject_override.as_deref().map(str::trim).filter(|value| !value.is_empty()))
        .bind(&input.id)
        .execute(&state.db)
        .await
        .map_err(err)?;
    Ok(())
}

/// Stops every pending follow-up of a single without throwing them away.
#[tauri::command]
async fn followups_pause(state: State<'_, AppState>, campaign_id: String) -> Result<()> {
    sqlx::query("UPDATE campaigns SET status='paused',updated_at=? WHERE id=?")
        .bind(now())
        .bind(&campaign_id)
        .execute(&state.db)
        .await
        .map_err(err)?;
    Ok(())
}

#[tauri::command]
async fn followups_resume(state: State<'_, AppState>, campaign_id: String) -> Result<()> {
    sqlx::query("UPDATE campaigns SET status='active',approved_at=COALESCE(approved_at,?),updated_at=? WHERE id=?")
        .bind(now())
        .bind(now())
        .bind(&campaign_id)
        .execute(&state.db)
        .await
        .map_err(err)?;
    Ok(())
}

/// Gives up every pending follow-up of a single, for good.
#[tauri::command]
async fn followups_cancel_all(state: State<'_, AppState>, campaign_id: String) -> Result<()> {
    sqlx::query("UPDATE sequence_steps SET status='cancelled',skip_reason='cancelled by hand' WHERE campaign_id=? AND status='pending'")
        .bind(&campaign_id)
        .execute(&state.db)
        .await
        .map_err(err)?;
    sqlx::query("UPDATE campaigns SET status='paused',updated_at=? WHERE id=?")
        .bind(now())
        .bind(&campaign_id)
        .execute(&state.db)
        .await
        .map_err(err)?;
    Ok(())
}

/// Bulk actions from the thread list: one statement for the whole selection. Delete
/// only stamps `deleted_at` — the row stays, because there is no Trash view to restore
/// from and losing a reply to a mis-click is not recoverable.
#[tauri::command]
async fn inbox_bulk(state: State<'_, AppState>, ids: Vec<String>, action: String) -> Result<usize> {
    if ids.is_empty() {
        return Ok(0);
    }
    // sqlx cannot bind a list, so the placeholders come from the id count.
    let marks = vec!["?"; ids.len()].join(",");
    let sql = match action.as_str() {
        "archive" => format!("UPDATE inbox_messages SET archived=1 WHERE id IN ({marks})"),
        "unarchive" => format!("UPDATE inbox_messages SET archived=0 WHERE id IN ({marks})"),
        "read" => format!("UPDATE inbox_messages SET read_flag=1 WHERE id IN ({marks})"),
        "unread" => format!("UPDATE inbox_messages SET read_flag=0 WHERE id IN ({marks})"),
        "delete" => format!("UPDATE inbox_messages SET deleted_at=? WHERE id IN ({marks})"),
        other => return Err(format!("Unknown inbox action: {other}")),
    };
    let mut query = sqlx::query(&sql);
    if action == "delete" {
        query = query.bind(now());
    }
    for id in &ids {
        query = query.bind(id);
    }
    let affected = query.execute(&state.db).await.map_err(err)?.rows_affected();
    Ok(affected as usize)
}

/// Everything that has gone out, campaigns and hand-written alike — `send_logs` is the
/// only record of a send. `html` is present only for mail the composer rendered; a
/// campaign step falls back to `text`.
#[tauri::command]
async fn list_sent(
    state: State<'_, AppState>,
    limit: Option<i64>,
    account_id: Option<String>,
) -> Result<Vec<Value>> {
    let ws = active_workspace(&state.db).await;
    // The workspace is always the filter; the mailbox only when one was picked.
    let (where_clause, account) = match account_id.as_deref() {
        Some(account) => (" WHERE s.workspace_id=? AND s.account_id=?", Some(account)),
        None => (" WHERE s.workspace_id=?", None),
    };
    let sql = format!(
        "SELECT s.id,s.to_email,s.cc,s.bcc,s.subject,s.body,s.markdown,s.html,s.status,s.created_at,a.email AS account_email,c.name AS campaign,l.email AS lead_email,l.first_name \
         FROM send_logs s LEFT JOIN accounts a ON a.id=s.account_id LEFT JOIN campaigns c ON c.id=s.campaign_id LEFT JOIN leads l ON l.id=s.lead_id{where_clause} \
         ORDER BY s.created_at DESC LIMIT ?"
    );
    let mut query = sqlx::query(&sql).bind(&ws);
    if let Some(account) = account {
        query = query.bind(account);
    }
    let rows = query
        .bind(limit.unwrap_or(100).clamp(1, 500))
        .fetch_all(&state.db)
        .await
        .map_err(err)?;
    Ok(rows
        .iter()
        .map(|r| {
            let to = r
                .get::<Option<String>, _>("to_email")
                // Sends logged before recipients were stored only know their lead.
                .or_else(|| r.get::<Option<String>, _>("lead_email"));
            json!({
                "id": r.get::<String,_>("id"),
                "to_email": to,
                "cc": r.get::<Option<String>,_>("cc"),
                "bcc": r.get::<Option<String>,_>("bcc"),
                "subject": r.get::<Option<String>,_>("subject"),
                "text": r.get::<Option<String>,_>("body"),
                "markdown": r.get::<Option<String>,_>("markdown"),
                "html": r.get::<Option<String>,_>("html"),
                "status": r.get::<String,_>("status"),
                "created_at": r.get::<String,_>("created_at"),
                "account_email": r.get::<Option<String>,_>("account_email"),
                "campaign": r.get::<Option<String>,_>("campaign"),
                "lead_name": r.get::<Option<String>,_>("first_name"),
            })
        })
        .collect())
}

#[tauri::command]
async fn list_drafts(state: State<'_, AppState>, account_id: Option<String>) -> Result<Vec<Value>> {
    let ws = active_workspace(&state.db).await;
    let filter = match account_id.as_deref() {
        Some(_) => " WHERE workspace_id=? AND account_id=?",
        None => " WHERE workspace_id=?",
    };
    let sql = format!(
        "SELECT id,account_id,reply_to,to_email,cc,bcc,subject,markdown,created_at,updated_at FROM message_drafts{filter} ORDER BY updated_at DESC"
    );
    let mut query = sqlx::query(&sql).bind(&ws);
    if let Some(account) = account_id.as_deref() {
        query = query.bind(account);
    }
    let rows = query.fetch_all(&state.db).await.map_err(err)?;
    Ok(rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<String,_>("id"),
                "account_id": r.get::<Option<String>,_>("account_id"),
                "reply_to": r.get::<Option<String>,_>("reply_to"),
                "to_email": r.get::<Option<String>,_>("to_email"),
                "cc": r.get::<Option<String>,_>("cc"),
                "bcc": r.get::<Option<String>,_>("bcc"),
                "subject": r.get::<Option<String>,_>("subject"),
                "markdown": r.get::<String,_>("markdown"),
                "created_at": r.get::<String,_>("created_at"),
                "updated_at": r.get::<String,_>("updated_at"),
            })
        })
        .collect())
}

/// Upsert the composer's autosave and hand back the id, so it keeps writing to the same
/// row for as long as it stays open. An empty id means this is the first save.
#[tauri::command]
async fn save_draft(state: State<'_, AppState>, input: DraftInput) -> Result<String> {
    let stamp = now();
    let id = match input.id.clone().filter(|value| !value.trim().is_empty()) {
        Some(id) => id,
        None => id(),
    };
    sqlx::query(
        "INSERT INTO message_drafts(id,account_id,reply_to,to_email,cc,bcc,subject,markdown,workspace_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) \
         ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id,reply_to=excluded.reply_to,to_email=excluded.to_email,cc=excluded.cc,bcc=excluded.bcc,subject=excluded.subject,markdown=excluded.markdown,updated_at=excluded.updated_at",
    )
    .bind(&id)
    .bind(&input.account_id)
    .bind(&input.reply_to)
    .bind(&input.to_email)
    .bind(&input.cc)
    .bind(&input.bcc)
    .bind(&input.subject)
    .bind(&input.markdown)
    .bind(active_workspace(&state.db).await)
    .bind(&stamp)
    .bind(&stamp)
    .execute(&state.db)
    .await
    .map_err(err)?;
    Ok(id)
}

#[tauri::command]
async fn delete_draft(state: State<'_, AppState>, id: String) -> Result<()> {
    sqlx::query("DELETE FROM message_drafts WHERE id=?")
        .bind(id)
        .execute(&state.db)
        .await
        .map_err(err)?;
    Ok(())
}

/* ---------- Postmaster: how a sending domain is set up ---------- */

/// A domain typed as a URL, an email or a bare name, reduced to the host to query.
fn normalize_domain(input: &str) -> String {
    let mut value = input.trim().to_lowercase();
    if let Some(at) = value.rfind('@') {
        value = value[at + 1..].to_string();
    }
    for prefix in ["https://", "http://"] {
        if let Some(rest) = value.strip_prefix(prefix) {
            value = rest.to_string();
        }
    }
    value = value.split(['/', '?', '#']).next().unwrap_or("").to_string();
    value = value.trim_start_matches("www.").to_string();
    value.trim_end_matches('.').to_string()
}

/// Trims a long record (a DKIM public key, say) to something one row can show.
fn shorten(value: &str, max: usize) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    let head: String = trimmed.chars().take(max).collect();
    format!("{head}…")
}

/// A DNS lookup over DNS-over-HTTPS. Google's JSON endpoint is tried first, then
/// Cloudflare's, so no resolver crate is pulled in. A failure — or an absent record — is
/// an empty answer, because "no record" is itself a result this tool reports.
async fn dns_lookup(st: &AppState, name: &str, record: &str) -> Vec<String> {
    for base in [
        "https://dns.google/resolve",
        "https://cloudflare-dns.com/dns-query",
    ] {
        let sent = st
            .http
            .get(base)
            .query(&[("name", name), ("type", record)])
            .header("accept", "application/dns-json")
            .send()
            .await;
        let Ok(response) = sent else { continue };
        let Ok(body) = response.json::<Value>().await else { continue };
        return body["Answer"]
            .as_array()
            .map(|answers| {
                answers
                    .iter()
                    .filter_map(|answer| answer["data"].as_str())
                    // A TXT record split across strings arrives as `"a" "b"`; the quotes
                    // and the join are not part of the value.
                    .map(|data| data.trim_matches('"').replace("\" \"", ""))
                    .collect()
            })
            .unwrap_or_default();
    }
    Vec::new()
}

/// One row of the posture report, with what it earned toward the score.
fn posture_check(id: &str, label: &str, status: &str, detail: String, hint: &str, weight: i64) -> Value {
    let factor = match status {
        "pass" => 1.0,
        "warn" => 0.5,
        _ => 0.0,
    };
    json!({
        "id": id,
        "label": label,
        "status": status,
        "detail": detail,
        "hint": hint,
        "weight": weight,
        "earned": (weight as f64 * factor).round() as i64,
    })
}

/// Selectors worth looking for a DKIM key under. A domain only publishes the ones its
/// mail actually signs with, and these are the common ones.
const DKIM_SELECTORS: [&str; 10] = [
    "google", "default", "selector1", "selector2", "s1", "s2", "k1", "mail", "dkim", "smtp",
];

/// Scores how a sending domain is set up for inbox delivery: SPF, DKIM, DMARC and MX.
/// The number is a risk — 0 is fully authenticated, 100 is unprotected.
#[tauri::command]
async fn domain_posture(state: State<'_, AppState>, domain: String) -> Result<Value> {
    let host = normalize_domain(&domain);
    if !host.contains('.') || host.starts_with('.') {
        return Err("Enter a domain like example.com".into());
    }

    // SPF — the list of servers allowed to send for the domain.
    let spf = dns_lookup(&state, &host, "TXT")
        .await
        .into_iter()
        .find(|record| record.to_lowercase().starts_with("v=spf1"));
    let (spf_status, spf_detail) = match &spf {
        None => ("fail".to_string(), "No TXT record starting with v=spf1".to_string()),
        Some(record) => {
            let lower = record.to_lowercase();
            if lower.contains("+all") || lower.contains("?all") {
                ("warn".to_string(), shorten(record, 160))
            } else {
                ("pass".to_string(), shorten(record, 160))
            }
        }
    };

    // DKIM — a key the provider signs with, found under a common selector.
    let mut dkim_found: Option<String> = None;
    for selector in DKIM_SELECTORS {
        let records = dns_lookup(&state, &format!("{selector}._domainkey.{host}"), "TXT").await;
        if let Some(record) = records.into_iter().find(|record| {
            let lower = record.to_lowercase();
            lower.contains("v=dkim1") || lower.contains("p=")
        }) {
            dkim_found = Some(format!("{selector}._domainkey — {}", shorten(&record, 120)));
            break;
        }
    }

    // DMARC — what a receiver should do with mail that fails the two above.
    let dmarc = dns_lookup(&state, &format!("_dmarc.{host}"), "TXT")
        .await
        .into_iter()
        .find(|record| record.to_lowercase().starts_with("v=dmarc1"));
    let (dmarc_status, dmarc_detail) = match &dmarc {
        None => ("fail".to_string(), "No DMARC record at _dmarc.<domain>".to_string()),
        Some(record) => {
            if record.to_lowercase().contains("p=none") {
                ("warn".to_string(), shorten(record, 160))
            } else {
                ("pass".to_string(), shorten(record, 160))
            }
        }
    };

    // MX — whether a reply can actually reach the domain.
    let mx = dns_lookup(&state, &host, "MX").await;
    let (mx_status, mx_detail) = if mx.is_empty() {
        (
            "warn".to_string(),
            "No MX records — replies to this domain may bounce".to_string(),
        )
    } else {
        ("pass".to_string(), shorten(&mx.join(", "), 160))
    };

    let checks = vec![
        posture_check(
            "spf",
            "SPF",
            &spf_status,
            spf_detail,
            "Publish `v=spf1 include:… -all` so receivers know which servers may send for you.",
            30,
        ),
        posture_check(
            "dkim",
            "DKIM",
            if dkim_found.is_some() { "pass" } else { "fail" },
            dkim_found
                .clone()
                .unwrap_or_else(|| "No key found under a common selector".to_string()),
            "Turn on DKIM signing in your provider so messages arrive with a verifiable signature.",
            30,
        ),
        posture_check(
            "dmarc",
            "DMARC",
            &dmarc_status,
            dmarc_detail,
            "Publish `v=DMARC1; p=none; rua=…` first, then tighten the policy as reports come in.",
            30,
        ),
        posture_check(
            "mx",
            "Mailbox (MX)",
            &mx_status,
            mx_detail,
            "A working mailbox means a reply has somewhere to land, which receivers reward.",
            10,
        ),
    ];

    let earned: i64 = checks
        .iter()
        .map(|check| check.get("earned").and_then(Value::as_i64).unwrap_or(0))
        .sum();
    let score = (100 - earned).clamp(0, 100);
    let level = if score <= 20 {
        "clean"
    } else if score <= 45 {
        "watch"
    } else if score <= 70 {
        "risky"
    } else {
        "spammy"
    };

    Ok(json!({
        "domain": host,
        "score": score,
        "level": level,
        "checks": checks,
    }))
}

/// One call to the Postmaster Tools v2 API, with its refusals turned into something the
/// sender can act on: no access to the domain, no such domain, or a stale token.
async fn postmaster_call(st: &AppState, access: &str, path: &str, body: &Value) -> Result<Value> {
    let response = st
        .http
        .post(format!("https://gmailpostmastertools.googleapis.com/v2/{path}"))
        .bearer_auth(access)
        .json(body)
        .send()
        .await
        .map_err(err)?;
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(AUTH_EXPIRED.to_string());
    }
    let parsed: Value = response.json().await.unwrap_or_else(|_| json!({}));
    if status.is_success() {
        return Ok(parsed);
    }
    let message = parsed["error"]["message"].as_str().unwrap_or("").to_string();
    Err(match status {
        reqwest::StatusCode::FORBIDDEN => format!(
            "Google refused access to this domain in Postmaster Tools{}",
            if message.is_empty() { String::new() } else { format!(" — {message}") }
        ),
        reqwest::StatusCode::NOT_FOUND => {
            "That domain is not registered in Postmaster Tools".to_string()
        }
        _ if message.is_empty() => format!("Google returned {status}"),
        _ => message,
    })
}

/// Posts one query, refreshing the token once if Google rejects it.
async fn postmaster_query(
    st: &AppState,
    account: &str,
    access: &mut String,
    path: &str,
    body: &Value,
) -> Result<Value> {
    match postmaster_call(st, access, path, body).await {
        Ok(value) => Ok(value),
        Err(e) if e == AUTH_EXPIRED => {
            *access = access_token(st, account, "gmail", true).await?;
            postmaster_call(st, access, path, body).await
        }
        Err(e) => Err(e),
    }
}

/// The reputation Google actually measured for a domain: IP and domain reputation,
/// user-reported spam rate, the authentication success ratios, and delivery errors.
/// This is telemetry, not a guess — and Gmail is the only provider that publishes it.
#[tauri::command]
async fn postmaster_report(
    state: State<'_, AppState>,
    domain: String,
    account_id: Option<String>,
) -> Result<Value> {
    let st = state.inner();
    let host = normalize_domain(&domain);
    if !host.contains('.') || host.starts_with('.') {
        return Err("Enter a domain like example.com".into());
    }

    // The Postmaster API is Gmail's, so the reading account has to be a Gmail one.
    let account = match account_id.map(|value| value.trim().to_string()).filter(|value| !value.is_empty()) {
        Some(id) => sqlx::query("SELECT id,provider,email FROM accounts WHERE id=?")
            .bind(&id)
            .fetch_optional(&st.db)
            .await
            .map_err(err)?,
        None => sqlx::query("SELECT id,provider,email FROM accounts WHERE provider='gmail' AND workspace_id=? ORDER BY email LIMIT 1")
            .bind(active_workspace(&st.db).await)
            .fetch_optional(&st.db)
            .await
            .map_err(err)?,
    };
    let Some(account) = account else {
        return Ok(json!({
            "available": false,
            "reason": "Connect a Gmail account to read Postmaster data.",
        }));
    };
    let id: String = account.get("id");
    let provider: String = account.get("provider");
    let email: String = account.get("email");
    if provider != "gmail" {
        return Ok(json!({
            "available": false,
            "account": email,
            "reason": "Postmaster data comes from Gmail only.",
        }));
    }

    // A token granted before this scope existed can read mail but not Postmaster. Ask what
    // was actually granted rather than assume: failing to read the grant is not the same as
    // the permission being absent, and telling the operator to reconnect when the scope is
    // already there just sends them round the loop again.
    let scopes = match token_scopes(st, &id, "gmail").await {
        Ok(list) => list,
        Err(e) => {
            return Ok(json!({
                "available": false,
                "account": email,
                "reason": format!("Could not read the permissions Google granted this account: {e}"),
            }))
        }
    };
    if !scopes
        .iter()
        .any(|scope| scope.eq_ignore_ascii_case("postmaster.traffic.readonly"))
    {
        let reason = if scopes.is_empty() {
            format!("{email} reported no granted permissions. Disconnect and reconnect it in Settings.")
        } else {
            format!(
                "{email} was granted {} — but not postmaster.traffic.readonly. Disconnect and reconnect it in Settings, accepting the Postmaster permission.",
                scopes.join(", ")
            )
        };
        return Ok(json!({
            "available": false,
            "account": email,
            "needs_permission": true,
            "granted": scopes,
            "reason": reason,
        }));
    }

    // v2 asks for named metrics over a date range in one POST. Nothing is per-day unless
    // DAILY granularity is requested, and reputation is no longer a metric it returns.
    let today = Utc::now().date_naive();
    let start = today - chrono::Duration::days(7);
    let day = |value: chrono::NaiveDate| {
        json!({"year": value.year(), "month": value.month(), "day": value.day()})
    };
    let time_query = json!({"dateRanges": {"dateRanges": [{"start": day(start), "end": day(today)}]}});
    let definition = |name: &str, standard: &str, filter: Option<&str>| {
        let mut metric = json!({"name": name, "baseMetric": {"standardMetric": standard}});
        if let Some(filter) = filter {
            metric["filter"] = json!(filter);
        }
        metric
    };
    let full = json!({
        "metricDefinitions": [
            definition("spam_rate", "SPAM_RATE", None),
            definition("auth_spf", "AUTH_SUCCESS_RATE", Some("auth_type = spf")),
            definition("auth_dkim", "AUTH_SUCCESS_RATE", Some("auth_type = dkim")),
            definition("auth_dmarc", "AUTH_SUCCESS_RATE", Some("auth_type = dmarc")),
            definition("delivery_error_rate", "DELIVERY_ERROR_RATE", None),
        ],
        "timeQuery": time_query.clone(),
        "pageSize": 200,
        "aggregationGranularity": "OVERALL",
    });
    // If Google rejects a filtered metric, the unfiltered ones are still worth showing.
    let minimal = json!({
        "metricDefinitions": [
            definition("spam_rate", "SPAM_RATE", None),
            definition("delivery_error_rate", "DELIVERY_ERROR_RATE", None),
        ],
        "timeQuery": time_query,
        "pageSize": 200,
        "aggregationGranularity": "OVERALL",
    });

    let mut access = access_token(st, &id, "gmail", false).await?;
    let path = format!("domains/{host}/domainStats:query");
    let body = match postmaster_query(st, &id, &mut access, &path, &full).await {
        Ok(value) => value,
        Err(_) => match postmaster_query(st, &id, &mut access, &path, &minimal).await {
            Ok(value) => value,
            // Anything else is an answer about the domain, not a crash: report it in place.
            Err(e) => {
                return Ok(json!({
                    "available": false,
                    "account": email,
                    "domain": host,
                    "reason": e,
                }))
            }
        },
    };

    let mut stats: BTreeMap<String, Option<f64>> = BTreeMap::new();
    for stat in body["domainStats"].as_array().cloned().unwrap_or_default() {
        let value = &stat["value"];
        let number = value["doubleValue"]
            .as_f64()
            .or_else(|| value["floatValue"].as_f64())
            // int64 comes back as a string in JSON.
            .or_else(|| value["intValue"].as_str().and_then(|raw| raw.parse::<f64>().ok()));
        stats.insert(stat["metric"].as_str().unwrap_or("").to_string(), number);
    }
    let reported = stats.values().filter(|value| value.is_some()).count();

    Ok(json!({
        "available": true,
        "account": email,
        "domain": host,
        "start": start.format("%Y-%m-%d").to_string(),
        "end": today.format("%Y-%m-%d").to_string(),
        "spam_rate": stats.get("spam_rate").copied().flatten(),
        "spf_success": stats.get("auth_spf").copied().flatten(),
        "dkim_success": stats.get("auth_dkim").copied().flatten(),
        "dmarc_success": stats.get("auth_dmarc").copied().flatten(),
        "delivery_error_rate": stats.get("delivery_error_rate").copied().flatten(),
        "reported": reported,
        "reason": if reported == 0 {
            Some("Google returned no statistics for this range. It only reports domains that send to at least 50 users a day, and only for a domain verified in Postmaster Tools.")
        } else {
            None
        },
    }))
}

async fn log(db: &SqlitePool, level: &str, event: &str, detail: &str) {
    // Stamped with the workspace that was open, so the Home feed stays inside it.
    let _ = sqlx::query("INSERT INTO events(id,level,event_type,detail,created_at,workspace_id) VALUES(?,?,?,?,?,?)")
        .bind(id())
        .bind(level)
        .bind(event)
        .bind(detail)
        .bind(now())
        .bind(active_workspace(db).await)
        .execute(db)
        .await;
}
async fn scheduler(st: AppState) {
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(20));
    loop {
        tick.tick().await;
        if let Err(e) = process_due(&st).await {
            log(&st.db, "error", "scheduler", &e).await
        }
    }
}
/// tao currently gives top-level windows `WS_CAPTION` even when decorations are
/// disabled (tauri-apps/tao#1106), so the native title/control bar stays visible.
/// Strip the frame styles once the window exists; `WS_THICKFRAME` is kept so the
/// window can still be resized.
#[cfg(windows)]
fn strip_native_frame(window: &tauri::WebviewWindow) {
    use std::ffi::c_void;

    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetWindowLongPtrW(hwnd: *mut c_void, index: i32) -> isize;
        fn SetWindowLongPtrW(hwnd: *mut c_void, index: i32, value: isize) -> isize;
        fn SetWindowPos(
            hwnd: *mut c_void,
            after: *mut c_void,
            x: i32,
            y: i32,
            cx: i32,
            cy: i32,
            flags: u32,
        ) -> i32;
    }

    const GWL_STYLE: i32 = -16;
    const GWL_EXSTYLE: i32 = -20;
    const WS_BORDER: isize = 0x0080_0000;
    const WS_DLGFRAME: isize = 0x0040_0000;
    const WS_EX_DLGMODALFRAME: isize = 0x0000_0001;
    const WS_EX_WINDOWEDGE: isize = 0x0000_0100;
    const WS_EX_CLIENTEDGE: isize = 0x0000_0200;
    const WS_EX_STATICEDGE: isize = 0x0002_0000;
    const SWP_NOSIZE: u32 = 0x0001;
    const SWP_NOMOVE: u32 = 0x0002;
    const SWP_NOZORDER: u32 = 0x0004;
    const SWP_FRAMECHANGED: u32 = 0x0020;

    let Ok(handle) = window.hwnd() else {
        return;
    };
    let hwnd = handle.0 as *mut c_void;
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        // Guard the re-application (see `watch_native_frame`): when the caption
        // bits are already gone there is nothing to do, so this cannot loop.
        if style & (WS_BORDER | WS_DLGFRAME) == 0 {
            return;
        }
        SetWindowLongPtrW(hwnd, GWL_STYLE, style & !(WS_BORDER | WS_DLGFRAME));
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(
            hwnd,
            GWL_EXSTYLE,
            ex & !(WS_EX_DLGMODALFRAME | WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE | WS_EX_STATICEDGE),
        );
        SetWindowPos(
            hwnd,
            std::ptr::null_mut(),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED,
        );
    }
}

/// tao re-applies `WS_CAPTION` on later window operations (showing/focusing the
/// window runs `SetWindowPos`, which reintroduces it). Re-strip whenever the
/// window changes; `strip_native_frame` is a no-op once the frame is gone.
///
/// Two guards, both learned from the window vanishing when dragged to a second
/// monitor: the frame re-strip must not run inside the scale-factor notification
/// (re-entering the OS DPI handling with a `SetWindowPos` can strand the window
/// off-screen), and a borderless window left wholly outside every display has to be
/// rescued, since it is otherwise invisible until the app restarts.
#[cfg(windows)]
fn watch_native_frame(window: &tauri::WebviewWindow, log: Option<std::path::PathBuf>) {
    strip_native_frame(window);
    let handle = window.clone();
    let log = Arc::new(log);
    window.on_window_event(move |event| {
        let scale_changed = matches!(event, tauri::WindowEvent::ScaleFactorChanged { .. });
        if !scale_changed {
            strip_native_frame(&handle);
        }
        if scale_changed {
            window_log(&log, "scale factor changed");
        }
        if (scale_changed || matches!(event, tauri::WindowEvent::Moved(_)))
            && ensure_on_screen(&handle)
        {
            window_log(&log, "window was off-screen; re-centred");
        }
    });
}

#[cfg(windows)]
fn window_log(path: &Option<std::path::PathBuf>, line: &str) {
    use std::io::Write;
    let Some(path) = path else { return };
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(file, "{} {}", now(), line);
    }
}

/// Re-centres the window on the primary work area and reports whether it had to.
/// `MonitorFromWindow(MONITOR_DEFAULTTONULL)` is null only when the window overlaps
/// no display at all, so a legitimate drag across the seam is never interrupted.
#[cfg(windows)]
fn ensure_on_screen(window: &tauri::WebviewWindow) -> bool {
    use std::ffi::c_void;

    #[repr(C)]
    #[derive(Default)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        fn MonitorFromWindow(hwnd: *mut c_void, flags: u32) -> *mut c_void;
        fn GetWindowRect(hwnd: *mut c_void, rect: *mut Rect) -> i32;
        fn SetWindowPos(
            hwnd: *mut c_void,
            after: *mut c_void,
            x: i32,
            y: i32,
            cx: i32,
            cy: i32,
            flags: u32,
        ) -> i32;
        fn SystemParametersInfoW(action: u32, param: u32, data: *mut c_void, winini: u32) -> i32;
    }

    const MONITOR_DEFAULTTONULL: u32 = 0;
    const SPI_GETWORKAREA: u32 = 0x0030;
    const SWP_NOZORDER: u32 = 0x0004;
    const SWP_NOACTIVATE: u32 = 0x0010;

    let Ok(handle) = window.hwnd() else {
        return false;
    };
    let hwnd = handle.0 as *mut c_void;
    unsafe {
        if !MonitorFromWindow(hwnd, MONITOR_DEFAULTTONULL).is_null() {
            return false;
        }
        let mut rect = Rect::default();
        if GetWindowRect(hwnd, &mut rect) == 0 {
            return false;
        }
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        let mut work = Rect::default();
        if SystemParametersInfoW(SPI_GETWORKAREA, 0, &mut work as *mut _ as *mut c_void, 0) == 0 {
            return false;
        }
        let work_w = work.right - work.left;
        let work_h = work.bottom - work.top;
        let w = width.clamp(0, work_w);
        let h = height.clamp(0, work_h);
        let x = work.left + (work_w - w) / 2;
        let y = work.top + (work_h - h) / 2;
        SetWindowPos(
            hwnd,
            std::ptr::null_mut(),
            x,
            y,
            w,
            h,
            SWP_NOZORDER | SWP_NOACTIVATE,
        );
        true
    }
}

/// Neither the configured size nor the OS default placement accounts for the
/// taskbar: `center: true` centers on the full monitor and a 820px-tall window
/// overflows a 768px display. Fit the window into the monitor's work area
/// (`rcWork`, which excludes the taskbar) and center it there.
#[cfg(windows)]
fn fit_to_work_area(window: &tauri::WebviewWindow) {
    use std::ffi::c_void;

    #[repr(C)]
    #[derive(Default)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    #[repr(C)]
    #[derive(Default)]
    struct MonitorInfo {
        cb_size: u32,
        rc_monitor: Rect,
        rc_work: Rect,
        flags: u32,
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        fn MonitorFromWindow(hwnd: *mut c_void, flags: u32) -> *mut c_void;
        fn GetMonitorInfoW(monitor: *mut c_void, info: *mut MonitorInfo) -> i32;
        fn GetWindowRect(hwnd: *mut c_void, rect: *mut Rect) -> i32;
        fn IsZoomed(hwnd: *mut c_void) -> i32;
        fn SetWindowPos(
            hwnd: *mut c_void,
            after: *mut c_void,
            x: i32,
            y: i32,
            cx: i32,
            cy: i32,
            flags: u32,
        ) -> i32;
    }

    const MONITOR_DEFAULTTONEAREST: u32 = 2;
    const SWP_NOZORDER: u32 = 0x0004;
    const SWP_NOACTIVATE: u32 = 0x0010;

    let Ok(handle) = window.hwnd() else {
        return;
    };
    let hwnd = handle.0 as *mut c_void;
    unsafe {
        // A maximized window is already at the work-area size; moving it would
        // just look like an un-maximize on launch.
        if IsZoomed(hwnd) != 0 {
            return;
        }
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        if monitor.is_null() {
            return;
        }
        let mut info = MonitorInfo {
            cb_size: std::mem::size_of::<MonitorInfo>() as u32,
            ..Default::default()
        };
        if GetMonitorInfoW(monitor, &mut info) == 0 {
            return;
        }
        let mut rect = Rect::default();
        if GetWindowRect(hwnd, &mut rect) == 0 {
            return;
        }

        let work_w = info.rc_work.right - info.rc_work.left;
        let work_h = info.rc_work.bottom - info.rc_work.top;
        let win_w = rect.right - rect.left;
        let win_h = rect.bottom - rect.top;
        if work_w <= 0 || work_h <= 0 {
            return;
        }

        let width = win_w.min(work_w);
        let height = win_h.min(work_h);
        let x = info.rc_work.left + (work_w - width) / 2;
        let y = info.rc_work.top + (work_h - height) / 2;
        if width == win_w && height == win_h && x == rect.left && y == rect.top {
            return;
        }
        SetWindowPos(
            hwnd,
            std::ptr::null_mut(),
            x,
            y,
            width,
            height,
            SWP_NOZORDER | SWP_NOACTIVATE,
        );
    }
}

/// A borderless window (`decorations: false`, caption stripped) maximises to the
/// full monitor rectangle, so the maximised window covers the taskbar. Windows
/// only clamps a maximized window to the work area for windows that still carry a
/// caption, so ask for the work area ourselves: intercept `WM_GETMINMAXINFO` on
/// the window procedure and report `rcWork` as the maximised size and position.
#[cfg(windows)]
fn constrain_maximize(window: &tauri::WebviewWindow) {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicIsize, Ordering};

    #[repr(C)]
    #[derive(Default)]
    struct Point {
        x: i32,
        y: i32,
    }

    #[repr(C)]
    #[derive(Default)]
    struct MinMaxInfo {
        reserved: Point,
        max_size: Point,
        max_position: Point,
        min_track: Point,
        max_track: Point,
    }

    #[repr(C)]
    #[derive(Default)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    #[repr(C)]
    #[derive(Default)]
    struct MonitorInfo {
        cb_size: u32,
        rc_monitor: Rect,
        rc_work: Rect,
        flags: u32,
    }

    static PREV: AtomicIsize = AtomicIsize::new(0);

    #[link(name = "user32")]
    unsafe extern "system" {
        fn CallWindowProcW(
            prev: isize,
            hwnd: *mut c_void,
            msg: u32,
            wparam: usize,
            lparam: isize,
        ) -> isize;
        fn DefWindowProcW(hwnd: *mut c_void, msg: u32, wparam: usize, lparam: isize) -> isize;
        fn SetWindowLongPtrW(hwnd: *mut c_void, index: i32, value: isize) -> isize;
        fn MonitorFromWindow(hwnd: *mut c_void, flags: u32) -> *mut c_void;
        fn GetMonitorInfoW(monitor: *mut c_void, info: *mut MonitorInfo) -> i32;
    }

    const GWLP_WNDPROC: i32 = -4;
    const WM_GETMINMAXINFO: u32 = 0x0024;
    const MONITOR_DEFAULTTONEAREST: u32 = 2;

    unsafe extern "system" fn proc(
        hwnd: *mut c_void,
        msg: u32,
        wparam: usize,
        lparam: isize,
    ) -> isize {
        let prev = PREV.load(Ordering::Relaxed);
        // Let the default handling fill the struct in first, then correct it.
        let result = if prev == 0 {
            unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
        } else {
            unsafe { CallWindowProcW(prev, hwnd, msg, wparam, lparam) }
        };
        if msg == WM_GETMINMAXINFO && lparam != 0 {
            let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
            if !monitor.is_null() {
                let mut info = MonitorInfo {
                    cb_size: std::mem::size_of::<MonitorInfo>() as u32,
                    ..Default::default()
                };
                if unsafe { GetMonitorInfoW(monitor, &mut info) } != 0 {
                    let work = info.rc_work;
                    let mmi = unsafe { &mut *(lparam as *mut MinMaxInfo) };
                    mmi.max_position = Point {
                        x: work.left,
                        y: work.top,
                    };
                    mmi.max_size = Point {
                        x: work.right - work.left,
                        y: work.bottom - work.top,
                    };
                }
            }
        }
        result
    }

    let Ok(handle) = window.hwnd() else {
        return;
    };
    let hwnd = handle.0 as *mut c_void;
    unsafe {
        // SetWindowLongPtrW installs the subclass and returns the previous proc,
        // which every other message is forwarded to. Storing it before any message
        // can be dispatched keeps the `prev == 0` fallback from ever being hit.
        let prev = SetWindowLongPtrW(hwnd, GWLP_WNDPROC, proc as *const () as isize);
        if prev != 0 {
            PREV.store(prev, Ordering::Relaxed);
        }
    }
}

/// Runs the migrations, tolerating the one failure that is not the database's fault.
///
/// sqlx hashes every migration file byte-for-byte at compile time, so a build whose
/// checkout had different line endings computes different hashes and then refuses to
/// start against a database an earlier build migrated: "migration N was previously
/// applied but has been modified". The SQL is identical either way, so a mismatch is
/// re-checked with the other line ending before it is treated as a real one.
async fn migrate(db: &SqlitePool) -> std::result::Result<(), String> {
    let migrator = sqlx::migrate!("./migrations");
    // One repair per mismatching version. The bound only stops a repair that somehow
    // does not take from looping forever.
    for _ in 0..32 {
        let error = match migrator.run(db).await {
            Ok(()) => return Ok(()),
            Err(error) => error,
        };
        match &error {
            sqlx::migrate::MigrateError::VersionMismatch(version) => {
                if !accept_other_line_endings(db, &migrator, *version).await? {
                    return Err(error.to_string());
                }
            }
            _ => return Err(error.to_string()),
        }
    }
    Err("The database would not accept its migrations".into())
}

/// Rewrites one recorded migration checksum when the only difference is the line ending,
/// and reports whether it did. A recorded checksum that matches neither ending is left
/// alone, so a migration someone genuinely edited still stops the app.
async fn accept_other_line_endings(
    db: &SqlitePool,
    migrator: &sqlx::migrate::Migrator,
    version: i64,
) -> std::result::Result<bool, String> {
    use sha2::{Digest, Sha384};

    let Some(migration) = migrator.iter().find(|m| m.version == version) else {
        return Ok(false);
    };
    let stored: Option<Vec<u8>> =
        sqlx::query_scalar("SELECT checksum FROM _sqlx_migrations WHERE version=?")
            .bind(version)
            .fetch_optional(db)
            .await
            .map_err(err)?;
    let Some(stored) = stored else { return Ok(false) };
    let embedded = migration.checksum.to_vec();
    if stored == embedded {
        return Ok(false);
    }
    let bare = migration.sql.replace("\r\n", "\n");
    let hash = |value: &str| Sha384::digest(value.as_bytes()).to_vec();
    // Whichever of the two endings the database recorded is what it ran; the build's own
    // hash is the other one. Anything else is a different migration.
    let other = if hash(&bare) == embedded {
        hash(&bare.replace('\n', "\r\n"))
    } else {
        hash(&bare)
    };
    if stored != other {
        return Ok(false);
    }
    sqlx::query("UPDATE _sqlx_migrations SET checksum=? WHERE version=?")
        .bind(&embedded)
        .bind(version)
        .execute(db)
        .await
        .map_err(err)?;
    log(
        db,
        "info",
        "migration_line_endings",
        &format!("accepted migration {version} whose line endings changed"),
    )
    .await;
    Ok(true)
}

/// Says why the app is not starting and ends it. A windowed build has no console, so a
/// dialog is the only thing a user can be shown; nothing is left to run afterwards, which
/// is why this does not return.
fn fatal(message: &str) -> ! {
    #[cfg(windows)]
    {
        use std::ffi::c_void;

        #[link(name = "user32")]
        unsafe extern "system" {
            fn MessageBoxW(
                hwnd: *mut c_void,
                text: *const u16,
                caption: *const u16,
                kind: u32,
            ) -> i32;
        }

        const MB_ICONERROR: u32 = 0x0000_0010;
        let wide = |value: &str| {
            value
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect::<Vec<u16>>()
        };
        let body = wide(message);
        let caption = wide("Maily");
        unsafe { MessageBoxW(std::ptr::null_mut(), body.as_ptr(), caption.as_ptr(), MB_ICONERROR) };
    }
    #[cfg(not(windows))]
    eprintln!("Maily: {message}");
    std::process::exit(1);
}

fn main() {
    tracing_subscriber::fmt().with_env_filter("info").init();
    let dir = tauri::path::BaseDirectory::AppData;
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        // In-place updates. The endpoint and the public key live in tauri.conf.json; the
        // download is verified against that key, so a tampered manifest installs nothing.
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Window chrome is owned by the config (decorations: false), so the state
        // plugin must not restore a stale `decorated` value over it, nor restore
        // a maximized frame that would sit over the taskbar.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        - tauri_plugin_window_state::StateFlags::DECORATIONS
                        - tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .setup(move |app| {
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                watch_native_frame(&window, app.path().resolve("window.log", dir).ok());
                constrain_maximize(&window);
                fit_to_work_area(&window);
            }
            // A failure here is the whole reason the app can look like it simply refuses to
            // open: Tauri panics inside its own `run` when a setup hook returns an error,
            // and a windowed build has no console for that panic to reach. So the database
            // is opened and migrated here, and whatever went wrong is put in a dialog.
            let path = match app.path().resolve("maily.sqlite", dir) {
                Ok(path) => path,
                Err(e) => fatal(&format!("Maily could not find its data folder: {e}")),
            };
            if let Err(e) = std::fs::create_dir_all(path.parent().unwrap()) {
                fatal(&format!(
                    "Maily could not create {}: {e}",
                    path.parent().unwrap().display()
                ));
            }
            let opened = tauri::async_runtime::block_on(async {
                let db = SqlitePoolOptions::new()
                    .max_connections(6)
                    .connect(&format!("sqlite:{}?mode=rwc", path.display()))
                    .await
                    .map_err(|e| e.to_string())?;
                migrate(&db).await?;
                Ok::<_, String>(AppState {
                    db,
                    http: Client::new(),
                    agents: Arc::new(Semaphore::new(2)),
                    sync: Arc::new(Semaphore::new(1)),
                    app: app.handle().clone(),
                })
            });
            let state = match opened {
                Ok(state) => state,
                Err(message) => fatal(&format!(
                    "Maily could not open its database.\n\n{}\n\nThe file is {}.",
                    message,
                    path.display()
                )),
            };
            tauri::async_runtime::spawn(scheduler(state.clone()));
            tauri::async_runtime::spawn(inbox_poller(state.clone()));
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            dashboard,
            dashboard_stats,
            list_leads,
            list_lead_lists,
            upsert_leads,
            update_lead,
            delete_lead,
            delete_lead_list,
            suppress_lead,
            save_template,
            seed_templates,
            list_templates,
            delete_template,
            save_campaign,
            save_steps,
            list_campaigns,
            campaign_detail,
            duplicate_campaign,
            export_campaign_csv,
            message_variables,
            campaign_lead_action,
            save_knowledge,
            delete_knowledge,
            list_knowledge,
            preview_knowledge,
            oauth_status,
            save_oauth_client,
            start_oauth,
            finish_oauth,
            await_oauth_redirect,
            list_accounts,
            set_account_limits,
            disconnect_account,
            run_agent,
            list_agent_runs,
            list_agents,
            save_agent,
            delete_agent,
            analyze_style,
            save_openrouter_key,
            openrouter_key_status,
            reveal_openrouter_key,
            clear_openrouter_key,
            list_openrouter_models,
            test_llm,
            get_settings,
            save_setting,
            test_ollama,
            launch_campaign,
            pause_campaign,
            delete_campaign,
            account_permissions,
            sync_inbox,
            send_message,
            inbox_bulk,
            inbox_counts,
            list_sent,
            list_drafts,
            save_draft,
            delete_draft,
            classify_inbox,
            list_channels,
            list_inbox,
            set_inbox_channel,
            mark_inbox_read,
            snooze_inbox,
            inbox_thread,
            thread_followups,
            list_scheduled,
            followup_send_now,
            followup_cancel,
            followup_update,
            followups_pause,
            followups_resume,
            followups_cancel_all,
            domain_posture,
            postmaster_report,
            list_workspaces,
            create_workspace,
            rename_workspace,
            switch_workspace
        ])
        .run(tauri::generate_context!())
        .expect("tauri error");
}
