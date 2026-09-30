# Desktop UI audit

## Scope
Profiles, Proxies, Sessions, Kernels, Settings, and all seven profile editor tabs.
Inspect light/dark themes at 960, 1280, and 1440 CSS pixels.
Test with isolated synthetic data; do not publish local paths, credentials, or browser profiles.

## Changes
- Improve inactive navigation and secondary text readability in both themes.
- Use shrinkable form grid columns and wrap narrow toolbars and headers.
- Keep input action buttons from shrinking and provide consistent vertical form spacing.
- Add visible keyboard focus to buttons and disclosure controls.
- Separate transient toasts from the bottom update notice and wrap long messages.
- Display the running application version rather than a hardcoded version.
- Point the support label to the Control repository.
- Exercise Duplicate through the visible More menu in the profile workflow test.
- Update setup assertions to match host-only builds.

## Validation
The initial Windows suite found two outdated interaction/setup assertions.
After correction, the full suite passed: 78 passed, one POSIX-only test skipped, zero failures.
The three POSIX update-owner tests also passed on macOS using the existing baseline checkout.
The five main views and seven editor tabs passed 72 theme/width geometry checks.
Twenty additional captures passed for populated lists, proxy forms, the profile context menu, error toast,
the displayed runtime version, and support/export entry points.
Screenshots are local test evidence; filesystem fields are masked and no screenshot is published.

## Launcher comparison
The current UI exposes profile editing, proxy changes, launch/stop, warmup, duplication,
import/export, Copy CLI, and Clear User Data. Narrow windows keep secondary commands in More.
Kernels have an independent page and managed executable selection remains the default.
This entry-point comparison does not certify every Launcher option's behavioral parity.

## Limits
Geometry checks are combined with representative screenshot inspection; they are not proof
that every possible input, display scaling setting, or platform dialog looks identical.
Kernel/network error and progress tests primarily use controlled fixtures.
This audit does not claim a live customer-profile launch or upload any browser profile.
The packaged smoke test checks startup; source UI tests validate the changed renderer.
