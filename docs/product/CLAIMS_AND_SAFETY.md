# Claims, evidence, and safety policy

Status: mandatory product gate

## Why this exists

The legacy vision and implementations repeatedly described a coaching framework as a
scientifically validated neurological assessment and attached precise claims to strength,
body composition, recovery, injury reduction, nutrition, and adherence. The reviewed
corpus did not contain the study design, validation cohort, calibrated instrument,
primary evidence, or rights needed to support those claims.

This policy prevents those assertions from becoming product copy, data fields, or
automated behavior by default.

## Evidence vocabulary

Every material coaching rule or public claim uses one status:

- **Established** — supported by current high-quality consensus/review and applicable to
  the represented population.
- **Supported** — useful evidence exists, with material limitations recorded.
- **Experimental** — plausible and bounded, but not validated for product claims.
- **Expert opinion** — approved practitioner judgment, clearly labeled.
- **Unverified** — no adequate support in the evidence record.
- **Prohibited** — unsafe, misleading, rights-unclear, or outside product scope.

The status, source, reviewer, approval date, population, limitations, and expiry/review
date are stored with the rule.

## Initial claim ledger

| Legacy claim or behavior | Restart status | Product treatment |
| --- | --- | --- |
| Questionnaire identifies dopamine, serotonin, GABA, or acetylcholine dominance | Prohibited pending independent validation | Do not describe or model as a measured neurotransmitter state |
| Five neurotypes are scientifically validated training prescriptions | Unverified | If retained, frame as an optional coaching/preference framework with uncertainty and override |
| 85% greater strength gains / precise lift increases | Prohibited | Remove from copy and success criteria |
| 95% assessment accuracy or adherence | Prohibited | No labeled instrument, gold standard, cohort, or evaluation exists |
| Exact injury-risk reduction, recovery-time reduction, or metabolic increase | Prohibited | Remove; never infer from app activity |
| e1RM from completed sets | Supported estimate | Show formula, inputs, date, and the word estimate |
| RPE-based autoregulation | Supported with limitations | May enter a reviewed bounded rule after domain approval |
| Readiness score from sleep/soreness/motivation | Experimental/deferred | Inputs may be recorded later; no medical or mandatory training decision |
| Neurotype-specific nutrition and supplement doses | Prohibited in core product | Excluded from automated behavior and copy |
| Extreme eccentric, ballistic, drop-catch, or max-effort methods | Expert-gated/deferred | Require rights, safety tier, eligibility, and qualified review |
| AI-powered program generation | Prohibited description for deterministic rules | Call it a reviewed program rule or methodology release |
| Optional local plain-language paraphrase of a persisted reason code | Inferred presentation only (design accepted; not shipped) | Never a decision source; label as inferred; always show reason code and ruleset version; see [explanation generation contract](../architecture/EXPLANATION_GENERATION_CONTRACT.md) |

## Scientific baseline

The 2026 ACSM position stand synthesizes 137 systematic reviews covering more than
30,000 participants and emphasizes resistance training, goal-specific loading/volume,
and adherence without establishing the legacy neurotransmitter-to-program mapping:

- https://pubmed.ncbi.nlm.nih.gov/41843416/

Autoregulation using RPE/APRE/velocity has an evidence base, but reviews also record
uncertainty and population limits:

- https://pubmed.ncbi.nlm.nih.gov/33520457/
- https://pubmed.ncbi.nlm.nih.gov/40791980/

Cloninger's Temperament and Character Inventory is a personality instrument. That does
not itself validate the legacy leap from questionnaire answers to neurotransmitter
dominance or strength-program prescriptions. One reviewed genetic association study
found no significant differences on the broad temperament dimensions for the examined
transporter genes:

- https://pubmed.ncbi.nlm.nih.gov/11340364/

The absence of adequate evidence in this audit is not proof that no evidence can exist.
It is sufficient reason not to make the claim until a qualified review produces it.

## Safety boundary

The first product serves healthy adults performing self-directed strength training. It
does not:

- diagnose injury, overtraining, hormonal state, mental health, or neurological state;
- prescribe treatment, rehabilitation, medication, supplements, or clinical nutrition;
- claim to prevent injury;
- infer data it does not directly receive; or
- replace a qualified coach or health professional.

Before a reviewed template is published, it must define:

- intended experience level and population;
- exclusions and contraindications;
- pain/stop/escalation behavior;
- equipment and spotter requirements;
- safe load/repetition/rest bounds;
- advanced-technique eligibility;
- substitution rules;
- deload and failed-session behavior; and
- reviewer identity and review date.

## Data honesty

Data is categorized as:

- **System observed:** server-recorded command and completion timestamps.
- **User-attested performed:** load and repetitions the trainee confirms as performed.
  Each value preserves whether it was copied from a target/prior set, edited, and
  explicitly confirmed.
- **User reported:** RPE, pain/issues, sleep quality, soreness, motivation, notes.
- **Derived:** e1RM, volume, adherence, personal-record classification.
- **Prescribed:** target load, reps, rest, tempo, technique.
- **Inferred:** any model output not directly observed or attested by the user.

The UI labels derived and inferred values. No category silently becomes another.

`null` means unavailable. A request failure, empty history, or missing sensor never
becomes a realistic default.

## Intellectual property gate

Do not copy or publish:

- the legacy T-Nation/Indigo logos or bodybuilder image;
- third-party PDF text, tables, or exact workout content;
- Christian Thibaudeau or Biotest branded program material;
- assessment questions;
- scraped exercise media; or
- branded method names in a commercial product

until ownership, license, attribution, permitted transformations, territories, and
commercial use are documented.

The folder and product name are working labels only.

## Approval record

No methodology release can move from `draft` to `reviewed` until:

1. a domain expert approves the content and bounds;
2. an evidence reviewer approves the claim language;
3. rights are confirmed;
4. golden examples and property tests pass; and
5. a product reviewer verifies that the UI presents limitations and explanations.
