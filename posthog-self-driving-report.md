# PostHog Self-driving Setup Report

**Project:** HAVENHub — Default project (id: 514029)
**Date:** 2026-07-15
**Inbox:** https://us.posthog.com/project/514029/inbox

## Summary

PostHog Self-driving has been configured for HAVENHub. Session Replay, Error Tracking, and Conversations are enabled as signal sources; GitHub Issues and Linear have been connected and will sync their issues into the warehouse. A scout troop of 4 watches the project on a daily schedule. Findings will start appearing in the [Self-driving inbox](https://us.posthog.com/project/514029/inbox) within ~30 minutes.

## AI data processing

Approved (enforced by the wizard's org-level gate before setup started).

## GitHub

**Status:** Already connected (integration id: 185895, org: HAVEN-Free-Clinic, connected 2026-07-15).

## Products enabled

| Product | Status | Notes |
|---|---|---|
| Session Replay | Already enabled | `session_recording_opt_in: true` in project settings; `instrumentation-client.ts` init has no `disable_session_recording` override — client recording is live |
| Error Tracking | Already enabled | `capture_exceptions: true` in `instrumentation-client.ts`; product_intent exists in project |
| Support (Conversations) | Not enabled via API | `products-enable` tool is unavailable in this API version; `conversations_enabled: null` — see follow-ups |

> **Support follow-up:** Conversations is not yet on. Enable it from Project Settings, then connect an inbound channel (email / inbox / Slack) before the `conversations / ticket` responder will receive tickets.

## Signal sources

| source_product | source_type | Action | Notes |
|---|---|---|---|
| `signals_scout` | `cross_source_issue` | Already on (default) | Scout findings reach the inbox with no config row required |
| `error_tracking` | `issue_created` | Enabled | id: 019f677d-605f-76b9-a58f-6e6c2406e234 |
| `error_tracking` | `issue_reopened` | Enabled | id: 019f677d-631e-7aa2-8425-d325048a78a7 |
| `error_tracking` | `issue_spiking` | Enabled | id: 019f677d-6677-73ce-a82c-5dbb54399420 |
| `session_replay` | `session_analysis_cluster` | Enabled | id: 019f677d-6a91-7604-b8ee-1dc5660a4c94; sample_rate: 0.1 |
| `conversations` | `ticket` | Enabled (dormant) | id: 019f677d-6cab-7a88-b0ee-d5eb1acfd6dc; dormant until Conversations product is on and a channel connected |
| `github` | `issue` | Enabled | id: 019f6781-bd76-7e4c-8c55-11ec24896375 |
| `linear` | `issue` | Enabled | id: 019f6781-bf23-7d04-8d54-e0753ff07838 |

## Connected tools

| Tool | Status |
|---|---|
| **GitHub Issues** | Connected by this setup — warehouse source id: `019f6781-9432-0000-8a39-fe35f02bcf9c`, repo: HAVEN-Free-Clinic/HAVENHub, `issues` table syncing (incremental on `updated_at`), first sync started. Additional tables (pull requests, etc.) can be enabled in the UI under Data → Sources. |
| **Linear** | Connected by this setup — warehouse source id: `019f6781-a2e5-0000-f259-b8e0ee87d505`, org: HAVEN Free Clinic, `issues` table syncing (incremental on `updatedAt`), first sync started. Additional tables can be enabled in the UI. |
| **Zendesk** | Not used (not selected) |
| **pganalyze** | Not used (not selected) |

## Scout troop

**4 scouts enabled** (out of 27 total):

| Scout | Status | Reason |
|---|---|---|
| `signals-scout-general` | Enabled | Always on — cross-product correlations and surfaces no specialist covers |
| `signals-scout-feature-flags` | Enabled | HAVENHub uses feature flags extensively for RBAC access gates (`clinic.access`, `recruitment.access`, `recruitment.manage_cycles`, etc.) |
| `signals-scout-data-warehouse` | Enabled | GitHub Issues and Linear warehouse sources were just connected; watches for silent import failures, stalled syncs, and schema drift |
| `signals-scout-recruitment-pipeline` | Enabled (custom) | Watches the application funnel using HAVENHub's custom events — see Custom Scouts section |

**23 scouts disabled:**

| Scout | Reason |
|---|---|
| `signals-scout-error-tracking` | Covered by the native `error_tracking` signal source (issue_created / issue_reopened / issue_spiking) |
| `signals-scout-session-replay` | Covered by the native `session_replay / session_analysis_cluster` signal source |
| `signals-scout-ai-observability` | No `$ai_*` events or LLM SDK in this project |
| `signals-scout-apm` | No OpenTelemetry/distributed tracing instrumented |
| `signals-scout-csp-violations` | No Content-Security-Policy reporting configured |
| `signals-scout-customer-analytics` | No group/accounts analytics |
| `signals-scout-data-pipelines` | No CDP destinations or batch exports |
| `signals-scout-experiments` | No active A/B experiments |
| `signals-scout-health-checks` | Redundant with `general`; can enable if health issues surface |
| `signals-scout-inbox-validation` | Fresh setup — no shipped fixes to validate yet |
| `signals-scout-ingestion-warnings` | Can enable if ingestion errors appear |
| `signals-scout-insight-alerts` | No configured insight alerts yet |
| `signals-scout-logs` | PostHog logs product not confirmed in use |
| `signals-scout-mcp-tool-calls` | No `$mcp_tool_call` telemetry |
| `signals-scout-observability-gaps` | Can enable as event coverage grows |
| `signals-scout-product-analytics` | Profile unavailable (first run); can enable once funnels/retention insights are built |
| `signals-scout-replay-vision` | Replay Vision scanners not configured |
| `signals-scout-revenue-analytics` | No payment SDK or revenue data |
| `signals-scout-skills-store` | Not a priority for this project |
| `signals-scout-anomaly-detection` | Can enable once dashboards/insights are built |
| `signals-scout-surveys` | No surveys in use |
| `signals-scout-web-analytics` | HAVENHub is an authenticated internal tool, not a traffic-driven web property |
| `signals-scout-web-vitals` | Can enable if Core Web Vitals become a priority |

To re-enable any surface-specific scout later: go to the PostHog inbox scout settings, or update the config via the MCP.

## Custom scouts

### `signals-scout-recruitment-pipeline` (created)

**What it watches:** The HAVENHub recruitment funnel, using custom server-side events instrumented across `src/app/apply/` and `src/app/(app)/recruitment/`.

**Event chain tracked:**
- `applicant_magic_link_requested` → `application_draft_saved` → `application_submitted` → `interview_scheduled` → `applicant_accepted` → `recruitment_decisions_released`

**Discriminator — speaks up when any ONE of these is true:**
1. `application_submitted` volume drops >40% day-over-day while `application_draft_saved` is still active (broken submit path)
2. `interview_scheduled / application_submitted` < 0.1 over 7 days with >5 submissions (scoring/routing stall)
3. A `recruitment_decisions_released` event has `skipped_conflicted / (sent + skipped_conflicted)` > 0.25 (conflict-guard blocking too many decisions)
4. Zero `application_submitted` in 7 days while `applicant_magic_link_requested` is active (portal reachable but submissions not landing)

**Why no built-in scout covers it:** The built-in troop has no scout for domain-specific multi-step application funnels. Error tracking covers exceptions; session replay covers UX; the general scout sweeps cross-product surfaces but won't know the domain meaning of these specific events.

**Surfaces considered and ruled out:**
- *Onboarding completion throughput* — no custom events instrumented for onboarding steps; would have relied only on autocaptured page views, which failed the quality bar
- *Email delivery pipeline* — health tracked via DB/cron, no PostHog events captured for email delivery status

**Noise escape hatch:** If this scout becomes noisy, set `emit: false` on its config (`019f6787-6333-7749-934a-4057b314666c`) in PostHog to switch it to dry-run. It will still run and log but file nothing to the inbox.

## Follow-ups

- [ ] **Enable Support (Conversations):** The `products-enable` API tool was unavailable. Enable the Conversations product manually from [Project Settings](https://us.posthog.com/project/514029/settings/environment-integrations), then connect an inbound channel (email / inbox / Slack) so the `conversations / ticket` responder can receive tickets.
- [ ] **Expand recruitment event coverage:** Onboarding steps, compliance milestones (HIPAA verification, EHS training completion), and shift scheduling have no custom PostHog events. Adding `posthog.capture()` calls at key milestones would make the recruitment-pipeline scout and the general scout significantly more powerful.
- [ ] **Enable `signals-scout-product-analytics`** once funnels and retention insights are built in PostHog — it watches saved flows for conversion regressions.
- [ ] **Enable `signals-scout-anomaly-detection`** once dashboards exist — it watches for bursts, drops, and trend breaks.
- [ ] **Grant GitHub App access for HAVEN-website repo** if you want Self-driving to also research issues in that codebase (currently only HAVENHub is accessible).
- [ ] **Review GitHub Issues and Linear table coverage** — only the `issues` table is syncing for both. Additional tables (pull requests, Linear cycles, etc.) can be enabled in the UI under [Data Sources](https://us.posthog.com/project/514029/data-management/sources).

## What happens next

The scout coordinator picks up fresh configs within ~30 minutes and the first runs fire. Findings cluster into reports in your [inbox](https://us.posthog.com/project/514029/inbox). Immediately actionable ones (error spikes, feature flag anomalies, warehouse sync failures) can go straight to coding tasks. The recruitment-pipeline scout will be quiet until application events start flowing, then will baseline itself automatically on the first few runs.
