# Leave Sync for YouTrack

A YouTrack app that pulls approved time off from **Microsoft Teams Shifts** and shows leave balances inside YouTrack.

- **Leaves** (main menu): every employee sees only their own remaining leave, usage by leave type and leave history, for a leave year, calendar year or custom range. Leave administrators can switch to any employee or a team overview.
- **Leave Management** (Administration → Integrations): employees and hire dates, seniority-based entitlement, carry-over, manual adjustments, corrections of individual leave items, leave types, public holidays and working time, and the Teams connection.

Setup and usage are described in [`marketplace/getting-started.html`](marketplace/getting-started.html).

## Repository layout

| Path | Contents |
|---|---|
| `app/` | The app package uploaded to YouTrack (manifest, settings, HTTP handlers, widgets) |
| `app/engine.js` | Leave calculation (pure functions, no YouTrack dependencies) |
| `app/teams-sync.js` | Microsoft Graph sync (Teams Shifts time off, users) |
| `app/api.js` | HTTP endpoints used by the widgets |
| `app/store.js` | Storage in YouTrack entity extensions |
| `app/widgets/` | `leaves` (main menu page) and `leaves-admin` (administration page) |
| `marketplace/` | Getting Started and listing description for JetBrains Marketplace |
| `test/` | Unit and API tests, plus local preview servers with sample data |

## Build

```sh
cd app && zip -r ../leave-sync-for-youtrack.zip . -x README.md
```

Upload the zip in **Administration → Apps**. To update, upload the new zip over the existing app; do not delete the app first, or its data is lost. The `name` in `app/manifest.json` (`leave-tracker`) is the app's technical ID and must not change.

## Tests

```sh
node test/engine.test.js
node test/api.test.js
```

## Local preview

```sh
node test/shot-server.js   # sample data, then open http://localhost:8765/leaves/index.html
```

## Microsoft Graph permissions

Application permissions with admin consent: `Schedule.Read.All`, `User.Read.All`. The app only reads data from Microsoft 365.
