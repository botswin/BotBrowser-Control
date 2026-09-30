# Design

## Source of truth
- Status: Active
- Primary surfaces: Profiles, Proxies, Sessions, Kernels, Settings; seven profile editor tabs.
- Evidence: renderer views and shared CSS, legacy Launcher navigation, isolated desktop E2E.

## Brand and product goals
A practical desktop workspace for managing browser profiles. Use the original Launcher icon.
Prioritize readable controls, predictable workflows, automatic kernel selection, and compact density.
Do not populate sample profiles or require advanced executable configuration for normal use.

## Personas and jobs
Operators create, import, configure, launch, warm up, duplicate, export, and delete profiles.
They manage proxies and kernels, observe running sessions, and change application settings.

## Information architecture
Keep the five primary navigation entries stable.
Separate primary creation/search controls from import/export tools.
Keep secondary profile commands available through More at narrow widths.

## Visual language and components
Reuse shared buttons, form groups, cards, menus, status pills, and theme tokens.
Use 8px control gaps, 12px form grid gaps, and 16px card body spacing.
Do not compress icon buttons or clip primary action labels.
Inputs may shrink inside flex layouts; text must remain readable in both themes.

## Accessibility
Provide visible keyboard focus and readable inactive navigation.
Preserve labels and descriptive button titles. Do not rely solely on color for state.

## Responsive behavior
Support desktop widths from 960px, with checks at 960, 1280, and 1440.
Wrap toolbars; collapse secondary actions into menus while retaining all commands.
Use minmax(0, 1fr) for form columns and reduce three columns at narrow widths.

## Interaction states and content
Fresh installs start empty. Explain empty, loading, error, success, and disabled states.
Show ongoing progress during network and installation work.
Display the runtime application version and the Control support destination.

## Implementation constraints and validation
Electron with existing vanilla renderer and CSS; avoid new UI dependencies.
Use isolated synthetic fixtures for tests and screenshots. Mask filesystem fields.
No real browser profiles, credentials, personal data, or local directory inventories in public artifacts.
Run user-facing flows and inspect screenshots, not only API assertions.

## Open questions
Platform-specific dialogs, real browser kernel launches, and live network availability require
separate evidence; mocked fixtures must not be described as live end-to-end verification.