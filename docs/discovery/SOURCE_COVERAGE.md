# Source coverage

This file records what the 2026-07-11 discovery actually inspected. It is intentionally
honest about full reads, targeted reads, enumerations, and exclusions.

## Canonical corpus

The complete canonical documentation tree contained 142 files (about 3.1 MB).

### Fully read first

- `project-synthesis-training/docs/architecture/VISION.md`
- `project-synthesis-training/docs/architecture/FEATURE_SPECIFICATIONS.md`
- `project-synthesis-training/docs/architecture/TECHNICAL_SPECIFICATIONS.md`

### Fully read product/domain lane: 23 files

- The 9 remaining root architecture documents:
  `ADR_001_MULTI_DATABASE_ARCHITECTURE.md`, `DATA_ARCHITECTURE.md`,
  `DOCKER_COMPOSE_SEPARATION_ANALYSIS.md`, `IMPLEMENTATION_ROADMAP.md`,
  `INTEGRATION_MAP.md`, `MASTER_ARCHITECTURE.md`,
  `PRD_PHASE_2_3_2_4_DOCKER_COMPOSE_INFRASTRUCTURE.md`,
  `SELF_HOSTED_INFRASTRUCTURE.md`, and `TECH_STACK.md`
- All 7 files under `docs/research/indigo_methodology/`
- All 7 files under `docs/research/training_architecture/`

### Fully read experience lane: 21 files

- All 7 files under `docs/research/module_organization/`
- All 7 files under `docs/research/progress_tracking/`
- All 7 files under `docs/research/ui_ux_design/`

### Fully read governance/status lane: 12 files

- `docs/README.md`
- `docs/REVIEWER_CHECKLIST.md`
- All 4 files under `docs/architecture/adr/` and
  `docs/architecture/decisions/`
- Six high-level completion/regression reports spanning the competing 301/301, 272-test,
  294-test, and production-ready claims:
  `ALL_301_TESTS_PASSING_2025-10-15.md`, `COMPLETE_TEST_VALIDATION_2025-10-14.md`,
  `FINAL_REGRESSION_TEST_REPORT_2025-10-15.md`,
  `PHASE_2_2_100_PERCENT_COMPLETION_REPORT.md`,
  `TEST_VERIFICATION_294_TESTS_2025-10-11.md`, and
  `TYPESCRIPT_ESLINT_REGRESSION_VALIDATION_FINAL_2025-10-15.md`

### Live canonical evidence

The entire `src/` tree was enumerated. The landing, disabled auth pages, layout,
styling, env/logger/utilities, and neurotype constants were read. The alleged E2E journey
and assessment/workout/user-journey load tests were read deeply.

The git history was inspected from initialization through the active infrastructure
branch. It shows infrastructure work from the first commit onward and no product-feature
implementation phase.

### Excluded by direction

After the user narrowed the task, detailed CI/CD, Docker Compose, Redis
Sentinel/cluster, Portainer, monitoring, deployment, and duplicated infrastructure/test
reports were not treated as product requirements. Their filenames and sizes were
inventoried; relevant high-level failure evidence had already been captured.

## Indigo implementation

Generated/vendor output, environment secret values, backups, deployment internals, and
cache/monitoring detail were excluded.

### Fully read

- Product/package/index/status documents, including
  `docs/indigo_vision_statement.md`, `docs/INDEX.md`,
  `docs/DOCUMENTATION_OVERVIEW.md`, and current audits
- The only page, root providers, dashboard hook/client/types, core dashboard components,
  auth routes, assessment route, workout route, exercise route, and representative
  repositories/middleware/validation
- Workout, program, assessment, and dashboard types
- Migration runner/schema and migrations 015–020
- Representative dashboard E2E test

### Deep targeted reads

- Core process, onboarding, neurotype, stack, modular-architecture, UI, placeholder,
  AI-recommendation, and workout-integration documents
- Dashboard unified API/client/security and fallback behavior
- Assessment, scoring, workout, and session services
- Workout/progressive-overload/neurotype routes
- Calendar, focus, progress, and flow-state UI/CSS
- Migrations 025–028

### Enumerated

- All 57 API route paths
- All pages, components, services, repositories, types, tests, and migrations
- All migration tables/indexes/seeds
- All SuperDesign iterations and backup/churn artifacts
- Cloud SDK, external URL, placeholder, body-read, and documentation-link scans

### Current checks

- `tsc --noEmit --incremental false --pretty false` exited 2 on syntax errors in two
  integration tests.
- The server/database/full suite was not started; conclusions are static-code findings.

## Training implementation

### Fully read

- Root and modular instructions, package/manifest, server, and `index.html`
- All 3 PDFs in full (42 pages total)
- All 5 live workout-day fragments
- All 19 active JavaScript files loaded by `index.html`, plus the service worker
- All 44 files under `training/modular/docs/`
- Jest configuration/setup and representative state/Today tests
- Navigation archive summary

### Deep targeted reads

- All major paths in the 6,117-line Today component
- Profile, reset/export, and 5,867-line stylesheet structure
- Dormant intensity/achievement/progress/stat systems
- Representative E2E, navigation, offline, service-worker, achievement,
  recommendation, and integration tests
- Both legacy brand assets were visually inspected

### Enumerated/excluded

- Every test and archive file was enumerated.
- Redundant backups, generated coverage, vendor modules, binary backup ZIP, inactive
  variants, and low-signal debug/coverage-padding tests were not read line by line.

### Current checks

- Every active loaded JavaScript file passed `node --check`.
- The full Jest run exited 1 when navigation called nonexistent
  `state.saveState`.
- Several isolated suites passed, but their mocks reimplemented behavior or matched the
  wrong live API, so they are not acceptance evidence.

## External primary sources

Current stack and safety framing were checked against:

- Official Next.js 16, self-hosting, installation, and PWA documentation
- Official React 19.2 documentation
- Official Node.js release policy
- Official PostgreSQL 18 release/version/JSONB documentation
- Official Drizzle migration/transaction documentation
- Official Better Auth Next.js/PostgreSQL/session documentation
- Official TypeScript 6/7 release notes
- Official Vitest and Biome releases
- W3C WCAG 2.2
- 2026 ACSM resistance-training position stand and PubMed-indexed autoregulation/TCI
  research

No web source was used to validate the legacy outcome claims. Those claims remain
unverified.

## Secret and mutation boundary

- No environment secret values were read.
- No legacy source file was edited.
- PDF text extraction was written only to `/tmp`.
- The only persistent changes are inside the new `indigo-synthesis` folder.
