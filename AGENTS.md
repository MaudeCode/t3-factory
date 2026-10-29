# Working on T3 Factory

Read [docs/development.md](docs/development.md) for validation commands and integration boundaries. Keep examples generic and update the relevant guide when changing behavior.

If `LOCAL.md` exists, read it for private maintenance and deployment instructions. Keep machine addresses, credentials, project mappings, and operator preferences in ignored local files.

Autonomous jobs dispatched by the scheduler follow the configured delivery workflow. Preserve current-head merge authorization, CI and review requirements, human validation, and explicit holds. A direct maintenance request does not change the permissions of autonomous jobs.

## Web controls

Settings pages should read as designed controls, not a form of text boxes and dropdowns. Pick the control in `web/ui/controls.js` that shows the choice:

- On or off: `Toggle` (labelled row) or `Switch`.
- One of a few fixed options (up to five): `Segmented`.
- Several values from a list: `Chips`.
- A count or limit: `Slots` (Off, quick picks, a box for any other value). Pick sensible steps with `picks` (for example 5, 10, 20, 40) rather than 1, 2, 3; `offLabel`, `unit` and `unlimited` cover Paused, "per day" and a null ∞ choice.
- A count with an unlimited end: `Stepper`. A duration or percentage: `Range`.
- `Select` only for long or live catalogs, such as T3 or Kanvil projects, models and repositories. `Input` only for free text: names, paths, repositories, tags and search.

Don't add a bare number box, or a dropdown for a short fixed list. Extend the existing control with a parameter rather than adding a second one, and check the page at desktop and phone widths with its `test/browser` fixture.
