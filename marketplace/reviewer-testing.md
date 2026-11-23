# Testing Leave Sync for YouTrack without your own Teams Shifts account

Leave Sync for YouTrack reads time off from Microsoft Teams Shifts through Microsoft Graph. To test the sync end to end you need a Microsoft 365 tenant where Teams and Shifts are available. We can't share access to our own tenant, because the app's Microsoft Graph permissions would give access to our company's real schedules.

The quickest way to review the app is its **demo mode**, which needs no Microsoft account. To test the real Microsoft connection as well, use one of the test tenants below.

## Demo mode: no Microsoft account needed (recommended)

1. Install the app. In **Administration → Apps → Leave Sync for YouTrack → Settings**, tick **Use demo data (no Microsoft connection)** and save. Leave the Microsoft fields empty.
2. In **Administration → Integrations → Leave Management → Employees**, add two or three users with hire dates. Use different hire dates, for example 2 years and 8 years ago, to see different entitlements.
3. Open **Leaves** in the main menu as each of these users and as the administrator.

For every employee you add, the app generates sample Teams Shifts time off relative to today:
- a vacation week spanning a weekend;
- three vacation days;
- leave around New Year's Day;
- a half day and a two-hour sick leave;
- two sick days;
- an upcoming vacation;
- a request shortened by the manager from 3 days to 1 without sharing;
- a request deleted in the schedule.

The data is shaped exactly like Microsoft Graph responses and goes through the same sync, matching and calculation code as real data. Only the HTTP transport is replaced: no request leaves YouTrack.

**Teams connection** also lists two Teams people who can't be matched, so **Link** and **Unlink** can be tested. *Vacation* starts as annual leave; you can change this on **Leave types**.

The asynchronous Microsoft requests (`onToken`, `onBatch` in `app/teams-sync.js`) only run with a real tenant (options below). Their logic is covered by `test/api.test.js`, which simulates YouTrack's async chain limits.

## Option 1: A Microsoft 365 trial

Microsoft offers a one-month free trial of Microsoft 365 Business Basic, Standard or Premium with 25 user licences. Shifts is included with the Teams licence. A credit card is required, and you can cancel during the trial.

1. **Start the trial.** On the Microsoft 365 for business site choose *Microsoft 365 Business Basic → Try free for one month*. You become the Global Administrator of a new tenant (`<name>.onmicrosoft.com`).
2. **Create test users.** In the Microsoft 365 admin center go to *Users → Active users → Add a user*. Create two or three users and assign the trial licence.
3. **Create a team.** In Teams (web or desktop) create a team and add the test users as members.
4. **Create a Shifts schedule.** Open the **Shifts** app in Teams, select the team, create a schedule and choose a time zone.
5. **Add time off.** In the schedule, add a few time-off entries for the members. Include a multi-day entry, a partial day and an entry on a public holiday. Then click **Share with team**. Time-off reasons such as *Vacation* and *Sick* are available by default.
6. **Register the app.** In the Microsoft Entra admin center create an app registration with the application permissions `Schedule.Read.All` and `User.Read.All` and grant admin consent. The app's Getting Started guide (Part 1, steps 1–4) describes each click.
7. **Connect YouTrack.**
   1. Install the app and open **Administration → Apps → Leave Sync for YouTrack → Settings**. Enter the tenant ID, client ID, client secret and Team ID, then save. The Team ID is the `groupId` value in the team's *Copy link*.
   2. Create YouTrack users whose e-mail addresses match the test users. You can also skip this and link the people manually in step 4.
   3. In **Administration → Integrations → Leave Management**, add the users on the **Employees** tab with hire dates, then click **Sync now** on **Teams connection**.
   4. If you skipped step 2, open **Teams connection → People in Teams not matched to YouTrack**, click **Link** for each person, then **Sync now** again.
   5. Open **Leaves** in the main menu as each user.

## Option 2: Microsoft 365 Developer Program sandbox

Organizations that qualify for the Microsoft 365 Developer Program sandbox, such as Visual Studio Professional or Enterprise subscribers and some partner programs, can create a free Microsoft 365 E5 developer subscription. Teams and Shifts are included. Then continue with steps 2–7 of Option 1.

## Local preview without YouTrack

The repository also contains a preview server with sample data. It runs the app's backend code with a mocked YouTrack and Microsoft Graph:

```sh
node test/shot-server.js            # or DEMO=1 node test/shot-server.js for demo mode
# open http://localhost:8765/leaves/index.html?as=chloe.adams        (employee)
# open http://localhost:8765/leaves-admin/index.html?as=isabel.turner (administrator)
```

## Suggested test scenarios

| Scenario | Expected result |
|---|---|
| **Sync now** on Teams connection | Returns at once; *Last sync: just now* with the number of leave items |
| Demo mode on, add an employee | Sample leave appears immediately; a *Demo data* notice is shown on both pages |
| Demo mode off, then **Sync now** with a real tenant | Demo leave, demo people and demo leave types are replaced by Teams data |
| Employee opens **Leaves** | Sees only their own balance, usage by type and history |
| Admin opens **Leaves → View → Team overview** | Sees every tracked employee |
| Leave types: tick *Vacation* as annual leave | Vacation days are deducted; other types are only counted |
| Time off on a weekend or public holiday | Not deducted |
| Half-day or hourly time off | Counted in hours |
| Shorten a time off in Shifts **without** sharing, then **Sync now** | New length counts; marked *not shared in Teams* |
| Delete a time off in Shifts and share, then **Sync now** | It disappears from the history |
| Wrong client secret in settings, then **Sync now** | Clear error with the Microsoft error code (for example AADSTS7000215) |
| Team ID of a team without Shifts | Error that names the Team ID setting and Shifts |

Questions: [info@codeo.com.tr](mailto:info@codeo.com.tr)
