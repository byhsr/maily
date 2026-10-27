# Maily Build Guide (for the coding agent)

Read this whole file before changing anything. Follow it exactly. If something here conflicts with what you see in the repo, stop and tell me instead of guessing.

Contents: 1. Architecture and rules, 2. Design system, 3. Campaign canvas, 4. Templates and sequences, 5. Inbox and dashboard, 6. Suggested order of work.

---

# 1. Architecture and rules

Maily is a local-first cold-email desktop app. Rust owns data, secrets and sending. React is a thin UI that calls `invoke`.

## Architecture (fixed facts)

- Tauri v2. Rust backend: `src-tauri/src/main.rs`. Webview UI: React, talks to Rust only via `invoke`.
- Live UI: `src/reimagined.tsx` (rendered by `src/main.tsx`). The old `<App/>`, Dashboard and LeadsView in `main.tsx` are dead code. Do not edit or revive them.
- Helpers: `src/logic.ts` (+ Vitest tests). Styles: `src/styles.css` (Tailwind import + hand-written classes). Theme via `data-theme="dark|light"` on `<html>`, stored in `localStorage.mailyTheme`.
- DB: SQLite `maily.sqlite` in the OS app-data dir. Migrations in `src-tauri/migrations/000N_*.sql`.
- Scheduler ticks every 20s: `process_due` claims queued jobs, `send_job` sends (Gmail raw MIME or Microsoft Graph) with idempotency keys, retry backoff, daily limits and suppression checks.
- OAuth tokens live in the OS keyring (`com.maily.desktop`), never SQLite.
- Agents: `run_agent` queues, `execute_agent` calls Ollama (`ollama:*`) or OpenRouter.

## Rules for every change

- New screen: add to the `items` array and the render switch in `reimagined.tsx`.
- New backend action: `#[tauri::command]` in `main.rs`, register in `generate_handler![]`, call with `api("name", {...})`.
- Schema change: new migration file. Never edit an applied one.
- Never store secrets in SQLite or localStorage.
- Never bypass idempotency, suppression or daily-limit checks in the send path.
- No hardcoded colors; use theme tokens.
- No `!important`, no inline styles for layout. Fix with a targeted class.
- Buttons: Tailwind preflight sets `svg { display:block }`, so all buttons must be `inline-flex` rows with the svg as `flex: none`. Check every screen and drawer for wrapping icons.

## Repo cleanup (do first)

`reimagined.tsx` is a few giant one-liners. Split it without changing behavior:

```
src/
  app/        Shell.tsx, Rail.tsx, Topbar.tsx, router (page state)
  pages/      Home.tsx, Campaigns.tsx, Leads.tsx, Templates.tsx, Agents.tsx, Inbox.tsx
  drawers/    CampaignDrawer.tsx, TemplateDrawer.tsx, LeadDrawer.tsx, AgentDrawer.tsx, SettingsDrawer.tsx
  canvas/     Canvas.tsx, nodes/*.tsx, edges.tsx, inspector.tsx
  ui/         Button, Card, Badge, Input, Modal, Tabs, EmptyState, Stat
  lib/        api.ts (typed invoke wrappers), logic.ts, types.ts
  styles/     tokens.css, base.css, components.css
```

Steps: (1) extract `ui/` primitives, (2) move each page, (3) move each drawer, (4) type `api.ts`, (5) delete dead legacy code and its unused CSS classes. Verify after each step, one commit per step.

## Verify before finishing

```
npm run check && npm run test && npm run build && cargo check
```

If a visual check isn't possible, say so and list which screens I should look at.

---

# 2. Design system

## Reference direction (from the two screenshots)

- **Ledgerix-style dashboard**: light, airy canvas. One huge hero number (e.g. total sent / replies), big spacing, thin line/bar charts, small rounded stat cards in a row below, a floating "Ask anything" command bar at the bottom, small pill nav icons at top.
- **Floe-style workflows page**: left sidebar (Home, My Workflows, Templates, Tools, Knowledge Base, Marketplace, More), Favourites list with star, top filter chips (Status, Integrations, Date, Tags). Pastel **folder cards** for groups, then a grid of **workflow cards** with gradient header image, status dot ("Active"), "1 day ago", and tiny avatar/integration icons.

Map these to Maily: Workflows -> Campaigns, Folders -> Channels/Categories, Integrations -> Gmail/Outlook accounts, Favourites -> pinned campaigns.

## Principles

