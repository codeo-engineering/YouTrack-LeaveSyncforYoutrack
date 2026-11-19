# Testing Leave Sync for YouTrack without your own Teams Shifts account

Leave Sync for YouTrack reads time off from Microsoft Teams Shifts through Microsoft Graph. To test the sync end to end you need a Microsoft 365 tenant where Teams and Shifts are available. There are three ways to get one, in order of effort.

## Option 1: Use our demo tenant (recommended)

We provide a separate Microsoft 365 tenant that contains **only fictitious users and data**. It is not connected to our production tenant. On request we send, through a private channel:

- **App settings:** tenant ID, application (client) ID, client secret and the Team ID of the demo team.
- **Teams sign-in for the demo manager:** to add, change and delete time off in Shifts.
- **Teams sign-ins for two demo employees:** to request time off.

The demo team already has a Shifts schedule, time-off reasons and sample time off, for example: a multi-day vacation, a half day, an hourly sick leave, time off on a public holiday, and one change that hasn't been shared with the team.

To connect a YouTrack test instance:

1. Install the app and open **Administration → Apps → Leave Sync for YouTrack → Settings**. Enter the four values we sent and save.
2. Create YouTrack users whose e-mail addresses match the demo users we list. You can also skip this and link the people manually in step 4.
3. In **Administration → Integrations → Leave Management**:
   - On the **Employees** tab, add the users and give them hire dates.
   - On **Teams connection**, click **Sync now**.
4. If you didn't create matching users, open **Teams connection → People in Teams not matched to YouTrack**, click **Link** for each person, then **Sync now** again.
5. Open **Leaves** in the main menu as each user.

## Option 2: Your own Microsoft 365 trial

Microsoft offers a one-month free trial of Microsoft 365 Business Basic, Standard or Premium with 25 user licences. Shifts is included with the Teams licence. A credit card is required, and you can cancel during the trial.

1. **Start the trial.** On the Microsoft 365 for business site choose *Microsoft 365 Business Basic → Try free for one month*. You become the Global Administrator of a new tenant (`<name>.onmicrosoft.com`).
2. **Create test users.** In the Microsoft 365 admin center go to *Users → Active users → Add a user*. Create two or three users and assign the trial licence.
3. **Create a team.** In Teams (web or desktop) create a team and add the test users as members.
4. **Create a Shifts schedule.** Open the **Shifts** app in Teams, select the team, create a schedule and choose a time zone.
5. **Add time off.** In the schedule, add a few time-off entries for the members. Include a multi-day entry, a partial day and an entry on a public holiday. Then click **Share with team**. Time-off reasons such as *Vacation* and *Sick* are available by default.
6. **Register the app.** In the Microsoft Entra admin center create an app registration with the application permissions `Schedule.Read.All` and `User.Read.All` and grant admin consent. The app's Getting Started guide (Part 1, steps 1–4) describes each click.
7. **Connect YouTrack.** Follow steps 1–5 of Option 1 with your own values. The Team ID is the `groupId` value in the team's *Copy link*.

## Option 3: Microsoft 365 Developer Program sandbox

Organizations that qualify for the Microsoft 365 Developer Program sandbox, such as Visual Studio Professional or Enterprise subscribers and some partner programs, can create a free Microsoft 365 E5 developer subscription. Teams and Shifts are included. Then continue with steps 2–7 of Option 2.

## Checking the UI without Microsoft 365

The repository contains a preview server with sample data. It runs the app's real backend code with a mocked Microsoft Graph:

```sh
node test/shot-server.js
# open http://localhost:8765/leaves/index.html?as=chloe.adams        (employee)
# open http://localhost:8765/leaves-admin/index.html?as=isabel.turner (administrator)
```

## Suggested test scenarios

| Scenario | Expected result |
|---|---|
| **Sync now** on Teams connection | Returns at once; *Last sync: just now* with the number of leave items |
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
