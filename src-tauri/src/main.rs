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
        if !["start", "email", "delay", "condition", "action", "end"].contains(&n.node_type.as_str()) {
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
        let label = if ["next", "yes", "no"].contains(&e.label.as_str()) {
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
    let start: String =
        sqlx::query_scalar("SELECT id FROM campaign_nodes WHERE campaign_id=? AND type='start' LIMIT 1")
            .bind(&campaign_id)
            .fetch_one(&state.db)
            .await
            .map_err(err)?;
    let enrolled = sqlx::query(
        "INSERT OR IGNORE INTO campaign_leads(campaign_id,lead_id,state,current_node_id,entered_node_at) SELECT ?, id, 'active', ?, ? FROM leads WHERE status='active' AND email NOT IN (SELECT email FROM suppressions)",
    )
    .bind(&campaign_id)
    .bind(&start)
    .bind(now())
    .execute(&state.db)
    .await
    .map_err(err)?
    .rows_affected();
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
    let starts: Vec<&(String, String)> = nodes.iter().filter(|(_, t)| t == "start").collect();
    if starts.is_empty() {
        issues.push(("Graph has no Start node".to_string(), None));
    } else if starts.len() > 1 {
        issues.push(("Graph has more than one Start node".to_string(), None));
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
    let leads = sqlx::query("SELECT cl.campaign_id, cl.lead_id, cl.current_node_id, cl.entered_node_at, cl.account_id FROM campaign_leads cl JOIN campaigns c ON c.id=cl.campaign_id WHERE cl.state='active' AND c.status='active' AND c.approved_at IS NOT NULL AND cl.current_node_id IS NOT NULL LIMIT 12")
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
    let payload = json!({"campaign_id":campaign_id,"lead_id":lead_id,"account_id":account}).to_string();
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
        sqlx::query("UPDATE campaign_leads SET state='paused' WHERE lead_id=? AND state='active'")
            .bind(&lead_id)
            .execute(db)
            .await
            .map_err(err)?;
        log(db, "info", "sequence_stopped", &lead_id).await;
    }
    Ok(())
}

async fn store_message(db: &SqlitePool, account_id: &str, provider_message_id: &str, from: &str, subject: &str, received_at: &str, excerpt: &str) -> Result<usize> {
    let email = extract_email(from);
    let inserted = sqlx::query("INSERT OR IGNORE INTO inbox_messages(id,account_id,provider_message_id,from_email,subject,received_at,raw_excerpt,read_flag) VALUES(?,?,?,?,?,?,?,0)")
        .bind(id())
        .bind(account_id)
        .bind(provider_message_id)
        .bind(&email)
        .bind(subject)
        .bind(received_at)
        .bind(excerpt)
        .execute(db)
        .await
        .map_err(err)?
        .rows_affected();
    if inserted > 0 {
        stop_lead_sequence(db, &email).await?;
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
                total += store_message(&state.db, &id, mid, &header("From"), &header("Subject"), &received_at, detail["snippet"].as_str().unwrap_or("")).await?;
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
                    &state.db,
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
    let body: Value = st
        .http
        .post("http://127.0.0.1:11434/api/generate")
        .json(&json!({"model":"llama3.2","prompt":prompt,"stream":false,"format":"json"}))
        .timeout(std::time::Duration::from_secs(45))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()?;
    let parsed: Value = serde_json::from_str(body["response"].as_str()?).ok()?;
    let category = parsed["category"].as_str()?.to_string();
    let allowed = ["interested", "question", "not_now", "not_interested", "referral", "out_of_office", "unsubscribe", "bounce"];
    if !allowed.contains(&category.as_str()) {
        return None;
    }
    Some((category, parsed["confidence"].as_f64().unwrap_or(0.0)))
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
            save_campaign_graph,
            load_campaign_graph,
            validate_campaign_graph,
            preview_path,
            launch_campaign,
            pause_campaign,
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
