# ADR 0005: Use native CSS Modules and local design tokens

- Status: accepted
- Date: 2026-07-11

## Context

One prior attempt spent disproportionate effort on Tailwind configuration and claims.
Both legacy UIs accumulated generic cards, gradients, theme layers, and CSS conflicts.
The restart needs a specific, restrained training-ledger identity and self-contained
assets.

## Decision

Use framework-native CSS Modules for component styles and a small global token layer.
Bundle fonts through local packages. Add headless accessible primitives only for controls
that need them.

## Consequences

- No Tailwind/UI-kit dependency in the foundation
- Tokens remain ordinary inspectable CSS
- Component selectors are local by default
- Shared patterns must be intentionally extracted rather than copied
- The decision may be revisited only with measured maintainability evidence
