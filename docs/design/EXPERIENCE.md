# Experience strategy

Status: accepted direction; interaction details evolve through tested vertical slices

The live engineering slice implements these flows with a visibly labeled, unreviewed
development fixture. “Reviewed program” below remains the production target, not a
description of the bundled fixture. See [MVP status](../MVP_STATUS.md).

## Design brief

**Subject:** a self-hosted strength-training companion built around an authored program  
**Audience:** serious self-directed recreational lifters  
**Primary job:** show the next meaningful action, record a set in seconds, and preserve
an honest history

The product is used between demanding physical efforts. It must be calmer and clearer
than a fitness-content feed, denser than a wellness dashboard, and more explanatory than
a generic notes app.

## First vertical-slice information architecture

Primary:

- **Today** — start or resume, program context, compact workout preview
- **Program** — phase/week, schedule, prescriptions, explanations
- **History** — completed sessions and factual summaries

Secondary:

- **Settings** — profile, units, account/instance, export, deletion, appearance

No empty Community, Nutrition, Recovery, or Profile destination occupies navigation.

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

Owner bootstrap → sign in → units/timezone → goal/experience → equipment/schedule →
baselines/limitations → review inputs → instantiate reviewed program → program overview
→ Today

No carousel, body-composition demand, mandatory photo, long assessment, or feature tour
blocks the first program.

### Returning use

Open Today → Resume active session or review today's prescription → Start

Target: start/resume in at most two actions.

### Active workout

1. Show exact saved state, elapsed time, and session/exercise progress.
2. Show current exercise, prescription, guidance, and previous comparable work.
3. Present ordered sets with target and actual fields.
4. Complete the defaulted set in one action.
5. Start a contextual rest timer and preview what comes next.
6. Allow add/edit/note/substitute without leaving the session context.
7. Persist each material mutation and announce saved/conflict/error truthfully.
8. Complete, explicitly handle missing work, then show summary.

### Post-slice progress (Phase 3)

Select exercise → see top-set or labeled e1RM trend → inspect source sets → view session
history and recent PRs

Weekly adherence is relative to prescribed sessions, not consecutive calendar days.

## Active-workout wireframe

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
- one-handed placement for set completion and timer controls
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
