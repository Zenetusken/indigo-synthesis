# Design system direction

Status: foundation implemented on the restart-orientation page

The visual system was developed using the frontend-design workflow: ground the subject,
brainstorm a compact token/layout/signature plan, critique generic choices, then build.

## Pass one: initial plan

### Subject

Serious strength training: bar knurling, rack notches, plate calibration, program sheets,
timers, and written set records.

### Initial proposal

- Dark iron ink, warm chalk, indigo, copper, and green
- Condensed athletic display type, accessible body type, monospaced data
- Card-based Today dashboard
- A vertical rack rail beside active sets

### Critique

The warm chalk/copper combination was too close to a common cream-and-terracotta template.
A familiar athletic condensed face and a card dashboard could fit nearly any gym app.
Dark backgrounds plus a bright accent also risked becoming another generic “performance”
theme.

### Revision

- Move the canvas to cool equipment primer and white paper, keeping dark ink for
  high-contrast sections rather than the entire product.
- Replace copper with calibrated plate yellow as a sparse active marker.
- Use indigo enamel for identity/actions, not a glow or gradient.
- Use Saira Semi Condensed/variable for instrument-panel character, Atkinson Hyperlegible
  for body/control clarity, and IBM Plex Mono for loads/reps/timers.
- Replace dashboard cards with ruled sections, ledgers, and explicit hierarchy.
- Spend the one aesthetic risk on the calibrated rack rail inside active workout only.

This is specific to the subject and leaves the rest of the interface quiet.

## Color

| Token | Hex | Use |
| --- | --- | --- |
| Rack ink | `#151922` | Primary text and rare inverse surfaces |
| Rack ink soft | `#28303D` | Secondary high-contrast text |
| Primer | `#E7EBF0` | Main cool canvas |
| Paper | `#F8FAFC` | Ruled content surface |
| Paper raised | `#FFFFFF` | Overlays and inputs |
| Indigo enamel | `#3546A3` | Primary action and identity |
| Indigo deep | `#27357F` | Text-safe indigo emphasis |
| Plate yellow | `#D59A1F` | Active notch/selection, never small text on white |
| Verified | `#26705A` | Confirmed/saved state with text/icon |
| Steel | `#5B6675` | Muted labels; 4.87:1 minimum against primer |
| Hairline | `#C8D0DA` | Structure and table rules |
| Focus | `#1B63D9` | Keyboard focus ring |

No neurotype receives a color personality. Red is reserved for destructive/error
semantics if introduced.

## Typography

- **Display/workout hierarchy:** bundled `Saira Variable`; condensed widths used with
  restraint for exercise names and page theses.
- **Body and controls:** bundled `Atkinson Hyperlegible`, regular and bold.
- **Data/utility:** bundled `IBM Plex Mono`, medium, with tabular numerals.

Fonts ship inside the application. No Google Fonts or external CDN request is allowed.

Suggested scale:

- Hero orientation thesis: fluid 58–134px
- Product page title: 40–64px
- Exercise title: 30–42px
- Section title: 24–32px
- Body/control: 16–18px
- Data/label: 11–14px with restrained letter spacing

All load, rep, RPE, rest, and timer values use tabular numerals.

## Layout

- 4/8/12/16/24/32/48/64 spacing rhythm
- Content maximum around 82–90rem depending on task
- Restrained 4–8px radii
- Hairline rules encode groups and order
- Shadows only for real overlays
- One document scroll root
- Mobile is the active-workout reference layout; desktop adds context, not a separate
  product

Avoid:

- glass cards;
- gradients as atmosphere;
- emoji-led metrics;
- floating decorative pills;
- bodybuilder hero imagery;
- dense calendar dashboards;
- multiple animated scores; and
- generic 01/02/03 markers where order has no meaning.

## Signature: calibrated load rail

The active workout set ledger has a vertical rail with one notch per ordered set.

- The current notch uses plate yellow.
- Completed notches use verified state plus a check label/icon.
- Upcoming notches remain paper/ink.
- Warm-up, working, and advanced set types change the notch label or shape without
  relying on color.
- The rail never appears as generic decoration on marketing or settings screens.

The restart-orientation page uses an early rail to represent the real ordered product
loop. Product implementation will reserve it for sets.

## Motion

One orchestrated motion may accompany set completion/rest transition. Everything else is
instant or a short functional transition.

- Never animate a measured number to a different value.
- Timer state comes from timestamps.
- Respect `prefers-reduced-motion`.
- No breathing readiness circles, pulsing destructive actions, endless glows, parallax,
  or auto-rotating advice.

## Controls

- Workout controls: at least 48px
- Numeric input text: at least 16px
- Primary action label names the exact result
- Sticky controls do not cover focused content
- Icon-only controls require an accessible name and tooltip where appropriate
- State is communicated by text/icon plus color
- Destructive reset lives only in Settings and requires explicit confirmation

Accessible headless primitives may be added one component at a time. A large prebuilt
component suite is not part of the foundation.

## Content and imagery

Use authored program content, exercise diagrams, and training data only when licensed and
provenanced. No legacy T-Nation mark, Indigo bodybuilder header, scraped media, or
transformation photography is inherited.

Copy is direct and operational. It explains rather than sells.

## Current implementation note

The root page is a collaborator-facing orientation surface, not a fake product
dashboard. Its single job is to communicate the recovered thesis, next proof, core loop,
and locked scope. It intentionally displays no fabricated workout metrics.
