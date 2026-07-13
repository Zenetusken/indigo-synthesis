# Experience strategy

Status: accepted direction; interaction details evolve through tested vertical slices

The live engineering slice implements the core path with a visibly labeled, unreviewed
development fixture. This document distinguishes that current behavior from interaction
targets that still depend on reviewed content or later product work. “Reviewed program”
below remains the production target, not a description of the bundled fixture. See
[MVP status](../MVP_STATUS.md).

## Design brief

**Subject:** a self-hosted strength-training companion built around an authored program  
**Audience:** serious self-directed recreational lifters  
**Primary job:** show the next meaningful action, record a set in seconds, and preserve
an honest history

The product is used between demanding physical efforts. It must be calmer and clearer
than a fitness-content feed, denser than a wellness dashboard, and more explanatory than
a generic notes app.

## First vertical-slice information architecture

Current primary navigation:

- **Today** — start or resume, program context, compact workout preview
- **Program** — the A/B/C development-fixture schedule, exact prescriptions, release
  status, and version/hash reproducibility record; phase/week presentation and optional
  plain-language Explain remain release-target work
- **History** — completed sessions, factual summaries, correction provenance, stored
  decisions, and optional grounded explanations; revoked content and invalidated decisions
  keep their authoritative codes visible while Explain is disabled

Current secondary navigation:

- **Settings** — account facts, read-only training context, owner-created local users,
  owner-mediated per-trainee reset-code issuance, subject export/deletion, and owner-only
  instance reset. Profile/unit editing and appearance controls are not built.

No empty Community, Nutrition, Recovery, or Profile destination occupies navigation.

The reviewed-content target adds phase/week context and reviewed rationale to Program.
After the slice passes, Phase 3 expands History with exercise-specific views and adds
**Progress** for defined PR, e1RM, volume, and adherence trends.

## Experience principles

### Action before dashboard

Today answers “what do I do now?” before showing any chart, score, or calendar. When a
session is active, Resume replaces every competing primary action.

### Prescription and reality side by side

Targets, prior comparable performance, and current actual values remain visually
distinct. The product never silently turns one into another.

### Defaults reduce work; they do not hide decisions

Actual fields may begin from the target or prior set, but the origin is visible and the
trainee remains in control. The saved record preserves whether each performed value was
copied, edited, and explicitly confirmed; the application does not claim to observe the
weight or repetitions.

### Facts before motivation

Progress uses completed sessions, sets, and labeled estimates. It does not invent
recovery, momentum, power, readiness, or neurological scores.

### Rest is training

Scheduled rest appears as an intentional state, not a gap or failed streak. Engagement
comes from useful history and frictionless return.

### Failure is specific

An unavailable workout says why and what action is possible. It does not replace server
failure with sample advice or random calendar days.

## Core flows

### First use

Current engineering slice:

Owner bootstrap → sign in → units/timezone → goal/experience → equipment/schedule →
baselines/limitations → review inputs → create the visibly unreviewed development program
→ program overview → Today

The release target replaces only that development-content step with selection and
instantiation of a licensed, reviewed program release; it does not add an onboarding tour
or an opaque generator.

No carousel, body-composition demand, mandatory photo, long assessment, or feature tour
blocks the first program.

### Locked-out access and recovery

Current engineering slice:

- On a claimed instance, sign-in keeps the credential form primary and places recovery
  orientation in one collapsed **Can't sign in?** disclosure. The wordmark and current
  content-mode label appear before credential entry.
- A locked-out trainee asks the owner out of band. In Settings, the owner opens the
  target-specific **Issue password reset code for {name}** control, sees that reissue
  invalidates any earlier unused code, re-enters the owner password, and hands over the
  one-use code. The trainee follows **Use a trainee reset code**, chooses a new password,
  and returns to sign-in after all old sessions are revoked.
- A locked-out owner uses host access to issue a recovery code, then follows **Use a
  host-issued owner recovery code** or redeems through the host CLI. The CLI path remains
  the unthrottled recovery escape path.
- A visitor without an account is told that only the owner creates local accounts and
  that public signup is unavailable. On an unclaimed instance, sign-in and both recovery
  routes redirect to bootstrap.

### Returning use

Open Today → Resume active session or review today's prescription → Start

Target: start/resume in at most two actions.

### Active workout

Current engineering slice:

1. Show the exact persisted session state, start time, optimistic revision, and unresolved
   set count.
2. Show each exercise's prescription, rationale code, and previous comparable work when
   available.
3. Present ordered sets with target and actual fields.
4. Default pending load/repetition inputs from the target and require explicit completion
   or a reasoned skip.
5. Show timestamp-derived rest context after a performed set; backgrounding does not pause
   it.
