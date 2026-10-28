use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{Datelike, Days, Duration, Months, Utc};
use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{sqlite::SqlitePoolOptions, Row, SqlitePool};
use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;
use tauri::{Manager, State};
use tokio::sync::Semaphore;
use uuid::Uuid;

#[derive(Clone)]
struct AppState {
    db: SqlitePool,
    http: Client,
    agents: Arc<Semaphore>,
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

/// Resolves the model for a settings slot, falling back to the default slot.
async fn model_for(db: &SqlitePool, slot: &str) -> String {
    let llm = setting(db, "llm").await.unwrap_or_else(|| json!({}));
    for key in [slot, "default_model"] {
        if let Some(value) = llm[key].as_str() {
            if !value.trim().is_empty() {
                return value.trim().to_string();
            }
        }
    }
    "ollama:llama3.2".to_string()
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
        value: parse_model_json(body["choices"][0]["message"]["content"].as_str().unwrap_or_default())?,
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
}
#[derive(Deserialize)]
struct CampaignInput {
    name: String,
    template_id: Option<String>,
    mode: String,
    schedule: Value,
}
#[derive(Deserialize)]
struct TemplateInput {
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
#[derive(Deserialize)]
struct OAuthConfig {
    provider: String,
    client_id: String,
    redirect_uri: String,
}
#[derive(Deserialize)]
struct OAuthCallback {
    provider: String,
    code: String,
    state: String,
    client_id: String,
    client_secret: Option<String>,
    redirect_uri: String,
}
#[derive(Deserialize)]
struct SettingInput {
    key: String,
    value: Value,
}

#[tauri::command]
async fn dashboard(state: State<'_, AppState>) -> Result<Value> {
    let db = &state.db;
    let campaigns = sqlx::query_scalar::<_, i64>("SELECT count(*) FROM campaigns")
        .fetch_one(db)
        .await
        .map_err(err)?;
    let queued = sqlx::query_scalar::<_, i64>("SELECT count(*) FROM jobs WHERE state='queued'")
        .fetch_one(db)
        .await
        .map_err(err)?;
    let sent = sqlx::query_scalar::<_, i64>("SELECT count(*) FROM send_logs WHERE status='sent'")
        .fetch_one(db)
        .await
        .map_err(err)?;
    let failed =
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM send_logs WHERE status='failed'")
            .fetch_one(db)
            .await
            .map_err(err)?;
    let replies = sqlx::query_scalar::<_, i64>("SELECT count(*) FROM inbox_messages")
        .fetch_one(db)
        .await
        .map_err(err)?;
    let interested = sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM inbox_messages WHERE intent='interested'",
    )
    .fetch_one(db)
    .await
    .map_err(err)?;
    Ok(
        json!({"campaigns":campaigns,"queued":queued,"sent":sent,"failed":failed,"replies":replies,"interested":interested,"accounts":sqlx::query("SELECT id,provider,email,health,daily_limit,hourly_limit,sent_today,last_health_at FROM accounts ORDER BY email").fetch_all(db).await.map_err(err)?.iter().map(row_json).collect::<Vec<_>>(),"events":sqlx::query("SELECT level,event_type,detail,created_at FROM events ORDER BY created_at DESC LIMIT 12").fetch_all(db).await.map_err(err)?.iter().map(row_json).collect::<Vec<_>>() }),
    )
}
fn row_json(r: &sqlx::sqlite::SqliteRow) -> Value {
    json!({"id":r.try_get::<String,_>("id").unwrap_or_default(),"provider":r.try_get::<String,_>("provider").unwrap_or_default(),"email":r.try_get::<String,_>("email").unwrap_or_default(),"health":r.try_get::<String,_>("health").unwrap_or_default(),"daily_limit":r.try_get::<i64,_>("daily_limit").unwrap_or(0),"hourly_limit":r.try_get::<i64,_>("hourly_limit").unwrap_or(0),"sent_today":r.try_get::<i64,_>("sent_today").unwrap_or(0),"last_health_at":r.try_get::<String,_>("last_health_at").unwrap_or_default()})
}

fn window_keys(range: &str) -> (Vec<(String, String)>, bool) {
    let now = Utc::now();
    if range == "year" {
        let base = now.date_naive().with_day(1).unwrap_or_else(|| now.date_naive());
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

    let mut current: BTreeMap<String, [i64; 4]> = keys.iter().map(|(k, _)| (k.clone(), [0; 4])).collect();
    let previous: HashSet<String> = if monthly {
        let base = Utc::now().date_naive().with_day(1).unwrap_or_else(|| Utc::now().date_naive());
        (12..24u32)
            .map(|i| base.checked_sub_months(Months::new(i)).unwrap_or(base).format("%Y-%m").to_string())
            .collect()
    } else {
        (day_count..day_count * 2)
            .map(|i| (Utc::now().date_naive() - Days::new(i)).format("%Y-%m-%d").to_string())
            .collect()
    };
    let mut prev = [0i64; 4];

    let logs = sqlx::query("SELECT status, created_at FROM send_logs")
        .fetch_all(&state.db)
        .await
        .map_err(err)?;
    for row in logs {
        let created: String = row.get("created_at");
        let Some(key) = bucket_key(&created, monthly) else { continue };
        let slot = if row.get::<String, _>("status") == "sent" { 0 } else { 3 };
        if let Some(v) = current.get_mut(&key) {
            v[slot] += 1;
        } else if previous.contains(&key) {
            prev[slot] += 1;
        }
    }

    let messages = sqlx::query("SELECT intent, received_at FROM inbox_messages")
        .fetch_all(&state.db)
        .await
        .map_err(err)?;
    for row in messages {
        let received: Option<String> = row.get("received_at");
        let Some(received) = received else { continue };
        let Some(key) = bucket_key(&received, monthly) else { continue };
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
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM inbox_messages WHERE intent IS NULL")
            .fetch_one(&state.db)
            .await
            .map_err(err)?;
    let active_campaigns =
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM campaigns WHERE status='active'")
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
    sqlx::query("SELECT id,email,first_name,last_name,company,title,website,list_name,status,custom_fields FROM leads ORDER BY created_at DESC").fetch_all(&state.db).await.map_err(err).map(|rows| rows.into_iter().map(|r| json!({"id":r.get::<String,_>("id"),"email":r.get::<String,_>("email"),"first_name":r.get::<Option<String>,_>("first_name"),"last_name":r.get::<Option<String>,_>("last_name"),"company":r.get::<Option<String>,_>("company"),"title":r.get::<Option<String>,_>("title"),"website":r.get::<Option<String>,_>("website"),"list_name":r.get::<String,_>("list_name"),"status":r.get::<String,_>("status"),"custom_fields":serde_json::from_str::<Value>(&r.get::<String,_>("custom_fields")).unwrap_or(json!({}))})).collect())
}
#[tauri::command]
async fn upsert_leads(state: State<'_, AppState>, leads: Vec<LeadInput>) -> Result<usize> {
    let mut tx = state.db.begin().await.map_err(err)?;
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
        sqlx::query("INSERT INTO leads(id,email,first_name,last_name,company,title,website,list_name,custom_fields,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET first_name=excluded.first_name,last_name=excluded.last_name,company=excluded.company,title=excluded.title,website=excluded.website,list_name=excluded.list_name,custom_fields=excluded.custom_fields,updated_at=excluded.updated_at").bind(id()).bind(email).bind(l.first_name).bind(l.last_name).bind(l.company).bind(l.title).bind(l.website).bind(l.list_name.unwrap_or_else(||"Unassigned".into())).bind(l.custom_fields.unwrap_or(json!({})).to_string()).bind(&t).bind(&t).execute(&mut *tx).await.map_err(err)?;
        n += 1;
    }
    tx.commit().await.map_err(err)?;
    Ok(n)
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
    let x = id();
    let t = now();
    let purpose = input
        .purpose
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "first_touch".to_string());
    let variants = input.variants.filter(|value| value.is_array()).unwrap_or_else(|| json!([]));
    sqlx::query(
        "INSERT INTO templates(id,name,subject,body,purpose,variants,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
    )
    .bind(&x)
    .bind(input.name)
    .bind(input.subject)
    .bind(input.body)
    .bind(purpose)
    .bind(variants.to_string())
    .bind(&t)
    .bind(&t)
    .execute(&state.db)
    .await
    .map_err(err)?;
    Ok(x)
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
    let existing = sqlx::query_scalar::<_, i64>("SELECT count(*) FROM templates")
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
            "INSERT INTO templates(id,name,subject,body,purpose,variants,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
        )
        .bind(id())
        .bind(name)
        .bind(subject)
        .bind(body)
        .bind(purpose)
        .bind("[]")
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
    sqlx::query("SELECT id,name,subject,body,purpose,variants FROM templates ORDER BY updated_at DESC").fetch_all(&state.db).await.map_err(err).map(|rs|rs.iter().map(|r|json!({"id":r.get::<String,_>("id"),"name":r.get::<String,_>("name"),"subject":r.get::<String,_>("subject"),"body":r.get::<String,_>("body"),"purpose":r.get::<String,_>("purpose"),"variants":serde_json::from_str::<Value>(&r.get::<String,_>("variants")).unwrap_or(json!([]))})).collect())
}
#[tauri::command]
async fn save_campaign(state: State<'_, AppState>, input: CampaignInput) -> Result<String> {
    if input.mode != "draft" && input.mode != "autonomous" {
        return Err("Mode must be draft or autonomous".into());
    }
    let x = id();
    let t = now();
    sqlx::query("INSERT INTO campaigns(id,name,mode,template_id,schedule_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").bind(&x).bind(input.name).bind(input.mode).bind(input.template_id).bind(input.schedule.to_string()).bind(&t).bind(&t).execute(&state.db).await.map_err(err)?;
    Ok(x)
}
#[tauri::command]
async fn list_campaigns(state: State<'_, AppState>) -> Result<Vec<Value>> {
    sqlx::query("SELECT c.id,c.name,c.status,c.mode,c.approved_at,count(cl.lead_id) AS leads FROM campaigns c LEFT JOIN campaign_leads cl ON cl.campaign_id=c.id GROUP BY c.id ORDER BY c.created_at DESC").fetch_all(&state.db).await.map_err(err).map(|rs|rs.iter().map(|r|json!({"id":r.get::<String,_>("id"),"name":r.get::<String,_>("name"),"status":r.get::<String,_>("status"),"mode":r.get::<String,_>("mode"),"approved_at":r.get::<Option<String>,_>("approved_at"),"leads":r.get::<i64,_>("leads")})).collect())
}
#[tauri::command]
async fn approve_campaign(state: State<'_, AppState>, campaign_id: String) -> Result<()> {
    let c = sqlx::query("SELECT mode,template_id FROM campaigns WHERE id=?")
        .bind(&campaign_id)
        .fetch_optional(&state.db)
        .await
        .map_err(err)?
        .ok_or("Campaign not found")?;
    if c.get::<String, _>("mode") != "autonomous" {
        return Err("Only autonomous campaigns require approval".into());
    }
    if c.get::<Option<String>, _>("template_id").is_none() {
        return Err("Campaign needs a template before approval".into());
    }
    sqlx::query("UPDATE campaigns SET status='active',approved_at=?,updated_at=? WHERE id=?")
        .bind(now())
        .bind(now())
        .bind(&campaign_id)
        .execute(&state.db)
        .await
        .map_err(err)?;
    log(&state.db, "info", "campaign_approved", &campaign_id).await;
    Ok(())
}
#[tauri::command]
async fn set_campaign_status(
    state: State<'_, AppState>,
    campaign_id: String,
    status: String,
) -> Result<()> {
    if !["paused", "cancelled", "active"].contains(&status.as_str()) {
        return Err("Invalid campaign status".into());
    }
    if status == "active" {
        let approved: Option<String> =
            sqlx::query_scalar("SELECT approved_at FROM campaigns WHERE id=?")
                .bind(&campaign_id)
                .fetch_one(&state.db)
                .await
                .map_err(err)?;
        if approved.is_none() {
            return Err("Autonomous sending requires explicit approval".into());
        }
    }
    sqlx::query("UPDATE campaigns SET status=?,updated_at=? WHERE id=?")
        .bind(status)
        .bind(now())
        .bind(campaign_id)
        .execute(&state.db)
        .await
        .map_err(err)?;
    Ok(())
}
/// The categories the knowledge base understands. Mirrored in src/lib/knowledge.ts.
const KNOWLEDGE_CATEGORIES: [&str; 7] = ["offer", "icp", "style", "proof", "objection", "product", "other"];

