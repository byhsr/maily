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
    category: String,
    title: String,
    content: String,
    approved: bool,
}
#[derive(Deserialize)]
struct AgentInput {
    kind: String,
    model: String,
    input: Value,
    timeout_seconds: Option<i64>,
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
#[tauri::command]
async fn save_knowledge(state: State<'_, AppState>, input: KnowledgeInput) -> Result<String> {
    let x = id();
    let t = now();
    sqlx::query("INSERT INTO knowledge(id,category,title,content,approved,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").bind(&x).bind(input.category).bind(input.title).bind(input.content).bind(input.approved as i64).bind(&t).bind(&t).execute(&state.db).await.map_err(err)?;
    Ok(x)
}
#[tauri::command]
async fn list_knowledge(state: State<'_, AppState>) -> Result<Vec<Value>> {
    sqlx::query("SELECT id,category,title,content,approved FROM knowledge ORDER BY updated_at DESC").fetch_all(&state.db).await.map_err(err).map(|rs|rs.iter().map(|r|json!({"id":r.get::<String,_>("id"),"category":r.get::<String,_>("category"),"title":r.get::<String,_>("title"),"content":r.get::<String,_>("content"),"approved":r.get::<i64,_>("approved")!=0})).collect())
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

#[tauri::command]
async fn run_agent(state: State<'_, AppState>, input: AgentInput) -> Result<String> {
    if ![
        "research",
        "qualify",
        "draft",
        "classify_reply",
        "followup_decision",
    ]
    .contains(&input.kind.as_str())
    {
        return Err("Unsupported agent task".into());
    }
    let x = id();
    let timeout = input.timeout_seconds.unwrap_or(90).clamp(10, 300);
    sqlx::query("INSERT INTO agent_runs(id,kind,state,model,input_json,timeout_seconds,created_at) VALUES(?,?, 'queued',?,?,?,?)").bind(&x).bind(&input.kind).bind(&input.model).bind(input.input.to_string()).bind(timeout).bind(now()).execute(&state.db).await.map_err(err)?;
    let st = state.inner().clone();
    let job_id = x.clone();
    tokio::spawn(async move {
        let _permit = st.agents.acquire().await;
        let _ = execute_agent(&st, &job_id).await;
    });
    Ok(x)
}
#[tauri::command]
async fn list_agent_runs(state: State<'_, AppState>) -> Result<Vec<Value>> {
    sqlx::query("SELECT id,kind,state,model,input_json,output_json,error,created_at,finished_at FROM agent_runs ORDER BY created_at DESC LIMIT 50").fetch_all(&state.db).await.map_err(err).map(|rs|rs.iter().map(|r|json!({"id":r.get::<String,_>("id"),"kind":r.get::<String,_>("kind"),"state":r.get::<String,_>("state"),"model":r.get::<String,_>("model"),"input":serde_json::from_str::<Value>(&r.get::<String,_>("input_json")).unwrap_or(json!({})),"output":r.get::<Option<String>,_>("output_json").and_then(|s|serde_json::from_str::<Value>(&s).ok()),"error":r.get::<Option<String>,_>("error"),"created_at":r.get::<String,_>("created_at"),"finished_at":r.get::<Option<String>,_>("finished_at")})).collect())
}
async fn execute_agent(st: &AppState, run_id: &str) -> Result<()> {
    let r = sqlx::query("SELECT kind,model,input_json,timeout_seconds FROM agent_runs WHERE id=?")
        .bind(run_id)
        .fetch_one(&st.db)
        .await
        .map_err(err)?;
    sqlx::query("UPDATE agent_runs SET state='running' WHERE id=?")
        .bind(run_id)
        .execute(&st.db)
        .await
        .map_err(err)?;
    let prompt=format!("You are Maily's {} agent. Return strict JSON only. Use only supplied facts; for research include source URLs and say unknown when evidence is missing. Input: {}",r.get::<String,_>("kind"),r.get::<String,_>("input_json"));
    let model = r.get::<String, _>("model");
    let response = if model.starts_with("ollama:") {
        st.http.post("http://127.0.0.1:11434/api/generate").json(&json!({"model":model.trim_start_matches("ollama:"),"prompt":prompt,"stream":false,"format":"json"})).timeout(std::time::Duration::from_secs(r.get::<i64,_>("timeout_seconds") as u64)).send().await.map_err(err)?.error_for_status().map_err(err)?.json::<Value>().await.map_err(err)?["response"].clone()
    } else {
        let key = vault("openrouter_api_key")?.get_password().map_err(|_| {
            "OpenRouter API key has not been saved in this device's credential vault"
        })?;
        st.http.post("https://openrouter.ai/api/v1/chat/completions").bearer_auth(key).json(&json!({"model":model,"messages":[{"role":"user","content":prompt}],"response_format":{"type":"json_object"}})).timeout(std::time::Duration::from_secs(r.get::<i64,_>("timeout_seconds") as u64)).send().await.map_err(err)?.error_for_status().map_err(err)?.json::<Value>().await.map_err(err)?["choices"][0]["message"]["content"].clone()
    };
    let parsed = match response {
        Value::String(s) => {
            serde_json::from_str::<Value>(&s).map_err(|_| "Model did not return valid JSON")?
        }
        v => v,
    };
    sqlx::query("UPDATE agent_runs SET state='completed',output_json=?,finished_at=? WHERE id=?")
        .bind(parsed.to_string())
        .bind(now())
        .bind(run_id)
        .execute(&st.db)
        .await
        .map_err(err)?;
    Ok(())
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

#[derive(Deserialize)]
struct QueueSend {
    campaign_id: String,
    lead_id: String,
    account_id: String,
    run_at: Option<String>,
}
#[tauri::command]
async fn queue_send(state: State<'_, AppState>, input: QueueSend) -> Result<String> {
    let c = sqlx::query("SELECT status,mode,approved_at FROM campaigns WHERE id=?")
        .bind(&input.campaign_id)
        .fetch_optional(&state.db)
        .await
        .map_err(err)?
        .ok_or("Campaign not found")?;
    if c.get::<String, _>("status") != "active"
        || c.get::<String, _>("mode") != "autonomous"
        || c.get::<Option<String>, _>("approved_at").is_none()
    {
        return Err("Campaign must be approved and active before a send can be queued".into());
    }
    let job = id();
    let t = now();
    sqlx::query("INSERT INTO jobs(id,kind,run_at,idempotency_key,payload,created_at,updated_at) VALUES(?,'send',?,?,?,?,?)").bind(&job).bind(input.run_at.unwrap_or_else(now)).bind(format!("{}:{}:{}",input.campaign_id,input.lead_id,"initial")).bind(json!({"campaign_id":input.campaign_id,"lead_id":input.lead_id,"account_id":input.account_id}).to_string()).bind(&t).bind(&t).execute(&state.db).await.map_err(err)?;
    Ok(job)
}
async fn process_due(st: &AppState) -> Result<()> {
    let rows=sqlx::query("SELECT id,payload,attempts,max_attempts FROM jobs WHERE state='queued' AND run_at<=? ORDER BY run_at LIMIT 8").bind(now()).fetch_all(&st.db).await.map_err(err)?;
    for row in rows {
        let jid = row.get::<String, _>("id");
        let claimed=sqlx::query("UPDATE jobs SET state='running',locked_at=?,updated_at=? WHERE id=? AND state='queued'").bind(now()).bind(now()).bind(&jid).execute(&st.db).await.map_err(err)?.rows_affected();
        if claimed == 0 {
            continue;
        }
        let result = send_job(st, &jid, &row.get::<String, _>("payload")).await;
        match result {
            Ok(()) => {
                sqlx::query("UPDATE jobs SET state='completed',updated_at=? WHERE id=?")
                    .bind(now())
                    .bind(&jid)
                    .execute(&st.db)
                    .await
                    .map_err(err)?;
            }
            Err(e) => {
                let attempts = row.get::<i64, _>("attempts") + 1;
                let terminal = attempts >= row.get::<i64, _>("max_attempts");
                let next =
                    (Utc::now() + Duration::minutes(2_i64.pow(attempts as u32))).to_rfc3339();
                sqlx::query(
                    "UPDATE jobs SET state=?,attempts=?,run_at=?,error=?,updated_at=? WHERE id=?",
                )
                .bind(if terminal { "failed" } else { "queued" })
                .bind(attempts)
                .bind(next)
                .bind(&e)
                .bind(now())
                .bind(&jid)
                .execute(&st.db)
                .await
                .map_err(err)?;
            }
        }
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
    let c=sqlx::query("SELECT c.status,c.approved_at,t.subject,t.body FROM campaigns c JOIN templates t ON t.id=c.template_id WHERE c.id=?").bind(campaign).fetch_one(&st.db).await.map_err(err)?;
    if c.get::<String, _>("status") != "active"
        || c.get::<Option<String>, _>("approved_at").is_none()
    {
        return Err("Campaign is paused, cancelled, or unapproved".into());
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
    let subject = render(&c.get::<String, _>("subject"), &lead);
    let body = render(&c.get::<String, _>("body"), &lead);
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
    sqlx::query("INSERT INTO send_logs(id,job_id,campaign_id,lead_id,account_id,provider_message_id,status,created_at) VALUES(?,?,?,?,?,?, 'sent',?)").bind(id()).bind(jid).bind(campaign).bind(lead_id).bind(account_id).bind(response["id"].as_str()).bind(now()).execute(&st.db).await.map_err(err)?;
    sqlx::query("UPDATE accounts SET sent_today=sent_today+1,health='healthy',last_health_at=?,updated_at=? WHERE id=?").bind(now()).bind(now()).bind(account_id).execute(&st.db).await.map_err(err)?;
    Ok(())
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
fn main() {
    tracing_subscriber::fmt().with_env_filter("info").init();
    let dir = tauri::path::BaseDirectory::AppData;
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(move |app| {
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
            list_knowledge,
            start_oauth,
            finish_oauth,
            run_agent,
            list_agent_runs,
            save_openrouter_key,
            get_settings,
            save_setting,
            test_ollama,
            queue_send
        ])
        .run(tauri::generate_context!())
        .expect("tauri error");
}