6. Accept an optional RPE and note with set completion, plus pause/resume, pain stop, and
   confirmed abandonment without leaving the session.
7. Send substitution requests through the authenticated boundary, but fail closed without
   changing the prescription because no reviewed substitution release is installed.
8. Persist each material mutation, announce saved/conflict/error truthfully, and complete
   only after every set is performed or explicitly skipped.
9. If the session ends before a workout request, redirect through a cause-neutral sign-in
   notice with only a canonical `/workouts/<UUIDv7>` return path. After sign-in, recheck
   that the new actor owns the session, restore all committed set/pause state, and show
   the next unresolved set. Do not replay the denied command or claim unsaved fields were
   persisted.

Release-target additions include reviewed authored technique/guidance, approved
substitution, the separately planned audited completed-set correction entry, and any
rest controls justified by gym-use evidence. Those target elements remain visible in the
reference wireframe below but are not claims about the current UI.

### Post-slice progress (Phase 3)

Select exercise → see top-set or labeled e1RM trend → inspect source sets → view session
history and recent PRs

Weekly adherence is relative to prescribed sessions, not consecutive calendar days.

## Active-workout target wireframe

This wireframe preserves the release direction. “Why this?”, technique content, audited
completed-set correction entry, and `+30s` rest controls are not implemented in the
engineering slice.

Mobile:

```text
┌──────────────────────────────────┐
│ Back    32:18       Saved        │
│ Workout 2 of 4 · Exercise 1 of 5 │
├──────────────────────────────────┤
│ BACK SQUAT                       │
│ 3 × 5 · 120 kg · Rest 180 s      │
│ Why this?  Technique             │
│                                  │
│ Previous: 3×5 @ 117.5 kg · RPE 8 │
├────┬────────┬────────┬─────┬─────┤
│rail│ target │ load   │ reps│ RPE │
│ 01 │ 120×5  │ 120 kg │  5  │  8  │ ✓
│ 02 │ 120×5  │ 120 kg │  5  │     │
│ 03 │ 120×5  │        │     │     │
├────┴────────┴────────┴─────┴─────┤
│ Rest 02:18       Skip       +30s │
│        COMPLETE SET              │
└──────────────────────────────────┘
```

Desktop:

```text
┌───────────────────────────────┬──────────────────────┐
│ Current exercise + set ledger │ Prescription / why   │
│                               │ Previous performance │
│ Calibrated rail               │ Technique / safety   │
│ Actual controls               │ Next exercise        │
├───────────────────────────────┴──────────────────────┤
│ Sticky session action + contextual rest timer        │
└──────────────────────────────────────────────────────┘
```

The rail encodes real ordered sets. It is not decorative numbering.

## Required states

Today:

- no profile
- no active program
- rest day
- planned workout
- active session
- completed today
- unavailable/conflict

Workout:

- loading initial persisted state
- active
- paused
- saving
- saved
- validation error
- optimistic-version conflict
- unauthorized
- completed
- abandoned

History/progress:

- no completed data
- partial history
- factual data
- formula unavailable
- server error

Sample/demo data is allowed only in an explicitly labeled demo environment and cannot
share the production persistence path.

## Mobile and ergonomics

- 48px minimum workout controls
- 16px minimum numeric-input text to avoid mobile zoom
- appropriate numeric keyboard
- one-handed placement for set completion; any future timer controls must follow the same
  rule (the current timer is timestamp-derived display only)
- safe-area-aware sticky bottom action
- one document scroll root
- no gesture-only or hover-only behavior
- timestamp-based timer
- exact server-backed resume after refresh/restart

Offline mutation/sync is not part of this interaction model.

## Accessibility

Target WCAG 2.2 AA:

- semantic buttons, inputs, headings, lists, tables, and status regions;
- logical focus order and visible focus;
- focus never hidden by sticky controls;
- text/icon/status labels in addition to color;
- reduced-motion support;
- 200% zoom without lost action or two-dimensional page scrolling;
- captions/transcripts when media exists;
- accessible authentication without cognitive tests;
- live announcements for save, completion, timer, and conflict events; and
- all dragging/gesture interactions have direct controls.

The workout interface deliberately exceeds WCAG's 24px minimum target with 48px controls.

References:

- https://www.w3.org/TR/WCAG22/
- https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum

## Language

Use plain user-side vocabulary:

- “Complete set,” not “Submit”
- “Saved,” not “Mutation succeeded”
- “No workout is scheduled,” not an empty chart
- “This estimate uses Epley,” not “AI strength”
- “Why this changed,” not “Optimization insight”

Errors state what happened and what can be done. They do not apologize or offer mood.
