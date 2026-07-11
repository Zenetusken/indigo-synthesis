# Product vision

Status: provisional product thesis pending Methodology Gate 0  
Working title: Indigo Synthesis, pending brand and rights review

## Mission

Help self-directed strength trainees follow an authored program, record what actually
happened, and understand the next adjustment—without giving a cloud platform ownership
of their training history.

## The problem

Most training tools fall into one of two categories:

- generic logs that preserve numbers but do not connect them to a coherent program; or
- opaque coaching products that prescribe changes without showing the rules, evidence,
  version, or assumptions behind them.

The abandoned implementations tried to solve this by becoming a fitness super-app and an
enterprise platform at the same time. The result was extensive code, documentation, and
infrastructure without one trustworthy training journey.

## Deliberate restart pivot

The durable insight recovered from the three attempts is the profile → plan → train →
learn workflow, not the legacy claim that neurotype classification, high-frequency
strength work, or omni-contraction sequencing is a validated differentiator. This restart
deliberately pivots to self-hosting, authored programming, deterministic decisions, and
inspectable explanations because those promises can be proved safely.

Gate 0 may exclude, narrowly reframe, or independently validate parts of the old
methodology. Until then, none of them is an accepted product claim or encoded behavior.
The self-hosting requirement and the product workflow are accepted; the specific
methodology wedge remains provisional.

## The product

Indigo Synthesis is a self-hosted strength-training system with one primary loop:

1. **Know the trainee.** Capture goals, experience, schedule, equipment, limitations,
   baselines, and explicit preferences.
2. **Prescribe transparently.** Instantiate a reviewed program through a deterministic,
   versioned methodology release.
3. **Train with focus.** Make today's workout obvious and let the trainee record sets in
   seconds.
4. **Learn from facts.** Derive history and progress from completed training.
5. **Adapt explainably.** Change only future work, within reviewed bounds, and show the
   reason.

## Primary user

A serious, self-guided recreational strength trainee who:

- follows structured programming;
- trains three to five times per week;
- wants mobile-friendly logging in the gym;
- values explanation and control over novelty;
- is willing to self-host or use an instance run by a trusted owner;
- does not want social pressure, ads, or mandatory cloud accounts.

Coach/client and multi-tenant workflows are possible later audiences, not assumptions in
the first release.

## Core promise

At any point, the trainee can answer:

- What am I doing today?
- What was prescribed, and why?
- What did I actually complete?
- What changed next, and which reviewed rule caused it?
- Which data and program version produced this history?

## Principles

### Truth before personalization

Unavailable information stays unavailable. Estimates are labeled. Coaching hypotheses
are not described as measurements. A safe simple answer is better than a precise-looking
fiction.

### Authored before generated

The first release instantiates one licensed, expert-reviewed program family. Generic
generation, AI, and broad exercise creativity do not precede content validation.

### Deterministic before intelligent

The same inputs and versions produce the same prescription and explanation. Machine
learning can be considered only after a clean consented dataset and an evaluation
protocol exist.

### Progress without compulsion

The product celebrates real completion and personal records. It does not punish rest,
use loss aversion, manufacture scarcity, or optimize for screen time.

### Self-hosted by construction

Core use requires one application, one PostgreSQL database, and no mandatory outbound
service. Fonts, assets, authentication, and history remain local to the deployment.

### Small enough to finish

Every screen, table, and dependency must strengthen the profile → plan → train → learn
loop. New infrastructure or feature categories require measured need and a decision
record.

## Success

The first release succeeds when a new self-hosted instance can:

1. bootstrap an owner;
2. create a trainee profile;
3. instantiate one reviewed program;
4. show and start today's workout;
5. record and complete every set;
6. survive an application restart during the session;
7. show persisted history and a factual summary;
8. produce one bounded, explained future adjustment; and
9. export the trainee's data; and
10. preview and delete the trainee's personal data without retaining training content.

This journey must pass in a real browser against a fresh PostgreSQL database with
outbound network access blocked.

## Explicit limits

The restart is not:

- a medical, neurological, rehabilitation, or nutrition service;
- a social network;
- an AI coach;
- a wearable analytics platform;
- a marketplace or billing platform;
- a native mobile application;
- an offline-first synchronization system; or
- a distributed systems exercise.

Those boundaries protect the product rather than diminish it.