/// Edge labels the schema accepts: the generic ones, the Condition branches, and
/// the five Reply Classifier ports.
const EDGE_LABELS: [&str; 8] = ["next", "yes", "no", "positive", "negative", "question", "ooo", "unsubscribe"];

/// The five labels a classifier node can produce. Mirrored in src/canvas/graph.ts.
const CLASSIFIER_LABELS: [&str; 5] = ["positive", "negative", "question", "ooo", "unsubscribe"];

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
    let tags = input.tags.filter(|value| value.is_array()).unwrap_or_else(|| json!([]));
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
                "INSERT INTO knowledge(id,category,title,content,approved,tags,source,created_at,updated_at) VALUES(?,?,?,?,?,?,'manual',?,?)",
            )
            .bind(&fresh)
            .bind(&category)
            .bind(&title)
            .bind(&input.content)
            .bind(input.approved as i64)
            .bind(tags.to_string())
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
#[tauri::command]
async fn list_knowledge(
    state: State<'_, AppState>,
    category: Option<String>,
    approved_only: Option<bool>,
) -> Result<Vec<Value>> {
    let mut builder = sqlx::QueryBuilder::new(
        "SELECT id,category,title,content,approved,tags,source,updated_at FROM knowledge WHERE 1=1",
    );
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
async fn preview_knowledge(state: State<'_, AppState>, categories: Option<Vec<String>>) -> Result<String> {
    Ok(knowledge_context(&state.db, &categories.unwrap_or_default()).await)
}

#[tauri::command]
async fn start_oauth(state: State<'_, AppState>, config: OAuthConfig) -> Result<String> {
    if !["gmail", "microsoft"].contains(&config.provider.as_str()) {
        return Err("Unsupported provider".into());
    }
    let state_token = id();
    sqlx::query("INSERT INTO oauth_states(state,provider,created_at) VALUES(?,?,?)")
        .bind(&state_token)
        .bind(&config.provider)
        .bind(now())
        .execute(&state.db)
        .await
        .map_err(err)?;
    let (base, scope) = if config.provider == "gmail" {
        ("https://accounts.google.com/o/oauth2/v2/auth","openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly")
    } else {
        ("https://login.microsoftonline.com/common/oauth2/v2.0/authorize","offline_access https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.Read User.Read")
    };
    Ok(format!("{}?client_id={}&redirect_uri={}&response_type=code&response_mode=query&scope={}&state={}&access_type=offline&prompt=consent",base,urlencoding::encode(&config.client_id),urlencoding::encode(&config.redirect_uri),urlencoding::encode(scope),state_token))
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
    let mut form = vec![
        ("client_id", data.client_id),
        ("code", data.code),
        ("redirect_uri", data.redirect_uri),
        ("grant_type", "authorization_code".into()),
    ];
    if let Some(secret) = data.client_secret {
        form.push(("client_secret", secret));
    }
    let token: Value = state
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
    let access = token["access_token"]
        .as_str()
        .ok_or("Provider did not issue access token")?
        .to_string();
    let profile_url = if provider == "gmail" {
        "https://www.googleapis.com/oauth2/v2/userinfo"
    } else {
        "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName"
    };
    let profile: Value = state
        .http
        .get(profile_url)
        .bearer_auth(&access)
        .send()
        .await
        .map_err(err)?
        .error_for_status()
        .map_err(err)?
        .json()
        .await
        .map_err(err)?;
    let email = profile["email"]
        .as_str()
        .or(profile["mail"].as_str())
        .or(profile["userPrincipalName"].as_str())
        .ok_or("Provider did not return an email address")?
        .to_lowercase();
    let account_id = id();
    vault(&format!("oauth:{}", account_id))?
        .set_password(&token.to_string())
        .map_err(err)?;
    let t = now();
    sqlx::query("INSERT INTO accounts(id,provider,email,display_name,health,last_health_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET health='healthy',last_health_at=excluded.last_health_at,updated_at=excluded.updated_at").bind(&account_id).bind(&provider).bind(&email).bind(profile["name"].as_str().or(profile["displayName"].as_str())).bind("healthy").bind(&t).bind(&t).bind(&t).execute(&state.db).await.map_err(err)?;
    sqlx::query("DELETE FROM oauth_states WHERE state=?")
        .bind(data.state)
        .execute(&state.db)
        .await
        .map_err(err)?;
    Ok(json!({"email":email,"provider":provider}))
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
    let x = id();
    let timeout = timeout_seconds.unwrap_or(120).clamp(10, 300);
    sqlx::query("INSERT INTO agent_runs(id,kind,state,model,input_json,timeout_seconds,agent_id,lead_id,campaign_id,created_at) VALUES(?,?,'queued',?,?,?,?,?,?,?)")
        .bind(&x)
        .bind(kind)
        .bind(model)
        .bind(input.to_string())
        .bind(timeout)
        .bind(agent_id)
        .bind(lead_id)
        .bind(campaign_id)
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
    let rows = sqlx::query("SELECT id,kind,state,model,input_json,output_json,error,agent_id,lead_id,campaign_id,prompt_tokens,completion_tokens,cost,created_at,finished_at FROM agent_runs ORDER BY created_at DESC LIMIT ?")
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
        "SELECT a.id,a.name,a.kind,a.model,a.system_prompt,a.knowledge_categories,a.enabled,a.updated_at,(SELECT COALESCE(SUM(r.cost),0) FROM agent_runs r WHERE r.agent_id=a.id) AS cost,(SELECT COUNT(*) FROM agent_runs r WHERE r.agent_id=a.id) AS runs FROM agent_defs a ORDER BY a.kind,a.name",
    )
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
    if input.name.trim().is_empty() || input.model.trim().is_empty() {
        return Err("An agent needs a name and a model".into());
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
                "INSERT INTO agent_defs(id,name,kind,model,system_prompt,knowledge_categories,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
            )
            .bind(&fresh)
            .bind(input.name.trim())
            .bind(&input.kind)
            .bind(input.model.trim())
            .bind(&prompt)
            .bind(categories.to_string())
            .bind(enabled)
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
/// Queues one drafting run per enrolled lead that has no draft for this node yet.
#[tauri::command]
async fn generate_drafts(
    state: State<'_, AppState>,
    campaign_id: String,
    node_id: String,
    limit: Option<i64>,
) -> Result<usize> {
    let agent = sqlx::query("SELECT id,model FROM agent_defs WHERE kind='draft' AND enabled=1 ORDER BY created_at LIMIT 1")
        .fetch_optional(&state.db)
        .await
        .map_err(err)?;
    let (agent_id, model) = match agent {
        Some(row) => (Some(row.get::<String, _>("id")), row.get::<String, _>("model")),
        None => (None, model_for(&state.db, "drafter_model").await),
    };
    let campaign_name: String = sqlx::query_scalar("SELECT name FROM campaigns WHERE id=?")
        .bind(&campaign_id)
        .fetch_optional(&state.db)
        .await
        .map_err(err)?
        .ok_or("Campaign not found")?;
    let leads = sqlx::query(
        "SELECT l.id,l.email,l.first_name,l.last_name,l.company,l.title,l.custom_fields FROM campaign_leads cl JOIN leads l ON l.id=cl.lead_id WHERE cl.campaign_id=? AND l.status='active' AND NOT EXISTS (SELECT 1 FROM email_drafts d WHERE d.campaign_id=cl.campaign_id AND d.lead_id=cl.lead_id AND d.node_id IS ? AND d.state IN ('proposed','approved')) LIMIT ?",
    )
    .bind(&campaign_id)
    .bind(&node_id)
    .bind(limit.unwrap_or(10).clamp(1, 50))
    .fetch_all(&state.db)
    .await
    .map_err(err)?;

    let mut queued = 0;
    for lead in &leads {
        let input = json!({
            "node_id": node_id,
            "campaign": campaign_name,
            "lead": {
                "email": lead.get::<String, _>("email"),
                "first_name": lead.get::<Option<String>, _>("first_name"),
                "last_name": lead.get::<Option<String>, _>("last_name"),
                "company": lead.get::<Option<String>, _>("company"),
                "title": lead.get::<Option<String>, _>("title"),
                "custom_fields": serde_json::from_str::<Value>(&lead.get::<String, _>("custom_fields")).unwrap_or(json!({})),
            },
            "instructions": "Write one cold email for this person. Return strict JSON {\"subject\":\"...\",\"body\":\"...\",\"rationale\":\"...\"}. Plain text body, no markdown, no placeholders, under 150 words."
        });
        run_agent_queued(
            state.inner(),
            "draft",
            &model,
            input,
            Some(150),
            agent_id.as_deref(),
            Some(&lead.get::<String, _>("id")),
            Some(&campaign_id),
        )
        .await?;
        queued += 1;
    }
    Ok(queued)
}
#[tauri::command]
async fn list_drafts(
    state: State<'_, AppState>,
    campaign_id: Option<String>,
    status: Option<String>,
) -> Result<Vec<Value>> {
    let mut builder = sqlx::QueryBuilder::new(
        "SELECT d.id,d.campaign_id,d.lead_id,d.node_id,d.subject,d.body,d.state,d.rationale,d.model,d.created_at,d.approved_at,c.name AS campaign_name,l.email,l.first_name,l.company FROM email_drafts d JOIN campaigns c ON c.id=d.campaign_id JOIN leads l ON l.id=d.lead_id WHERE 1=1",
    );
    if let Some(campaign) = campaign_id.filter(|value| !value.trim().is_empty()) {
        builder.push(" AND d.campaign_id = ").push_bind(campaign);
    }
    if let Some(status) = status.filter(|value| !value.trim().is_empty()) {
        builder.push(" AND d.state = ").push_bind(status);
    }
    builder.push(" ORDER BY d.created_at DESC LIMIT 200");
    let rows = builder.build().fetch_all(&state.db).await.map_err(err)?;
    Ok(rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<String, _>("id"),
                "campaign_id": r.get::<String, _>("campaign_id"),
                "campaign_name": r.get::<String, _>("campaign_name"),
                "lead_id": r.get::<String, _>("lead_id"),
                "node_id": r.get::<Option<String>, _>("node_id"),
                "email": r.get::<String, _>("email"),
                "first_name": r.get::<Option<String>, _>("first_name"),
                "company": r.get::<Option<String>, _>("company"),
                "subject": r.get::<String, _>("subject"),
                "body": r.get::<String, _>("body"),
                "state": r.get::<String, _>("state"),
                "rationale": r.get::<Option<String>, _>("rationale"),
                "model": r.get::<Option<String>, _>("model"),
                "created_at": r.get::<String, _>("created_at"),
                "approved_at": r.get::<Option<String>, _>("approved_at"),
            })
        })
        .collect())
}
#[tauri::command]
async fn approve_draft(
    state: State<'_, AppState>,
    id: String,
    subject: Option<String>,
    body: Option<String>,
) -> Result<()> {
    let row = sqlx::query("SELECT subject,body FROM email_drafts WHERE id=?")
        .bind(&id)
        .fetch_optional(&state.db)
        .await
        .map_err(err)?
        .ok_or("Draft not found")?;
    let next_subject = subject
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| row.get::<String, _>("subject"));
    let next_body = body
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| row.get::<String, _>("body"));
    sqlx::query("UPDATE email_drafts SET state='approved',subject=?,body=?,approved_at=?,updated_at=? WHERE id=?")
        .bind(next_subject)
        .bind(next_body)
        .bind(now())
        .bind(now())
        .bind(&id)
        .execute(&state.db)
        .await
        .map_err(err)?;
    Ok(())
}
#[tauri::command]
async fn reject_draft(state: State<'_, AppState>, id: String) -> Result<()> {
    sqlx::query("UPDATE email_drafts SET state='rejected',updated_at=? WHERE id=?")
        .bind(now())
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
    let templates = sqlx::query("SELECT name,subject,body FROM templates ORDER BY updated_at DESC LIMIT 30")
        .fetch_all(&state.db)
        .await
        .map_err(err)?;
    let sent = sqlx::query("SELECT subject,body FROM send_logs WHERE body IS NOT NULL ORDER BY created_at DESC LIMIT 30")
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

    let model = model_for(&state.db, "style_model").await;
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
    let mut content = outcome.value["profile"].as_str().unwrap_or("").trim().to_string();
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

    sqlx::query("DELETE FROM knowledge WHERE category='style' AND source='analysis'")
        .execute(&state.db)
        .await
        .map_err(err)?;
    let entry = id();
    let t = now();
    sqlx::query("INSERT INTO knowledge(id,category,title,content,approved,tags,source,created_at,updated_at) VALUES(?,'style',?,?,1,'[\"analysis\"]','analysis',?,?)")
        .bind(&entry)
        .bind(&title)
        .bind(content.trim())
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
        if let Ok(row) = sqlx::query("SELECT system_prompt,knowledge_categories FROM agent_defs WHERE id=?")
            .bind(agent_id)
            .fetch_one(&st.db)
            .await
        {
            let custom: String = row.get("system_prompt");
            if !custom.trim().is_empty() {
                parts.push(custom.trim().to_string());
            }
            categories = serde_json::from_str::<Vec<String>>(&row.get::<String, _>("knowledge_categories"))
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
    let input: Value = serde_json::from_str(&r.get::<String, _>("input_json")).unwrap_or_else(|_| json!({}));

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
                if let (Some(campaign_id), Some(lead_id)) = (campaign_id.as_deref(), lead_id.as_deref()) {
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
async fn list_openrouter_models(state: State<'_, AppState>, refresh: Option<bool>) -> Result<Vec<Value>> {
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

#[derive(Deserialize, serde::Serialize)]
struct GraphNode {
    id: String,
    #[serde(rename = "type")]
    node_type: String,
    #[serde(default)]
    config: Value,
    #[serde(default)]
    x: f64,
    #[serde(default)]
    y: f64,
}
#[derive(Deserialize, serde::Serialize)]
struct GraphEdge {
    id: String,
    from_node: String,
    to_node: String,
    #[serde(default = "default_edge_label")]
    label: String,
}
fn default_edge_label() -> String {
    "next".to_string()
}

#[tauri::command]
async fn save_campaign_graph(
    state: State<'_, AppState>,
    campaign_id: String,
    nodes: Vec<GraphNode>,
    edges: Vec<GraphEdge>,
) -> Result<()> {
    let mut tx = state.db.begin().await.map_err(err)?;
    sqlx::query("DELETE FROM campaign_edges WHERE campaign_id=?")
        .bind(&campaign_id)
        .execute(&mut *tx)
        .await
        .map_err(err)?;
    sqlx::query("DELETE FROM campaign_nodes WHERE campaign_id=?")
        .bind(&campaign_id)
        .execute(&mut *tx)
        .await
        .map_err(err)?;
    for n in &nodes {
        if !["start", "audience", "email", "delay", "condition", "action", "classifier", "end"].contains(&n.node_type.as_str()) {
            return Err(format!("Unknown node type: {}", n.node_type));
        }
        sqlx::query("INSERT INTO campaign_nodes(id,campaign_id,type,config_json,x,y) VALUES(?,?,?,?,?,?)")
            .bind(&n.id)
            .bind(&campaign_id)
            .bind(&n.node_type)
            .bind(n.config.to_string())
            .bind(n.x)
            .bind(n.y)
            .execute(&mut *tx)
            .await
            .map_err(err)?;
    }
    for e in &edges {
        let label = if EDGE_LABELS.contains(&e.label.as_str()) {
            e.label.clone()
        } else {
            "next".to_string()
        };
        sqlx::query("INSERT INTO campaign_edges(id,campaign_id,from_node,to_node,label) VALUES(?,?,?,?,?)")
            .bind(&e.id)
            .bind(&campaign_id)
            .bind(&e.from_node)
            .bind(&e.to_node)
            .bind(label)
            .execute(&mut *tx)
            .await
            .map_err(err)?;
    }
    tx.commit().await.map_err(err)?;
    Ok(())
}

#[tauri::command]
async fn load_campaign_graph(state: State<'_, AppState>, campaign_id: String) -> Result<Value> {
    convert_sequence_steps(&state.db, &campaign_id).await?;
    let nodes = sqlx::query("SELECT id,type,config_json,x,y FROM campaign_nodes WHERE campaign_id=? ORDER BY y,id")
        .bind(&campaign_id)
        .fetch_all(&state.db)
        .await
        .map_err(err)?;
    let node_list: Vec<Value> = nodes
        .iter()
        .map(|r| json!({"id":r.get::<String,_>("id"),"type":r.get::<String,_>("type"),"config":serde_json::from_str::<Value>(&r.get::<String,_>("config_json")).unwrap_or(json!({})),"x":r.get::<f64,_>("x"),"y":r.get::<f64,_>("y")}))
        .collect();
    let edges = sqlx::query("SELECT id,from_node,to_node,label FROM campaign_edges WHERE campaign_id=?")
        .bind(&campaign_id)
        .fetch_all(&state.db)
        .await
        .map_err(err)?;
    let edge_list: Vec<Value> = edges
        .iter()
        .map(|r| json!({"id":r.get::<String,_>("id"),"from_node":r.get::<String,_>("from_node"),"to_node":r.get::<String,_>("to_node"),"label":r.get::<String,_>("label")}))
        .collect();
    let counts = sqlx::query("SELECT current_node_id, count(*) AS n FROM campaign_leads WHERE campaign_id=? AND current_node_id IS NOT NULL GROUP BY current_node_id")
        .bind(&campaign_id)
        .fetch_all(&state.db)
        .await
        .map_err(err)?;
    let count_map: serde_json::Map<String, Value> = counts
        .iter()
        .map(|r| (r.get::<String, _>("current_node_id"), json!(r.get::<i64, _>("n"))))
        .collect();
    Ok(json!({"nodes":node_list,"edges":edge_list,"counts":count_map}))
}

#[tauri::command]
async fn validate_campaign_graph(state: State<'_, AppState>, campaign_id: String) -> Result<Value> {
    let issues = graph_issues(&state.db, &campaign_id).await?;
    let messages: Vec<&str> = issues.iter().map(|(message, _)| message.as_str()).collect();
    let node_ids: Vec<&str> = issues.iter().filter_map(|(_, id)| id.as_deref()).collect();
    Ok(json!({"valid": messages.is_empty(), "issues": messages, "node_ids": node_ids}))
}

#[tauri::command]
async fn preview_path(state: State<'_, AppState>, campaign_id: String, lead_id: String) -> Result<Vec<Value>> {
    let start: Option<String> =
        sqlx::query_scalar("SELECT id FROM campaign_nodes WHERE campaign_id=? AND type='start' LIMIT 1")
            .bind(&campaign_id)
            .fetch_optional(&state.db)
            .await
            .map_err(err)?;
    let Some(mut node) = start else { return Err("Graph has no Start node".into()) };
    let lead = sqlx::query("SELECT * FROM leads WHERE id=?")
        .bind(&lead_id)
        .fetch_optional(&state.db)
        .await
        .map_err(err)?
        .ok_or("Lead not found")?;
    let mut path = Vec::new();
    for _ in 0..40 {
        let row = sqlx::query("SELECT type,config_json FROM campaign_nodes WHERE id=?")
            .bind(&node)
            .fetch_optional(&state.db)
            .await
            .map_err(err)?;
        let Some(row) = row else { break };
        let node_type: String = row.get("type");
        let config: Value = serde_json::from_str(&row.get::<String, _>("config_json")).unwrap_or(json!({}));
        let detail = match node_type.as_str() {
            "email" => {
                let template_id = config["template_id"].as_str().unwrap_or_default();
                let t = sqlx::query("SELECT subject FROM templates WHERE id=?")
                    .bind(template_id)
                    .fetch_optional(&state.db)
                    .await
                    .map_err(err)?;
                t.map(|r| render(&r.get::<String, _>("subject"), &lead)).unwrap_or_default()
            }
            "delay" => format!("wait {} minutes", config["minutes"].as_i64().unwrap_or(0)),
            "condition" => format!("branch on {}", config["kind"].as_str().unwrap_or("replied")),
            "action" => config["kind"].as_str().unwrap_or("action").to_string(),
            "end" => config["outcome"].as_str().unwrap_or("completed").to_string(),
            _ => String::new(),
        };
        path.push(json!({"id": node, "type": node_type, "detail": detail}));
        if node_type == "end" {
            break;
        }
        let next: Option<String> = sqlx::query_scalar(
            "SELECT to_node FROM campaign_edges WHERE campaign_id=? AND from_node=? AND label='next' LIMIT 1",
        )
        .bind(&campaign_id)
        .bind(&node)
        .fetch_optional(&state.db)
        .await
        .map_err(err)?;
        match next {
            Some(n) => node = n,
            None => break,
        }
    }
    Ok(path)
}

/// The entry node decides who is enrolled: its `list_name` scopes the audience
/// to one saved lead list, and an empty list means every active lead.
async fn entry_node(db: &SqlitePool, campaign_id: &str) -> Result<(String, String)> {
    let row = sqlx::query(
        "SELECT id,config_json FROM campaign_nodes WHERE campaign_id=? AND type IN ('audience','start') ORDER BY CASE type WHEN 'audience' THEN 0 ELSE 1 END LIMIT 1",
    )
    .bind(campaign_id)
    .fetch_optional(db)
    .await
    .map_err(err)?
    .ok_or("Graph has no Audience or Start node")?;
    let config: Value = serde_json::from_str(&row.get::<String, _>("config_json")).unwrap_or(json!({}));
    let list = config["list_name"].as_str().unwrap_or("").trim().to_string();
    Ok((row.get::<String, _>("id"), list))
}

#[tauri::command]
async fn list_lead_lists(state: State<'_, AppState>) -> Result<Vec<Value>> {
    sqlx::query("SELECT list_name,count(*) AS count FROM leads GROUP BY list_name ORDER BY list_name")
        .fetch_all(&state.db)
        .await
        .map_err(err)
        .map(|rows| {
            rows.iter()
                .map(|r| json!({"name": r.get::<String, _>("list_name"), "count": r.get::<i64, _>("count")}))
                .collect()
        })
}

#[tauri::command]
async fn launch_campaign(state: State<'_, AppState>, campaign_id: String) -> Result<usize> {
    let c = sqlx::query("SELECT status,mode,approved_at FROM campaigns WHERE id=?")
        .bind(&campaign_id)
        .fetch_optional(&state.db)
        .await
        .map_err(err)?
        .ok_or("Campaign not found")?;
    if c.get::<String, _>("status") == "active" {
        return Err("Campaign is already running".into());
    }
    if c.get::<String, _>("mode") == "autonomous" && c.get::<Option<String>, _>("approved_at").is_none() {
        return Err("Autonomous campaigns need explicit approval before launch".into());
    }
    let issues = graph_issues(&state.db, &campaign_id).await?;
    if !issues.is_empty() {
        let summary = issues.iter().map(|(message, _)| message.as_str()).collect::<Vec<_>>().join("; ");
        return Err(format!("Graph is not valid: {}", summary));
    }
    let (entry, list) = entry_node(&state.db, &campaign_id).await?;
    let enrolled = if list.is_empty() {
        sqlx::query(
            "INSERT OR IGNORE INTO campaign_leads(campaign_id,lead_id,state,current_node_id,entered_node_at) SELECT ?, id, 'active', ?, ? FROM leads WHERE status='active' AND email NOT IN (SELECT email FROM suppressions)",
        )
        .bind(&campaign_id)
        .bind(&entry)
        .bind(now())
        .execute(&state.db)
        .await
        .map_err(err)?
        .rows_affected()
    } else {
        sqlx::query(
            "INSERT OR IGNORE INTO campaign_leads(campaign_id,lead_id,state,current_node_id,entered_node_at) SELECT ?, id, 'active', ?, ? FROM leads WHERE status='active' AND list_name=? AND email NOT IN (SELECT email FROM suppressions)",
        )
        .bind(&campaign_id)
        .bind(&entry)
        .bind(now())
        .bind(&list)
        .execute(&state.db)
        .await
        .map_err(err)?
        .rows_affected()
    };
    sqlx::query("UPDATE campaigns SET status='active',updated_at=? WHERE id=?")
        .bind(now())
        .bind(&campaign_id)
        .execute(&state.db)
        .await
        .map_err(err)?;
    log(&state.db, "info", "campaign_launched", &format!("{} leads", enrolled)).await;
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
    // Queued sends are keyed by `campaign:lead:node`, so clear them before the
    // campaign row goes away and the scheduler can no longer resolve it.
    sqlx::query("DELETE FROM jobs WHERE idempotency_key LIKE ?")
        .bind(format!("{}:%", campaign_id))
        .execute(&mut *tx)
        .await
        .map_err(err)?;
    for table in ["campaign_leads", "campaign_edges", "campaign_nodes", "sequence_steps"] {
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

/// Convert any legacy linear `sequence_steps` into a Start -> (Delay -> Email)* -> End graph.
/// Lazy and idempotent: only runs while a campaign still has no nodes.
async fn convert_sequence_steps(db: &SqlitePool, campaign_id: &str) -> Result<()> {
    let existing = sqlx::query_scalar::<_, i64>("SELECT count(*) FROM campaign_nodes WHERE campaign_id=?")
        .bind(campaign_id)
        .fetch_one(db)
        .await
        .map_err(err)?;
    if existing > 0 {
        return Ok(());
    }
    let steps = sqlx::query("SELECT delay_minutes,template_id FROM sequence_steps WHERE campaign_id=? AND enabled=1 ORDER BY position")
        .bind(campaign_id)
        .fetch_all(db)
        .await
        .map_err(err)?;
    if steps.is_empty() {
        return Ok(());
    }
    let mut tx = db.begin().await.map_err(err)?;
    let start = id();
    sqlx::query("INSERT INTO campaign_nodes(id,campaign_id,type,config_json,x,y) VALUES(?,?,'start','{}',0,0)")
        .bind(&start)
        .bind(campaign_id)
        .execute(&mut *tx)
        .await
        .map_err(err)?;
    let mut prev = start;
    let mut y = 0.0f64;
    for s in &steps {
        let delay = s.get::<i64, _>("delay_minutes");
        if delay > 0 {
            let node = id();
            y += 140.0;
            sqlx::query("INSERT INTO campaign_nodes(id,campaign_id,type,config_json,x,y) VALUES(?,?,'delay',?,0,?)")
                .bind(&node)
                .bind(campaign_id)
                .bind(json!({"minutes":delay}).to_string())
                .bind(y)
                .execute(&mut *tx)
                .await
                .map_err(err)?;
            sqlx::query("INSERT INTO campaign_edges(id,campaign_id,from_node,to_node,label) VALUES(?,?,?,?,'next')")
                .bind(id())
                .bind(campaign_id)
                .bind(&prev)
                .bind(&node)
                .execute(&mut *tx)
                .await
                .map_err(err)?;
            prev = node;
        }
        let node = id();
        y += 140.0;
        sqlx::query("INSERT INTO campaign_nodes(id,campaign_id,type,config_json,x,y) VALUES(?,?,'email',?,0,?)")
            .bind(&node)
            .bind(campaign_id)
            .bind(json!({"template_id":s.get::<String,_>("template_id"),"variant":"a"}).to_string())
            .bind(y)
            .execute(&mut *tx)
            .await
            .map_err(err)?;
        sqlx::query("INSERT INTO campaign_edges(id,campaign_id,from_node,to_node,label) VALUES(?,?,?,?,'next')")
            .bind(id())
            .bind(campaign_id)
            .bind(&prev)
            .bind(&node)
            .execute(&mut *tx)
            .await
            .map_err(err)?;
        prev = node;
    }
    let end = id();
    y += 140.0;
    sqlx::query("INSERT INTO campaign_nodes(id,campaign_id,type,config_json,x,y) VALUES(?,?,'end','{\"outcome\":\"completed\"}',0,?)")
        .bind(&end)
        .bind(campaign_id)
        .bind(y)
        .execute(&mut *tx)
        .await
        .map_err(err)?;
    sqlx::query("INSERT INTO campaign_edges(id,campaign_id,from_node,to_node,label) VALUES(?,?,?,?,'next')")
        .bind(id())
        .bind(campaign_id)
        .bind(&prev)
        .bind(&end)
        .execute(&mut *tx)
        .await
        .map_err(err)?;
    tx.commit().await.map_err(err)?;
    Ok(())
}

/// A graph is invalid when it has no single Start, a cycle that no Delay breaks, a
/// dangling Email, or a Condition missing a Yes/No branch. Each issue carries the
/// offending node id when it belongs to one node.
async fn graph_issues(db: &SqlitePool, campaign_id: &str) -> Result<Vec<(String, Option<String>)>> {
    let node_rows = sqlx::query("SELECT id,type FROM campaign_nodes WHERE campaign_id=?")
        .bind(campaign_id)
        .fetch_all(db)
        .await
        .map_err(err)?;
    let nodes: Vec<(String, String)> = node_rows
        .iter()
        .map(|r| (r.get::<String, _>("id"), r.get::<String, _>("type")))
        .collect();
    let edge_rows = sqlx::query("SELECT from_node,to_node,label FROM campaign_edges WHERE campaign_id=?")
        .bind(campaign_id)
        .fetch_all(db)
        .await
        .map_err(err)?;
    let edges: Vec<(String, String, String)> = edge_rows
        .iter()
        .map(|r| (r.get::<String, _>("from_node"), r.get::<String, _>("to_node"), r.get::<String, _>("label")))
        .collect();

    let mut issues = Vec::new();
    // The entry is the Audience node (which lead list to enroll); a legacy Start
    // node stands in for graphs built before Audience existed.
    let audiences = nodes.iter().filter(|(_, t)| t == "audience").count();
    let starts = nodes.iter().filter(|(_, t)| t == "start").count();
    if audiences > 1 {
        issues.push(("Graph has more than one Audience node".to_string(), None));
    } else if audiences == 0 {
        if starts == 0 {
            issues.push(("Graph has no Audience or Start node".to_string(), None));
        } else if starts > 1 {
            issues.push(("Graph has more than one Start node".to_string(), None));
        }
    }
    for (id, node_type) in &nodes {
        if node_type == "email" && !edges.iter().any(|(from, _, _)| from == id) {
            issues.push((format!("Email node {} has no outgoing edge", &id[..8.min(id.len())]), Some(id.clone())));
        }
        if node_type == "condition" {
            let yes = edges.iter().any(|(from, _, label)| from == id && label == "yes");
            let no = edges.iter().any(|(from, _, label)| from == id && label == "no");
            if !yes || !no {
                issues.push((
                    format!("Condition node {} needs both Yes and No branches", &id[..8.min(id.len())]),
                    Some(id.clone()),
                ));
            }
        }
        if node_type == "classifier"
            && !edges
                .iter()
                .any(|(from, _, label)| from == id && CLASSIFIER_LABELS.contains(&label.as_str()))
        {
            issues.push((
                format!("Classifier node {} has no labelled branch", &id[..8.min(id.len())]),
                Some(id.clone()),
            ));
        }
    }
    if cycle_without_delay(&nodes, &edges) {
        issues.push(("Graph has a cycle that no Delay breaks".to_string(), None));
    }
    Ok(issues)
}

fn cycle_without_delay(nodes: &[(String, String)], edges: &[(String, String, String)]) -> bool {
    let delay: HashSet<&str> = nodes.iter().filter(|(_, t)| t == "delay").map(|(id, _)| id.as_str()).collect();
    let mut adj: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    for (from, to, _) in edges {
        if delay.contains(from.as_str()) {
            continue;
        }
        adj.entry(from.clone()).or_default().push(to.clone());
    }
    fn dfs(node: &str, adj: &std::collections::HashMap<String, Vec<String>>, state: &mut std::collections::HashMap<String, u8>) -> bool {
        state.insert(node.to_string(), 1);
        if let Some(neighbours) = adj.get(node) {
            for n in neighbours {
                match state.get(n).copied().unwrap_or(0) {
                    1 => return true,
                    0 => {
                        if dfs(n, adj, state) {
                            return true;
                        }
                    }
                    _ => {}
                }
            }
        }
        state.insert(node.to_string(), 2);
        false
    }
    let mut state: std::collections::HashMap<String, u8> = std::collections::HashMap::new();
    let keys: Vec<String> = adj.keys().cloned().collect();
    for key in keys {
        if state.get(&key).copied().unwrap_or(0) == 0 && dfs(&key, &adj, &mut state) {
            return true;
        }
    }
    false
}
async fn process_due(st: &AppState) -> Result<()> {
    // Walk every active lead one node forward toward the end of its campaign graph.
    // Leads parked on a classifier are excluded: a reply is what moves them, and
    // polling them here would starve the rest of the queue.
    let leads = sqlx::query("SELECT cl.campaign_id, cl.lead_id, cl.current_node_id, cl.entered_node_at, cl.account_id FROM campaign_leads cl JOIN campaigns c ON c.id=cl.campaign_id WHERE cl.state='active' AND c.status='active' AND c.approved_at IS NOT NULL AND cl.current_node_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM campaign_nodes n WHERE n.id=cl.current_node_id AND n.type='classifier') ORDER BY cl.entered_node_at ASC LIMIT 12")
        .fetch_all(&st.db)
        .await
        .map_err(err)?;
    for row in leads {
        let campaign_id: String = row.get("campaign_id");
        let lead_id: String = row.get("lead_id");
        let node_id: Option<String> = row.get("current_node_id");
        let entered_at: Option<String> = row.get("entered_node_at");
        let account_id: Option<String> = row.get("account_id");
        let Some(node_id) = node_id else { continue };
        if let Err(e) = advance_lead(st, &campaign_id, &lead_id, &node_id, entered_at.as_deref(), account_id.as_deref()).await {
            log(&st.db, "warn", "graph_advance", &format!("{}: {}", lead_id, e)).await;
        }
    }
    Ok(())
}

/// Judges one reply into the five fixed labels. Anything the model cannot answer
/// cleanly comes back as `needs_review`, and every attempt is recorded.
async fn judge_reply(
    st: &AppState,
    campaign_id: &str,
    lead_id: &str,
    node_id: &str,
    message_id: Option<&str>,
    config: &Value,
    text: &str,
) -> Result<(String, f64, String)> {
    let model = match config["model"].as_str().filter(|value| !value.trim().is_empty()) {
        Some(value) => value.trim().to_string(),
        None => model_for(&st.db, "classifier_model").await,
    };
    let categories: Vec<String> = config["knowledge"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(|value| value.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let mut system = String::from(
        "You judge replies to cold email. Return strict JSON {\"label\":\"...\",\"confidence\":0.0,\"rationale\":\"...\"}. \
         Use exactly one label: \
         positive = wants to talk, or asked to be contacted; \
         negative = not interested, or asked to stop; \
         question = asked something that needs a real answer; \
         ooo = automated out-of-office or delivery notice; \
         unsubscribe = explicitly opted out or asked to be removed. \
         Never invent intent that is not present in the reply.",
    );
    if let Some(instruction) = config["instruction"].as_str().filter(|value| !value.trim().is_empty()) {
        system.push_str(&format!("\n\nOperator guidance: {}", instruction.trim()));
    }
    let knowledge = knowledge_context(&st.db, &categories).await;
    if !knowledge.is_empty() {
        system.push_str(&format!("\n\nKnowledge base:\n{knowledge}"));
    }

    let mut label = "needs_review".to_string();
    let mut confidence = 0.0f64;
    let mut rationale = String::new();
    let mut raw = json!({});
    match llm_json(
        st,
        &model,
        Some(&system),
        &format!("Reply:\n{}", text.chars().take(6000).collect::<String>()),
        60,
    )
    .await
    {
        Ok(outcome) => {
            raw = outcome.value.clone();
            let candidate = outcome.value["label"]
                .as_str()
                .unwrap_or("")
                .trim()
                .to_lowercase();
            if CLASSIFIER_LABELS.contains(&candidate.as_str()) {
                label = candidate;
                confidence = outcome.value["confidence"].as_f64().unwrap_or(0.0).clamp(0.0, 1.0);
            } else {
                rationale = format!("The model returned an unusable label: {candidate}");
            }
            if let Some(note) = outcome.value["rationale"].as_str() {
                if !note.trim().is_empty() {
                    rationale = note.trim().to_string();
                }
            }
        }
        Err(e) => {
            rationale = e;
        }
    }

    sqlx::query("INSERT INTO reply_judgements(id,campaign_id,lead_id,message_id,node_id,model,label,confidence,rationale,raw_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
        .bind(id())
        .bind(campaign_id)
        .bind(lead_id)
        .bind(message_id)
        .bind(node_id)
        .bind(&model)
        .bind(&label)
        .bind(confidence)
        .bind(&rationale)
        .bind(raw.to_string())
        .bind(now())
        .execute(&st.db)
        .await
        .map_err(err)?;

    Ok((label, confidence, rationale))
}

async fn advance_lead(
    st: &AppState,
    campaign_id: &str,
    lead_id: &str,
    node_id: &str,
    entered_at: Option<&str>,
    account_id: Option<&str>,
) -> Result<()> {
    let node = sqlx::query("SELECT type,config_json FROM campaign_nodes WHERE id=?")
        .bind(node_id)
        .fetch_optional(&st.db)
        .await
        .map_err(err)?
        .ok_or("Node not found")?;
    let node_type: String = node.get("type");
    let config: Value = serde_json::from_str(&node.get::<String, _>("config_json")).unwrap_or(json!({}));
    match node_type.as_str() {
        "delay" => {
            let minutes = config["minutes"].as_i64().unwrap_or(0);
            let due = entered_at
                .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
                .map(|dt| dt.with_timezone(&Utc) + Duration::minutes(minutes) <= Utc::now())
                .unwrap_or(true);
            if due {
                move_next(st, campaign_id, lead_id, node_id).await?;
            }
        }
        "email" => {
            let (job_id, payload) = ensure_job(st, campaign_id, lead_id, node_id, account_id).await?;
            match send_job(st, &job_id, &payload).await {
                Ok(()) => {
                    sqlx::query("UPDATE jobs SET state='completed',updated_at=? WHERE id=?")
                        .bind(now())
                        .bind(&job_id)
                        .execute(&st.db)
                        .await
                        .map_err(err)?;
                    move_next(st, campaign_id, lead_id, node_id).await?;
                }
                Err(e) => {
                    sqlx::query("UPDATE jobs SET state='failed',error=?,updated_at=? WHERE id=?")
                        .bind(&e)
                        .bind(now())
                        .bind(&job_id)
                        .execute(&st.db)
                        .await
                        .map_err(err)?;
                    return Err(e);
                }
            }
        }
        "classifier" => {
            // A reply is what drives this node, so it was resumed by store_message.
            let lead_email: String = sqlx::query_scalar("SELECT email FROM leads WHERE id=?")
                .bind(lead_id)
                .fetch_one(&st.db)
                .await
                .map_err(err)?;
            let message = sqlx::query("SELECT id,subject,raw_excerpt FROM inbox_messages WHERE from_email=? ORDER BY received_at DESC LIMIT 1")
                .bind(&lead_email)
                .fetch_optional(&st.db)
                .await
                .map_err(err)?;
            let Some(message) = message else {
                return Ok(());
            };
            let text = format!(
                "{} {}",
                message.get::<Option<String>, _>("subject").unwrap_or_default(),
                message.get::<Option<String>, _>("raw_excerpt").unwrap_or_default()
            );
            sqlx::query("UPDATE campaign_leads SET last_reply_at=COALESCE(last_reply_at,?) WHERE campaign_id=? AND lead_id=?")
                .bind(now())
                .bind(campaign_id)
                .bind(lead_id)
                .execute(&st.db)
                .await
                .map_err(err)?;

            let message_id: String = message.get("id");
            let (label, confidence, _) =
                judge_reply(st, campaign_id, lead_id, node_id, Some(&message_id), &config, &text).await?;
            let minimum = config["min_confidence"].as_f64().unwrap_or(0.6);
            if label == "needs_review" || confidence < minimum {
                // Guessing would route a real prospect down the wrong branch.
                sqlx::query("UPDATE leads SET status='needs_attention',updated_at=? WHERE id=?")
                    .bind(now())
                    .bind(lead_id)
                    .execute(&st.db)
                    .await
                    .map_err(err)?;
                sqlx::query("UPDATE campaign_leads SET state='paused' WHERE campaign_id=? AND lead_id=?")
                    .bind(campaign_id)
                    .bind(lead_id)
                    .execute(&st.db)
                    .await
                    .map_err(err)?;
                log(&st.db, "warn", "classifier_review", lead_id).await;
                return Ok(());
            }

            let target: Option<String> = sqlx::query_scalar(
                "SELECT to_node FROM campaign_edges WHERE campaign_id=? AND from_node=? AND label=? LIMIT 1",
            )
            .bind(campaign_id)
            .bind(node_id)
            .bind(&label)
            .fetch_optional(&st.db)
            .await
            .map_err(err)?;
            match target {
                Some(next) => enter_node(st, campaign_id, lead_id, &next).await?,
                None => move_next(st, campaign_id, lead_id, node_id).await?,
            }
        }
        "condition" => {
            let branch = condition_branch(st, lead_id, &config).await?;
            let target: Option<String> = sqlx::query_scalar(
                "SELECT to_node FROM campaign_edges WHERE campaign_id=? AND from_node=? AND label=? LIMIT 1",
            )
            .bind(campaign_id)
            .bind(node_id)
            .bind(&branch)
            .fetch_optional(&st.db)
            .await
            .map_err(err)?;
            match target {
                Some(next) => enter_node(st, campaign_id, lead_id, &next).await?,
                None => move_next(st, campaign_id, lead_id, node_id).await?,
            }
        }
        "action" => {
            apply_action(st, lead_id, &config).await?;
            move_next(st, campaign_id, lead_id, node_id).await?;
        }
        "end" => {
            let outcome = config["outcome"].as_str().unwrap_or("completed");
            sqlx::query("UPDATE campaign_leads SET state='done',outcome=? WHERE campaign_id=? AND lead_id=?")
                .bind(outcome)
                .bind(campaign_id)
                .bind(lead_id)
                .execute(&st.db)
                .await
                .map_err(err)?;
        }
        _ => move_next(st, campaign_id, lead_id, node_id).await?,
    }
    Ok(())
}

async fn enter_node(st: &AppState, campaign_id: &str, lead_id: &str, node_id: &str) -> Result<()> {
    sqlx::query("UPDATE campaign_leads SET current_node_id=?,entered_node_at=? WHERE campaign_id=? AND lead_id=?")
        .bind(node_id)
        .bind(now())
        .bind(campaign_id)
        .bind(lead_id)
        .execute(&st.db)
        .await
        .map_err(err)?;
    Ok(())
}

async fn move_next(st: &AppState, campaign_id: &str, lead_id: &str, from: &str) -> Result<()> {
    let next: Option<String> = sqlx::query_scalar(
        "SELECT to_node FROM campaign_edges WHERE campaign_id=? AND from_node=? AND label='next' LIMIT 1",
    )
    .bind(campaign_id)
    .bind(from)
    .fetch_optional(&st.db)
    .await
    .map_err(err)?;
    match next {
        Some(node) => enter_node(st, campaign_id, lead_id, &node).await,
        None => {
            sqlx::query("UPDATE campaign_leads SET state='done',outcome='completed' WHERE campaign_id=? AND lead_id=?")
                .bind(campaign_id)
                .bind(lead_id)
                .execute(&st.db)
                .await
                .map_err(err)?;
            Ok(())
        }
    }
}

async fn ensure_job(
    st: &AppState,
    campaign_id: &str,
    lead_id: &str,
    node_id: &str,
    account_id: Option<&str>,
) -> Result<(String, String)> {
    let key = format!("{}:{}:{}", campaign_id, lead_id, node_id);
    if let Some(existing) = sqlx::query("SELECT id,payload FROM jobs WHERE idempotency_key=?")
        .bind(&key)
        .fetch_optional(&st.db)
        .await
        .map_err(err)?
    {
        return Ok((existing.get("id"), existing.get("payload")));
    }
    let account = match account_id {
        Some(value) => value.to_string(),
        None => sqlx::query_scalar::<_, String>("SELECT id FROM accounts ORDER BY sent_today LIMIT 1")
            .fetch_optional(&st.db)
            .await
            .map_err(err)?
            .ok_or("No sending account is connected")?,
    };
    let job = id();
    let payload = json!({"campaign_id":campaign_id,"lead_id":lead_id,"account_id":account,"node_id":node_id}).to_string();
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

async fn condition_branch(st: &AppState, lead_id: &str, config: &Value) -> Result<String> {
    let kind = config["kind"].as_str().unwrap_or("replied");
    let email: String = sqlx::query_scalar("SELECT email FROM leads WHERE id=?")
        .bind(lead_id)
        .fetch_one(&st.db)
        .await
        .map_err(err)?;
    let count: i64 = match kind {
        "interested" => sqlx::query_scalar("SELECT count(*) FROM inbox_messages WHERE from_email=? AND intent='interested'")
            .bind(&email)
            .fetch_one(&st.db)
            .await
            .map_err(err)?,
        "replied" => sqlx::query_scalar("SELECT count(*) FROM inbox_messages WHERE from_email=?")
            .bind(&email)
            .fetch_one(&st.db)
            .await
            .map_err(err)?,
        _ => 0,
    };
    Ok(if count > 0 { "yes".to_string() } else { "no".to_string() })
}

async fn apply_action(st: &AppState, lead_id: &str, config: &Value) -> Result<()> {
    match config["kind"].as_str().unwrap_or("notify") {
        "suppress" => {
            let email: String = sqlx::query_scalar("SELECT email FROM leads WHERE id=?")
                .bind(lead_id)
                .fetch_one(&st.db)
                .await
                .map_err(err)?;
            sqlx::query("INSERT OR REPLACE INTO suppressions(email,reason,created_at) VALUES(?,?,?)")
                .bind(&email)
                .bind("graph action")
                .bind(now())
                .execute(&st.db)
                .await
                .map_err(err)?;
            sqlx::query("UPDATE leads SET status='suppressed' WHERE id=?")
                .bind(lead_id)
                .execute(&st.db)
                .await
                .map_err(err)?;
        }
        "tag" => {
            if let Some(tag) = config["tag"].as_str() {
                sqlx::query("UPDATE leads SET list_name=? WHERE id=?")
                    .bind(tag)
                    .bind(lead_id)
                    .execute(&st.db)
                    .await
                    .map_err(err)?;
            }
        }
        "pause" => {
            sqlx::query("UPDATE campaign_leads SET state='paused' WHERE lead_id=?")
                .bind(lead_id)
                .execute(&st.db)
                .await
                .map_err(err)?;
        }
        _ => log(&st.db, "info", "graph_action", lead_id).await,
    }
    Ok(())
}
// Resolve `{{key}}` and `{{key|fallback}}` against a lookup that reads the lead's
// standard columns first, then any CSV/XLSX header preserved in custom_fields.
fn resolve_variables(text: &str, lookup: &dyn Fn(&str) -> Option<String>) -> String {
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
                match lookup(key).filter(|value| !value.is_empty()) {
                    Some(value) => out.push_str(&value),
                    None => out.push_str(fallback.unwrap_or("")),
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

fn render(text: &str, lead: &sqlx::sqlite::SqliteRow) -> String {
    // Every source column is preserved in custom_fields during import, so templates can
    // use {{Any CSV Header}} without a schema change. Standard columns come first.
    let custom = lead
        .try_get::<String, _>("custom_fields")
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
    let lookup = |key: &str| -> Option<String> {
        let standard = match key {
            "first_name" => lead.get::<Option<String>, _>("first_name"),
            "last_name" => lead.get::<Option<String>, _>("last_name"),
            "company" => lead.get::<Option<String>, _>("company"),
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
    };
    resolve_variables(text, &lookup)
}
async fn send_job(st: &AppState, jid: &str, payload: &str) -> Result<()> {
    let p: Value = serde_json::from_str(payload).map_err(err)?;
    let campaign = p["campaign_id"].as_str().ok_or("Missing campaign id")?;
    let lead_id = p["lead_id"].as_str().ok_or("Missing lead id")?;
    let account_id = p["account_id"].as_str().ok_or("Missing account id")?;
    let lead=sqlx::query("SELECT * FROM leads WHERE id=? AND status='active' AND email NOT IN (SELECT email FROM suppressions)").bind(lead_id).fetch_optional(&st.db).await.map_err(err)?.ok_or("Lead is suppressed, inactive, or missing")?;
    let c=sqlx::query("SELECT c.status,c.approved_at,t.subject AS campaign_subject,t.body AS campaign_body FROM campaigns c LEFT JOIN templates t ON t.id=c.template_id WHERE c.id=?").bind(campaign).fetch_optional(&st.db).await.map_err(err)?.ok_or("Campaign not found")?;
    if c.get::<String, _>("status") != "active"
        || c.get::<Option<String>, _>("approved_at").is_none()
    {
        return Err("Campaign is paused, cancelled, or unapproved".into());
    }

    // The email node owns this message: it may name its own template, and it may
    // opt into an LLM-written draft that a human approved.
    let mut personalize = false;
    let mut node_template: Option<String> = None;
    if let Some(node_id) = p["node_id"].as_str() {
        if let Some(row) = sqlx::query("SELECT config_json FROM campaign_nodes WHERE id=?")
            .bind(node_id)
            .fetch_optional(&st.db)
            .await
            .map_err(err)?
        {
            let config: Value =
                serde_json::from_str(&row.get::<String, _>("config_json")).unwrap_or(json!({}));
            personalize = config["personalize"].as_bool().unwrap_or(false);
            node_template = config["template_id"]
                .as_str()
                .filter(|value| !value.trim().is_empty())
                .map(|value| value.to_string());
        }
    }

    let mut draft_id: Option<String> = None;
    let subject_source;
    let body_source;
    if personalize {
        // Never send an unapproved auto-written email: block and flag instead.
        let node = p["node_id"].as_str();
        let draft = sqlx::query("SELECT id,subject,body FROM email_drafts WHERE campaign_id=? AND lead_id=? AND node_id IS ? AND state='approved' ORDER BY approved_at DESC LIMIT 1")
            .bind(campaign)
            .bind(lead_id)
            .bind(node)
            .fetch_optional(&st.db)
            .await
            .map_err(err)?;
        let Some(draft) = draft else {
            sqlx::query("UPDATE leads SET status='needs_attention',updated_at=? WHERE id=?")
                .bind(now())
                .bind(lead_id)
                .execute(&st.db)
                .await
                .map_err(err)?;
            log(&st.db, "warn", "draft_missing", lead_id).await;
            return Err("No approved draft for this lead; send blocked and lead flagged".into());
        };
        draft_id = Some(draft.get::<String, _>("id"));
        subject_source = draft.get::<String, _>("subject");
        body_source = draft.get::<String, _>("body");
    } else if let Some(template_id) = node_template {
        let t = sqlx::query("SELECT subject,body FROM templates WHERE id=?")
            .bind(&template_id)
            .fetch_optional(&st.db)
            .await
            .map_err(err)?
            .ok_or("This email node points at a template that no longer exists")?;
        subject_source = t.get::<String, _>("subject");
        body_source = t.get::<String, _>("body");
    } else {
        subject_source = c
            .get::<Option<String>, _>("campaign_subject")
            .ok_or("Neither this email node nor the campaign has a template")?;
        body_source = c
            .get::<Option<String>, _>("campaign_body")
            .ok_or("Neither this email node nor the campaign has a template")?;
    }
    let a = sqlx::query("SELECT provider,email,daily_limit,sent_today FROM accounts WHERE id=?")
        .bind(account_id)
        .fetch_one(&st.db)
        .await
        .map_err(err)?;
    if a.get::<i64, _>("sent_today") >= a.get::<i64, _>("daily_limit") {
        return Err("Account daily sending limit reached".into());
    }
    let token: Value = serde_json::from_str(
        &vault(&format!("oauth:{}", account_id))?
            .get_password()
            .map_err(|_| "Account credentials unavailable; reconnect required")?,
    )
    .map_err(err)?;
    let access = token["access_token"]
        .as_str()
        .ok_or("Stored access token is invalid")?;
    let to = lead.get::<String, _>("email");
    let subject = render(&subject_source, &lead);
    let body = render(&body_source, &lead);
    // Never send a literal placeholder: block the send and flag the lead for review.
    if subject.contains("{{") || body.contains("{{") {
        sqlx::query("UPDATE leads SET status='needs_attention',updated_at=? WHERE id=?")
            .bind(now())
            .bind(lead_id)
            .execute(&st.db)
            .await
            .map_err(err)?;
        log(&st.db, "warn", "template_variable_missing", lead_id).await;
        return Err("Template has unresolved variables; send blocked and lead flagged".into());
    }
    let provider = a.get::<String, _>("provider");
    let response = if provider == "gmail" {
        let raw=format!("To: {}\r\nFrom: {}\r\nSubject: {}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n{}",to,a.get::<String,_>("email"),subject,body);
        st.http
            .post("https://gmail.googleapis.com/gmail/v1/users/me/messages/send")
            .bearer_auth(access)
            .json(&json!({"raw":URL_SAFE_NO_PAD.encode(raw)}))
            .send()
            .await
            .map_err(err)?
            .error_for_status()
            .map_err(err)?
            .json::<Value>()
            .await
            .map_err(err)?
    } else {
        st.http.post("https://graph.microsoft.com/v1.0/me/sendMail").bearer_auth(access).json(&json!({"message":{"subject":subject,"body":{"contentType":"Text","content":body},"toRecipients":[{"emailAddress":{"address":to}}]}})).send().await.map_err(err)?.error_for_status().map_err(err)?;
        json!({})
    };
    sqlx::query("INSERT INTO send_logs(id,job_id,campaign_id,lead_id,account_id,provider_message_id,subject,body,status,created_at) VALUES(?,?,?,?,?,?,?,?, 'sent',?)").bind(id()).bind(jid).bind(campaign).bind(lead_id).bind(account_id).bind(response["id"].as_str()).bind(&subject).bind(&body).bind(now()).execute(&st.db).await.map_err(err)?;
    if let Some(draft_id) = &draft_id {
        sqlx::query("UPDATE email_drafts SET state='sent',updated_at=? WHERE id=?")
            .bind(now())
            .bind(draft_id)
            .execute(&st.db)
            .await
            .map_err(err)?;
    }
    sqlx::query("UPDATE accounts SET sent_today=sent_today+1,health='healthy',last_health_at=?,updated_at=? WHERE id=?").bind(now()).bind(now()).bind(account_id).execute(&st.db).await.map_err(err)?;
    Ok(())
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
    if has(&["unsubscribe", "opt out", "opt-out", "remove me", "take me off"]) {
        return Some("unsubscribe");
    }
    if has(&["out of office", "automatic reply", "auto-reply", "on leave", "annual leave", "away until"]) {
        return Some("out_of_office");
    }
    if has(&["undeliverable", "delivery status notification", "mail delivery failed", "address not found", "mailbox full", "550 "]) {
        return Some("bounce");
    }
    if has(&["not interested", "no thanks", "no thank you", "pass on this"]) {
        return Some("not_interested");
    }
    if has(&["not now", "reach out later", "next quarter", "circle back", "in a few months"]) {
        return Some("not_now");
    }
    if has(&["wrong person", "not the right person", "speak to", "reach out to", "forwarded your"]) {
        return Some("referral");
    }
    if has(&["interested", "let's chat", "happy to talk", "book a call", "send me more", "sounds good"]) {
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

async fn set_category(db: &SqlitePool, message_id: &str, category: &str, confidence: f64, by: &str) -> Result<()> {
    let intent = if category == "interested" { Some("interested") } else { None };
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
async fn stop_lead_sequence(db: &SqlitePool, email: &str) -> Result<()> {
    let lead: Option<String> = sqlx::query_scalar("SELECT id FROM leads WHERE email=?")
        .bind(email)
        .fetch_optional(db)
        .await
        .map_err(err)?;
    if let Some(lead_id) = lead {
        sqlx::query("UPDATE jobs SET state='cancelled',updated_at=? WHERE state='queued' AND idempotency_key LIKE ?")
            .bind(now())
            .bind(format!("%:{}:%", lead_id))
            .execute(db)
            .await
            .map_err(err)?;
        sqlx::query("UPDATE campaign_leads SET state='paused' WHERE lead_id=? AND state='active' AND (current_node_id IS NULL OR current_node_id NOT IN (SELECT id FROM campaign_nodes WHERE type='classifier'))")
            .bind(&lead_id)
            .execute(db)
            .await
            .map_err(err)?;
        log(db, "info", "sequence_stopped", &lead_id).await;
    }
    Ok(())
}

/// A reply is what moves a lead out of a classifier node, so classifiers are
/// driven by arrivals rather than by the scheduler.
async fn resume_classifiers(st: &AppState, email: &str) {
    let rows = sqlx::query("SELECT cl.campaign_id,cl.lead_id,cl.current_node_id,cl.entered_node_at,cl.account_id FROM campaign_leads cl JOIN campaigns c ON c.id=cl.campaign_id JOIN campaign_nodes n ON n.id=cl.current_node_id WHERE n.type='classifier' AND cl.state='active' AND c.status='active' AND c.approved_at IS NOT NULL AND cl.lead_id=(SELECT id FROM leads WHERE email=?)")
        .bind(email)
        .fetch_all(&st.db)
        .await;
    let Ok(rows) = rows else { return };
    for row in rows {
        let campaign_id: String = row.get("campaign_id");
        let lead_id: String = row.get("lead_id");
        let node_id: Option<String> = row.get("current_node_id");
        let entered_at: Option<String> = row.get("entered_node_at");
        let account_id: Option<String> = row.get("account_id");
        let Some(node_id) = node_id else { continue };
        if let Err(e) = advance_lead(
            st,
            &campaign_id,
            &lead_id,
            &node_id,
            entered_at.as_deref(),
            account_id.as_deref(),
        )
        .await
        {
            log(&st.db, "warn", "classifier_advance", &format!("{lead_id}: {e}")).await;
        }
    }
}

async fn store_message(st: &AppState, account_id: &str, provider_message_id: &str, from: &str, subject: &str, received_at: &str, excerpt: &str) -> Result<usize> {
    let email = extract_email(from);
    let inserted = sqlx::query("INSERT OR IGNORE INTO inbox_messages(id,account_id,provider_message_id,from_email,subject,received_at,raw_excerpt,read_flag) VALUES(?,?,?,?,?,?,?,0)")
        .bind(id())
        .bind(account_id)
        .bind(provider_message_id)
        .bind(&email)
        .bind(subject)
        .bind(received_at)
        .bind(excerpt)
        .execute(&st.db)
        .await
        .map_err(err)?
        .rows_affected();
    if inserted > 0 {
        stop_lead_sequence(&st.db, &email).await?;
        resume_classifiers(st, &email).await;
    }
    Ok(inserted as usize)
}

#[tauri::command]
async fn sync_inbox(state: State<'_, AppState>, account_id: Option<String>) -> Result<usize> {
    let accounts = sqlx::query("SELECT id,provider FROM accounts")
        .fetch_all(&state.db)
        .await
        .map_err(err)?;
    let mut total = 0usize;
    for account in accounts {
        let id: String = account.get("id");
        if let Some(wanted) = &account_id {
            if wanted != &id {
                continue;
            }
        }
        let access = match vault(&format!("oauth:{}", id)).and_then(|entry| entry.get_password().map_err(err)) {
            Ok(token) => serde_json::from_str::<Value>(&token).ok().and_then(|v| v["access_token"].as_str().map(str::to_string)),
            Err(_) => None,
        };
        let Some(access) = access else { continue };
        let provider: String = account.get("provider");
        if provider == "gmail" {
            let list: Value = state
                .http
                .get("https://gmail.googleapis.com/gmail/v1/users/me/messages?q=newer_than:7d&maxResults=25")
                .bearer_auth(&access)
                .send()
                .await
                .map_err(err)?
                .error_for_status()
                .map_err(err)?
                .json()
                .await
                .map_err(err)?;
            for reference in list["messages"].as_array().cloned().unwrap_or_default() {
                let mid = reference["id"].as_str().unwrap_or_default();
                if mid.is_empty() {
                    continue;
                }
                let detail: Value = state
                    .http
                    .get(format!("https://gmail.googleapis.com/gmail/v1/users/me/messages/{}?format=metadata&metadataHeaders=From&metadataHeaders=Subject", mid))
                    .bearer_auth(&access)
                    .send()
                    .await
                    .map_err(err)?
                    .json()
                    .await
                    .map_err(err)?;
                let headers = detail["payload"]["headers"].as_array().cloned().unwrap_or_default();
                let header = |name: &str| {
                    headers
                        .iter()
                        .find(|h| h["name"].as_str().unwrap_or("").eq_ignore_ascii_case(name))
                        .and_then(|h| h["value"].as_str())
                        .unwrap_or("")
                        .to_string()
                };
                let received = detail["internalDate"].as_str().unwrap_or_default().parse::<i64>().unwrap_or(0);
                let received_at = chrono::DateTime::from_timestamp_millis(received)
                    .map(|d| d.to_rfc3339())
                    .unwrap_or_else(now);
                total += store_message(state.inner(), &id, mid, &header("From"), &header("Subject"), &received_at, detail["snippet"].as_str().unwrap_or("")).await?;
            }
        } else {
            let list: Value = state
                .http
                .get("https://graph.microsoft.com/v1.0/me/messages?$top=25&$select=id,subject,from,receivedDateTime,bodyPreview")
                .bearer_auth(&access)
                .send()
                .await
                .map_err(err)?
                .error_for_status()
                .map_err(err)?
                .json()
                .await
                .map_err(err)?;
            for message in list["value"].as_array().cloned().unwrap_or_default() {
                let mid = message["id"].as_str().unwrap_or_default();
                if mid.is_empty() {
                    continue;
                }
                let from = message["from"]["emailAddress"]["address"].as_str().unwrap_or("");
                let received_at = message["receivedDateTime"].as_str().unwrap_or("").to_string();
                total += store_message(
                    state.inner(),
                    &id,
                    mid,
                    from,
                    message["subject"].as_str().unwrap_or(""),
                    &received_at,
                    message["bodyPreview"].as_str().unwrap_or(""),
                )
                .await?;
            }
        }
    }
    Ok(total)
}

/// Classify unmatched replies: cheap rules first, then the local model when asked.
#[tauri::command]
async fn classify_inbox(state: State<'_, AppState>, use_agent: Option<bool>) -> Result<usize> {
    let rows = sqlx::query("SELECT id,subject,raw_excerpt FROM inbox_messages WHERE classified_by IS NULL OR classified_by='rule' ORDER BY received_at DESC LIMIT 50")
        .fetch_all(&state.db)
        .await
        .map_err(err)?;
    let mut classified = 0usize;
    for row in rows {
        let message_id: String = row.get("id");
        let subject = row.get::<Option<String>, _>("subject").unwrap_or_default();
        let excerpt = row.get::<Option<String>, _>("raw_excerpt").unwrap_or_default();
        let text = format!("{} {}", subject, excerpt).to_lowercase();
        if let Some(category) = rule_category(&text) {
            set_category(&state.db, &message_id, category, 0.9, "rule").await?;
            classified += 1;
            continue;
        }
        if use_agent.unwrap_or(false) {
            if let Some((category, confidence)) = classify_with_model(&state, &format!("{} {}", subject, excerpt)).await {
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
    let model = model_for(&st.db, "classifier_model").await;
    let outcome = llm_json(st, &model, None, &prompt, 45).await.ok()?;
    let category = outcome.value["category"].as_str()?.to_string();
    let allowed = ["interested", "question", "not_now", "not_interested", "referral", "out_of_office", "unsubscribe", "bounce"];
    if !allowed.contains(&category.as_str()) {
        return None;
    }
    Some((category, outcome.value["confidence"].as_f64().unwrap_or(0.0)))
}

#[tauri::command]
async fn list_channels(state: State<'_, AppState>) -> Result<Vec<Value>> {
    sqlx::query("SELECT c.id,c.name,c.color,c.sort,(SELECT count(*) FROM inbox_messages m WHERE m.channel_id=c.id AND m.read_flag=0) AS unread,(SELECT count(*) FROM inbox_messages m WHERE m.channel_id=c.id) AS total FROM channels c ORDER BY c.sort")
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
async fn list_inbox(state: State<'_, AppState>, channel_id: Option<String>, unread_only: Option<bool>) -> Result<Vec<Value>> {
    let mut sql = String::from(
        "SELECT m.id,m.account_id,m.from_email,m.subject,m.received_at,m.raw_excerpt,m.category,m.confidence,m.classified_by,m.channel_id,m.read_flag,m.snoozed_until,l.first_name,l.company,l.title FROM inbox_messages m LEFT JOIN leads l ON l.email=m.from_email WHERE 1=1",
    );
    if channel_id.is_some() {
        sql.push_str(" AND m.channel_id=?");
    }
    if unread_only.unwrap_or(false) {
        sql.push_str(" AND m.read_flag=0");
    }
    sql.push_str(" ORDER BY m.received_at DESC LIMIT 100");
    let mut query = sqlx::query(&sql);
    if let Some(channel) = &channel_id {
        query = query.bind(channel);
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
                "lead_name": r.get::<Option<String>,_>("first_name"),
                "company": r.get::<Option<String>,_>("company"),
                "title": r.get::<Option<String>,_>("title"),
            })
        })
        .collect())
}

#[tauri::command]
async fn set_inbox_channel(state: State<'_, AppState>, message_id: String, channel_id: String) -> Result<()> {
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

#[tauri::command]
async fn inbox_thread(state: State<'_, AppState>, message_id: String) -> Result<Value> {
    let message = sqlx::query("SELECT m.id,m.from_email,m.subject,m.received_at,m.raw_excerpt,m.category,m.confidence,m.classified_by,m.channel_id,m.read_flag,l.id AS lead_id,l.first_name,l.company,l.title FROM inbox_messages m LEFT JOIN leads l ON l.email=m.from_email WHERE m.id=?")
        .bind(&message_id)
        .fetch_optional(&state.db)
        .await
        .map_err(err)?
        .ok_or("Message not found")?;
    let email: Option<String> = message.get("from_email");
    let sent = match &email {
        Some(address) => sqlx::query("SELECT s.status,s.created_at,c.name FROM send_logs s LEFT JOIN campaigns c ON c.id=s.campaign_id JOIN leads l ON l.id=s.lead_id WHERE l.email=? ORDER BY s.created_at DESC LIMIT 5")
            .bind(address)
            .fetch_all(&state.db)
            .await
            .map_err(err)?,
        None => Vec::new(),
    };
    Ok(json!({
        "id": message.get::<String,_>("id"),
        "from_email": email,
        "subject": message.get::<Option<String>,_>("subject"),
        "received_at": message.get::<Option<String>,_>("received_at"),
        "raw_excerpt": message.get::<Option<String>,_>("raw_excerpt"),
        "category": message.get::<Option<String>,_>("category"),
        "confidence": message.get::<Option<f64>,_>("confidence"),
        "classified_by": message.get::<Option<String>,_>("classified_by"),
        "channel_id": message.get::<Option<String>,_>("channel_id"),
        "read": message.get::<i64,_>("read_flag") != 0,
        "lead": {"id": message.get::<Option<String>,_>("lead_id"), "name": message.get::<Option<String>,_>("first_name"), "company": message.get::<Option<String>,_>("company"), "title": message.get::<Option<String>,_>("title")},
        "history": sent.iter().map(|r| json!({"status":r.get::<String,_>("status"),"created_at":r.get::<String,_>("created_at"),"campaign":r.get::<Option<String>,_>("name")})).collect::<Vec<_>>()
    }))
}

async fn log(db: &SqlitePool, level: &str, event: &str, detail: &str) {
    let _ =
        sqlx::query("INSERT INTO events(id,level,event_type,detail,created_at) VALUES(?,?,?,?,?)")
            .bind(id())
            .bind(level)
            .bind(event)
            .bind(detail)
            .bind(now())
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
        fn SetWindowPos(hwnd: *mut c_void, after: *mut c_void, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
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
#[cfg(windows)]
fn watch_native_frame(window: &tauri::WebviewWindow) {
    strip_native_frame(window);
    let handle = window.clone();
    window.on_window_event(move |_| strip_native_frame(&handle));
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
        fn SetWindowPos(hwnd: *mut c_void, after: *mut c_void, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
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
        SetWindowPos(hwnd, std::ptr::null_mut(), x, y, width, height, SWP_NOZORDER | SWP_NOACTIVATE);
    }
}

fn main() {
    tracing_subscriber::fmt().with_env_filter("info").init();
    let dir = tauri::path::BaseDirectory::AppData;
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
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
                watch_native_frame(&window);
                fit_to_work_area(&window);
            }
            let path = app
                .path()
                .resolve("maily.sqlite", dir)
                .map_err(|e| std::io::Error::other(e.to_string()))?;
            std::fs::create_dir_all(path.parent().unwrap())?;
            let state = tauri::async_runtime::block_on(async {
                let db = SqlitePoolOptions::new()
                    .max_connections(6)
                    .connect(&format!("sqlite:{}?mode=rwc", path.display()))
                    .await
                    .map_err(|e| std::io::Error::other(e.to_string()))?;
                sqlx::migrate!("./migrations")
                    .run(&db)
                    .await
                    .map_err(|e| std::io::Error::other(e.to_string()))?;
                Ok::<_, std::io::Error>(AppState {
                    db,
                    http: Client::new(),
                    agents: Arc::new(Semaphore::new(2)),
                })
            })?;
            tauri::async_runtime::spawn(scheduler(state.clone()));
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            dashboard,
            dashboard_stats,
            list_leads,
            list_lead_lists,
            upsert_leads,
            suppress_lead,
            save_template,
            seed_templates,
            list_templates,
            save_campaign,
            list_campaigns,
            approve_campaign,
            set_campaign_status,
            save_knowledge,
            delete_knowledge,
            list_knowledge,
            preview_knowledge,
            start_oauth,
            finish_oauth,
            run_agent,
            list_agent_runs,
            list_agents,
            save_agent,
            delete_agent,
            generate_drafts,
            list_drafts,
            approve_draft,
            reject_draft,
            analyze_style,
            save_openrouter_key,
            openrouter_key_status,
            clear_openrouter_key,
            list_openrouter_models,
            test_llm,
            get_settings,
            save_setting,
            test_ollama,
            save_campaign_graph,
            load_campaign_graph,
            validate_campaign_graph,
            preview_path,
            launch_campaign,
            pause_campaign,
            delete_campaign,
            sync_inbox,
            classify_inbox,
            list_channels,
            list_inbox,
            set_inbox_channel,
            mark_inbox_read,
            snooze_inbox,
            inbox_thread
        ])
        .run(tauri::generate_context!())
        .expect("tauri error");
}
