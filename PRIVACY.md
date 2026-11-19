# Privacy Policy – Leave Sync for YouTrack

**Effective date:** 19 November 2026

This policy explains what data the **Leave Sync for YouTrack** app ("the app") processes, where it is stored and who it is shared with. The app is published by **Codeo Engineering** ("we", "us").

## Summary

- The app runs entirely inside your YouTrack instance. It has no servers of its own, and **we (Codeo Engineering) never receive, see or store any of your data**.
- The app reads time-off data from **Microsoft Teams Shifts** through **Microsoft Graph**, using an app registration that your organization creates and controls. This is the only third party involved.
- Everything the app stores is kept in your YouTrack database and can only be seen by the people your YouTrack access rules and the app allow.

## Who is responsible for the data

Your organization (the YouTrack customer that installs the app) decides which employees are tracked and controls the Microsoft 365 tenant the app connects to. Your organization is the controller of this data. We do not process personal data on your behalf, because no data reaches us.

## What data the app processes

### Data read from Microsoft 365
When an administrator connects the app to Microsoft Teams, the app reads, with read-only application permissions:

| Data | Microsoft Graph permission | Purpose |
|---|---|---|
| Time-off entries of the configured Teams teams: Teams user ID, start and end time, time-off reason, the note entered in Shifts, and whether a change is shared with the team | `Schedule.Read.All` | Calculating leave used and showing leave history |
| Time-off reasons (for example "Vacation", "Sick") | `Schedule.Read.All` | Letting administrators choose which reasons count as annual leave |
| Display name, e-mail address and user principal name of Teams users who appear in the schedule and are not yet matched to a YouTrack user | `User.Read.All` | Matching Teams users to YouTrack accounts by e-mail |

The app never writes to Microsoft 365.

### Data entered in YouTrack
Leave administrators enter, for each tracked employee: hire date, an optional birth date (used only for the optional age-based entitlement rule), starting balance, entitlement overrides, manual adjustments and corrections with a note, and the date from which Teams leave is counted.

### Data stored by the app
All of the following is stored in your YouTrack database as app data (entity extension properties and app global storage):

- per tracked employee: the profile data above and the time-off entries read from Teams;
- app settings: leave types, public holidays, working time, entitlement rules, the mapping between Teams user IDs and YouTrack logins, and the name and e-mail of Teams users who could not be matched;
- a change history of administrative actions (who changed what and when, up to the last 300 entries);
- while a sync is running: the time-off entries being read, which are deleted when the sync finishes.

The Microsoft access token is held only in memory for the duration of a sync and is never stored. The client secret is stored as a secret app setting in YouTrack and is never sent to the browser.

### Data stored in the browser
The app remembers the chosen colour theme (auto, light or dark) in the browser's local storage. No cookies or tracking technologies are used.

## Who can see the data

- Every employee can see only their own leave data.
- System administrators and members of the "Leave administrators" group configured in the app settings can see and edit the leave data of all tracked employees.
- These checks are enforced on the server.

## Third parties

The app sends requests only to Microsoft:

- `login.microsoftonline.com` (Microsoft Entra ID), to obtain an access token with your app registration's tenant ID, client ID and client secret;
- `graph.microsoft.com` (Microsoft Graph), to read the data listed above. Requests contain only Microsoft identifiers (team IDs and Teams user IDs).

No data from YouTrack is sent to Microsoft. Microsoft's processing is governed by your organization's agreement with Microsoft and the [Microsoft Privacy Statement](https://privacy.microsoft.com/privacystatement).

The app does not use analytics, telemetry, advertising or any other external service, and it loads no external scripts or content.

## Retention and deletion

- Data is kept in your YouTrack instance for as long as the app is installed.
- Time-off entries that are deleted or cancelled in Teams are removed from the app at the next sync (within the period the app reads, at least the last 400 days).
- An administrator can stop tracking an employee at any time; the employee's data is then hidden and kept so it can be restored.
- Uninstalling the app from YouTrack removes all data the app stored.

## Your rights

Because the data is stored in your organization's YouTrack and Microsoft 365, requests to access, correct or delete personal data (for example under the GDPR or the Turkish Personal Data Protection Law, KVKK) should be sent to your organization's YouTrack administrator, who can make these changes in the app.

## Security

Access is limited by YouTrack authentication and the app's server-side permission checks. Communication with Microsoft uses HTTPS. We recommend creating a dedicated app registration for the app, granting only the two read permissions above, and rotating the client secret before it expires.

## Changes to this policy

We will publish any changes in this file in the app's GitHub repository and update the effective date. The change history is visible in the repository.

## Contact

Codeo Engineering
E-mail: [info@codeo.com.tr](mailto:info@codeo.com.tr)
Website: [codeo.com.tr](https://codeo.com.tr)
