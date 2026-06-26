# Changelog

All notable changes to HAVEN Hub are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-06-12

Initial public release. HAVEN Hub is the volunteer and clinic operations
platform for the HAVEN Free Clinic, covering the full volunteer lifecycle:
recruitment, onboarding, scheduling, compliance, training, and day-to-day
operations, with role-based access throughout.

### Added

#### Authentication and access control
- Microsoft Entra ID (Yale tenant) single sign-on with automatic matching of a sign-in to an existing person record.
- Developer and demo credential login for non-production and demo environments, gated by a `DEMO_MODE` toggle.
- Role-based access control with permissions granted at global, term, department, and person scope.
- Session management with JWT sessions and inactivity handling.
- Audit logging across the platform, capturing actor, action, affected entity, and before/after snapshots.
- GitBook documentation gateway so signed-in users can reach embedded docs with their session context.

#### Home and navigation
- Personalized home dashboard with a greeting, next-shift hero, clearance and compliance status, quick actions, and module tiles.
- Permission-driven navigation that shows only the modules a person can access, with active and coming-soon states.
- This-week clinic Teams channel link surfaced on the home dashboard.

#### Recruitment and applications
- Recruitment cycles for volunteer and director tracks, with a draft, open, closed, and archived lifecycle.
- Dynamic application form builder with conditional sections, department choices, and validation for new and renewal applicants.
- Public application portal at `/apply/[slug]` with cycle eligibility checks.
- Applicant tracking with per-cycle email deduplication and department preferences.
- Interview management: panelist assignment, scheduling with meeting links, independent panelist recommendations, and accept, reject, or waitlist decisions.
- A personal "My Interviews" view of panel assignments and evaluation status.
- Acceptance flow with per-department approval and acceptance emails.

#### Onboarding and clearance gate
- Token-based onboarding contract at `/onboard/[token]` with smart prefilling, signature acknowledgments, HIPAA certificate upload, and Epic provisioning flags.
- Promotion of a submitted contract into a full person record.
- Blocking "Get started" clearance gate at `/get-started` that walks new volunteers through profile, HIPAA, and training steps before opening the rest of the app.

#### Volunteer training and clearance
- Term-linked training requirements tied to recruitment cycles.
- Completion by live attendance or by quiz, with configurable pass percentage and attempt limits.
- Director attendance recording, training locks, and administrative reset.
- Volunteer feedback capture (subcommittee interest, shift availability, general feedback).
- A redesigned Volunteer Training clearance flow.

#### Scheduling
- Personal schedule view with upcoming shifts, availability self-update, and swap or drop requests.
- Full department schedule view with shift roles and med-team tags (triage, walk-in, continuity care, remote).
- Director schedule builder with capacity math, assignment, and availability validation.
- Attendings roster for procedure-qualified attending physicians.
- Three-tier availability model: application baseline, volunteer self-update, and director override, with structured clinic-date selection.
- Shift roles for director, volunteer, and shadow, with med-team designations.
- Swap and drop request workflow with approval gates and dual validation.
- Capacity planning with per-clinic patient counts and headcount thresholds.

#### My Info and profile
- Contact and profile management, including department memberships, Spanish fluency, and licensed RN status.
- Active term membership view with the ability to withdraw from a term.
- HIPAA certificate upload with completion-date entry, size limits, and stored metadata.
- In-app HIPAA certificate viewer with PDF preview.
- Clearance section redesigned into a status card.

#### Volunteer management and operations
- Department compliance roster with HIPAA and training status, filtering, sorting, and quick actions.
- Master roster across all terms and departments.
- HIPAA compliance reminders on a weekly cadence with per-person deduplication and director escalation after repeated reminders.
- Offboarding workflow to flag volunteers at term end and execute bulk offboarding with an audit trail.
- Epic access requests (new, modify, renew) with YNHH ticket linking and status tracking.
- Disciplinary action recording with category, severity flags, follow-up actions, and issuer audit trail.

#### Learning (SCORM training)
- SCORM 1.2 package upload and management, including multi-SCO manifests.
- Course assignment to specific departments or organization-wide, with auto-enrollment.
- Embedded in-hub SCORM player with progress, score, and resume support.
- Learner course list with status badges and an admin completion dashboard.

#### Admin and configuration
- People directory with create, edit, and status management.
- Terms and academic calendar management, including clinic dates and a single active term.
- Departments management with delegation so a manager department can oversee managed departments.
- Roles and permissions management with role assignment by scope.
- Audit log viewer with search by actor, action, entity, and date.
- Sync health view for Airtable mirror status and outbox health.
- Fully admin-configurable settings: branding (app name, color, logo, favicon), operational settings, and feature toggles.
- ITCM Epic request generator that produces service-request PDFs, Excel spreadsheets, and pre-filled email drafts, with an Epic request tracker and ticket aging in business days.

#### Email system
- Editable email templates with code-default fallbacks, overridable by key.
- Email campaigns with audience targeting by person field, scheduling (immediate, one-time, recurring), and per-run recipient deduplication.
- Transactional email for recruitment, Epic, and compliance reminders.
- Live email delivery through delegated Microsoft Graph OAuth, sending from an admin-connected mailbox, with a console-logging transport for development.
- Queue-based delivery drained by a dedicated per-minute email job that also dispatches due campaigns.

#### Compliance engine
- HIPAA compliance computation against a twelve-month window, with compliant, expiring-soon, expired, unknown-date, and no-certificate states.
- Overall clearance combining HIPAA, training, and disciplinary status, surfaced across home, My Info, and training.
- Nightly recomputation of compliance across all people.

#### Airtable integration
- One-way import of people, rosters, schedules, and HIPAA certificates from the HAVEN management base.
- Outbox-based mirroring of compliance status back to Airtable with retry and heartbeat monitoring.
- Dry-run import previews and nightly reconciliation.

#### Platform and infrastructure
- Next.js 16 App Router on React 19, with Prisma and PostgreSQL (Neon in production).
- Vercel deployment with migrate-on-deploy, Vercel Blob storage for SCORM packages and uploads, and branded asset serving.
- Scheduled operations: nightly compliance refresh, daily reminder enqueue, and per-minute email delivery.
- App-wide alignment to the HAVEN Hub design system, including a shared component library, card and modal primitives, and consistent radii and typography.
- Health check endpoint and ongoing security hardening for Dependabot and CodeQL findings.

[1.0.0]: https://github.com/HAVEN-Free-Clinic/HAVENHub/releases/tag/v1.0.0