- Calm, lots of whitespace, big numbers, small muted labels. One accent color (current lime) used sparingly for primary actions and "active".
- Rounded corners (12-20px cards, full pill for chips/buttons). Soft 1px borders, almost no shadows.
- Pastel tints for categories (blue, peach, mint, lilac). Same tints in dark mode but darker/desaturated.
- Type: one sans (Inter or Geist). Hero number 56-72px, tight tracking. Labels 11-12px uppercase muted. Body 14px.
- Every screen: topbar (title + filters + primary action), content, optional right drawer. Drawers, not page navigations, for editing.
- Empty states always have an illustration-free message + one primary button.

## Tokens (put in `styles/tokens.css`)

```css
:root[data-theme="light"] {
  --bg:#f6f6f4; --surface:#fff; --surface-2:#f0f0ee; --line:#e7e7e3;
  --ink:#111; --ink-2:#5b5b57; --ink-3:#9a9a94;
  --accent:#c6f432; --accent-ink:#111;
  --tint-blue:#e3ecfb; --tint-peach:#fbe9dc; --tint-mint:#dff5e8; --tint-lilac:#ece6fb;
  --ok:#1f9d55; --warn:#d98a00; --bad:#d64545;
  --r-card:16px; --r-pill:999px;
}
:root[data-theme="dark"] {
  --bg:#0e0e0d; --surface:#171716; --surface-2:#1f1f1d; --line:#2a2a27;
  --ink:#f4f4f1; --ink-2:#a8a8a2; --ink-3:#6d6d68;
  --accent:#c6f432; --accent-ink:#111;
  --tint-blue:#1a2536; --tint-peach:#2e2218; --tint-mint:#16291f; --tint-lilac:#241d33;
}
```

## Components to build (in `ui/`)

- `Button` (primary/ghost/icon): `inline-flex`, `gap`, svg `flex:none`.
- `Stat` (label, value, delta, sparkline), `HeroNumber`.
- `FolderCard` (tinted, count, avatars) for channels.
- `CampaignCard` (gradient header, status dot, last-run, account icons, reply rate).
- `FilterChip` row (Status, Account, Date, Tag).
- `Sidebar` with Favourites.
- `CommandBar` (floating, bottom center): search + quick actions.
- `Badge` for lead/reply status.

## Dashboard layout

1. Hero: total replies this period (huge), with range toggle (Week/Month/Year).
2. Wide line chart: sent vs opened vs replied, hover tooltip chip.
3. Row of 4 cards: Sent, Reply rate, Positive replies, Bounced. Each with sparkline.
4. Below: "Needs attention" (replies waiting for action) and "Active campaigns" cards.

---

# 3. Campaign canvas

Replace the linear step list with a canvas. Library: **@xyflow/react** (React Flow). Pan/zoom, drag nodes, connect handles, minimap.

## Mental model

A campaign is a directed graph. A lead enters at **Start** and moves node to node. The scheduler evaluates the lead's current node every tick.

## Node types

| Node | Purpose | Config |
|---|---|---|
| Start | Entry. Source: lead list/segment | list id, daily limit, send window |
| Email | Send a template | template id, subject, variant A/B |
| Delay | Wait | amount + unit (min/hours/days), business-days only toggle |
| Condition | Branch on an event | `replied`, `opened`, `clicked`, `bounced`, reply-sentiment |
| Action | Do something | tag lead, move to channel, notify, pause, add to suppression, webhook |
| End | Exit with outcome | `completed`, `replied`, `unsubscribed` |

## Standard flow (ship as the default template)

```
Start -> Email 1 -> Delay 3d -> Condition: replied?
   yes -> Action: move to channel by sentiment -> End(replied)
   no  -> Email 2 (follow-up) -> Delay 4d -> Condition: replied?
            yes -> Action -> End(replied)
            no  -> Email 3 (breakup) -> Delay 5d -> End(completed)
```

Rule: a reply at ANY point must stop all pending jobs for that lead immediately (cancel queued `jobs` rows), before any further send.

## Edges

Labeled handles on Condition: `Yes` (green) / `No` (grey). Delay shows the wait on the edge label. Invalid graphs (no Start, cycles without delay, dangling Email) show a red badge on the node and block "Launch".

## Storage (new migration `000N_campaign_graph.sql`)

- `campaign_nodes(id, campaign_id, type, config_json, x, y)`
- `campaign_edges(id, campaign_id, from_node, to_node, label)` label in (`next`,`yes`,`no`)
- `campaign_leads` gets `current_node_id`, `entered_node_at`, `state` (active/paused/done), `outcome`
- Keep old `sequence_steps` readable; write a one-time conversion: each step -> Email node, each step delay -> Delay node, chained by `next` edges.

## Backend commands

`save_campaign_graph`, `load_campaign_graph`, `validate_campaign_graph`, `launch_campaign`, `pause_campaign`, `preview_path(lead_id)` (shows which nodes a lead will hit).

## Scheduler changes

`process_due` per lead: read `current_node_id` -> execute node -> pick the outgoing edge -> set next node + `entered_node_at`. Delay node: skip until `entered_node_at + wait`. Email node: reuse `send_job` (idempotency key = `campaign_id:lead_id:node_id`). Condition: query `events` / `inbox_messages`.

## UI

- Left palette (drag node types in), center canvas, right inspector for the selected node (template picker, delay inputs, condition type).
- Toolbar: Validate, Preview as lead, Launch/Pause, auto-layout.
- Live mode: after launch, each node shows a count badge of leads currently inside, and edges show pass-through counts.

---

# 4. Templates and sequences

## Template anatomy

- `name`, `purpose` (first touch / follow-up / breakup / reply), `subject`, `body`, `variables`, `variants` (A/B).
- Variables use `{{first_name}}`, `{{company}}`, `{{signal}}`, `{{sender_name}}`. Rendering goes through `renderVariables` in `logic.ts`. Missing variable -> block send and flag the lead; never send a literal `{{...}}`.
- Provide a fallback syntax: `{{first_name|there}}`.
- Plain text first. No images, minimal links (deliverability).

## Sequence best practice

| Step | Timing | Job |
|---|---|---|
| Email 1 | day 0 | One specific observation + one simple question. 50-90 words. |
| Follow-up 1 | +3 days | Reply in the same thread ("Re:"), add one new piece of value. 30-60 words. |
| Follow-up 2 | +4 days | Different angle or short proof point. |
| Breakup | +5 days | Polite close, easy opt-out. 2-3 lines. |

- Follow-ups send in the same thread (keep `In-Reply-To`/`References` headers, same subject).
- Send inside the lead's local business hours; jitter send time by a few minutes.
- Always include an opt-out line; honor suppressions instantly.
- Stop the sequence on any reply, bounce, or unsubscribe.

## Template library to seed

Ship starter templates per purpose: first touch (3 styles), follow-up (3), breakup (2), reply-to-positive (meeting ask), reply-to-question, reply-to-"not now" (reschedule in 60 days).

## Template editor UI

Split view: editor left, live preview right with a lead picker. Variable chips insert at cursor. Show a spam-risk checklist (length, links, caps, missing opt-out).

---

# 5. Inbox and dashboard

## Goal

Every reply lands in one inbox, auto-sorted into **channels** (categories) so nothing is missed. Mirrors the Floe "folders" idea.

## Default channels

Interested, Question, Not now, Not interested, Wrong person/referral, Out of office, Unsubscribe, Bounce, Needs review.

## Pipeline (on sync of `inbox_messages`)

1. Match message to lead + campaign via thread id / headers.
2. Stop that lead's pending jobs (see campaign-canvas.md).
3. Classify: cheap rules first (OOO, unsubscribe, bounce keywords), then the agent (`execute_agent`, Ollama or OpenRouter) returns `{category, confidence, summary}`. Confidence < 0.7 -> `Needs review`.
4. Store `category`, `confidence`, `classified_by` (rule/agent/user). User corrections override and are kept.
5. Fire the Condition/Action nodes (e.g., Interested -> notify + tag + move to channel).

Schema: add `category`, `confidence`, `classified_by`, `channel_id`, `read`, `snoozed_until` to `inbox_messages`; new table `channels(id, name, color, sort, is_system)`.

## Inbox UI

- Left: channel folder cards or list with unread counts (tinted pastel cards, like Floe folders).
- Middle: message list (lead, company, snippet, campaign, time) with filter chips.
- Right: thread view + lead card + quick actions: Reply (template picker), Move channel, Snooze, Mark done, Add to suppression.
- Keyboard: j/k move, e done, 1-9 move to channel.
- Bulk select and move.

## Dashboard data

Metrics come from `events` and `send_logs`: sent, delivered, opened, replied, positive replies, bounced, unsubscribed. Group by day, campaign, account. Reply rate = replied / delivered. Positive rate = Interested / replied. Show deltas vs previous period. Hero number = replies in range.

---

# 6. Suggested order of work

1. Repo cleanup: extract `ui/` primitives, then pages, then drawers, then typed `api.ts`. Delete dead legacy code and unused CSS. Verify after each step.
2. Apply the design tokens and rebuild the shell (sidebar with Favourites, topbar with filter chips, command bar).
3. Rebuild the dashboard (hero number, chart, stat cards).
4. Templates editor with variables, preview, and the starter library.
5. Campaign graph: migration, backend commands, scheduler changes, then the canvas UI.
6. Inbox: schema changes, classification pipeline, channels UI.

Do one step at a time. After each step run `npm run check && npm run test && npm run build && cargo check`, then report what changed and what you could not verify visually.