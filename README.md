# GSD — Getting Stuff Done

A standalone version of the GSD system. Todoist is the source of truth, Claude (via the Anthropic API) is the brain, GitHub runs everything. No server, no subscription required.

Three parts, one repo:

1. **The briefs** (`.github/workflows/briefs.yml` + `scripts/brief.mjs`). GitHub Actions runs three times a day: a morning brief at 7:37am (picks Today's Three, applies strikes to overdue tasks, reports habit streaks), a 2:47pm check-in, and a 4:47pm evening review (rolls unfinished priorities to tomorrow with a strike; three strikes sends a task to the Pit of Doom). On Mondays the morning brief opens the week: one big outcome, plus anything undated that deserves a day. On Fridays the evening review becomes the weekly review: what got done, what's carrying strikes, what's in the Pit and whether anything deserves rescue. Each brief arrives as a phone push (Pushover) and an email.
2. **`context.md`** is the plan behind the plan: what the projects are for, who the people are, what your own shorthand means, what "done" looks like. Both the briefs and the dashboard read it, so anything written there is something GSD can explain back to you. Edit it whenever the picture changes. **The repo is public, so keep private detail out of it**; the dashboard settings have a private context box that stays in your browser.
3. **The dashboard** (`index.html`, served by GitHub Pages). Today's Three, a focus timer with a 90-minute daily target and a 7-day focus history (stored in that browser), Done buttons that close tasks in Todoist, a capture box that feeds the Inbox, an **Ask GSD** panel that answers questions about any task or the plan using `context.md` (with a **?** button on every task for "what is this and why"), and four more Claude-powered flows: Plan my day, SHTF (rebuild the day when it detonates), Avoiding (one ten-minute move to break resistance), and Breakdown (big vague project in, a full Todoist project of chunks and first actions out; only the first task gets a date, deliberately).
4. **Todoist** holds all the data. Strikes are ordinary labels (`gsd-strike-1/2/3`), the Pit is a project, `@reference` marks source material the system should never nag about, and `@outcome` marks week markers that are shown as context but never picked as tasks or struck. Nothing is locked in; delete this repo and your tasks are untouched.

**The no-padding rule.** The Three is drawn only from tasks actually due today or overdue. If one thing is due, you get one thing and a line saying the day is light. Future-dated and undated work is never promoted to fill the list, because a Three containing something due in three weeks is worse than a One that is true. On a light day the brief may offer a single undated item, clearly flagged as optional.

**Week outcomes.** Give a task the `@outcome` label and date it on the Monday of the week it describes, e.g. "Week of Aug 24: you can explain the business in your own words". Every brief then leads with that line, and the dashboard shows it at the top, so the day's tasks read as steps toward something rather than a loose list.

## Setup (about 20 minutes, no Claude access needed)

### 1. Get your two API keys

- **Todoist token**: Todoist → Settings → Integrations → Developer tab → copy API token.
- **Anthropic key**: [console.anthropic.com](https://console.anthropic.com) → sign up → API Keys → Create Key. Add a payment method and set a monthly spend limit (5 dollars is generous; typical GSD usage is well under 1 dollar a month).

### 2. Create the repo

1. On GitHub: New repository → name it `gsd` → **Public** (required for free GitHub Pages) → Create.
2. Upload everything in this folder (drag and drop works: "uploading an existing file"). Keep the folder structure — `.github/workflows/briefs.yml` must stay at that path. If drag-and-drop won't take the `.github` folder, create the file manually: Add file → Create new file → type `.github/workflows/briefs.yml` as the name and paste the contents.

Your keys are never in the repo. Public is safe.

### 3. Add the secrets

Repo → Settings → Secrets and variables → Actions → New repository secret. Add:

| Secret | Value |
|---|---|
| `TODOIST_TOKEN` | your Todoist API token |
| `ANTHROPIC_API_KEY` | your Anthropic key |
| `PUSHOVER_TOKEN` | the GSD application's API token from pushover.net (starts with `a`) |
| `PUSHOVER_USER` | your Pushover user key (starts with `u`) |
| `GMAIL_ADDRESS` | your Gmail address |
| `GMAIL_APP_PASSWORD` | see below |

Gmail app password: Google Account → Security → 2-Step Verification (must be on) → App passwords → create one named "GSD" → copy the 16-character password. If you skip the two Gmail secrets, everything still works, you just get push only.

### 4. Phone push

Sign up at [pushover.net](https://pushover.net), install the Pushover app on your phone, and log in. Your user key is on the pushover.net main page; create an application named "GSD" there to get the API token. One-time $5 purchase in the app after the 30-day trial. If the trial ends without the purchase, pushes stop but email keeps working.

### 5. Turn on Pages and Actions

- Repo → Settings → Pages → Source: "Deploy from a branch" → Branch: `main`, folder `/ (root)` → Save. Your dashboard will be at `https://<username>.github.io/gsd/`. Open it, tap the gear, paste your Todoist token and Anthropic key (they stay in your browser only). Add it to your phone home screen.
- Repo → Actions tab → enable workflows if prompted.

### 6. Test it

Actions tab → "GSD briefs" → Run workflow → mode: `morning` → Run. Within a minute or two your phone should buzz and an email should land. If the run fails, open it and read the log; the error messages are plain.

## Daily rhythm

The 7:37am brief tells you Today's Three with first actions. Work; use the dashboard timer and Done buttons, or just tick things in Todoist. The 2:47pm check-in shows what's done and asks what happens next. The 4:47pm review closes the day; unfinished P1/P2 tasks roll to tomorrow and take a strike. Three strikes and a task goes to the Pit of Doom, where it stops nagging you until you deliberately rescue it. Capture anything, any time, into the Inbox; the morning brief sorts it.

## Adjusting things

- **Times**: edit the three cron lines in `briefs.yml`. They're UTC; Ashburn is UTC-4 in summer, UTC-5 in winter, so briefs drift an hour later when clocks change unless you edit them each November/March.
- **Model**: default is `claude-sonnet-4-5`. Cheaper: set a `GSD_MODEL` env in the workflow (or model field in dashboard settings) to a Haiku model.
- **Weekends off**: change `* * *` to `* * 1-5` in the cron lines.
- **Strike rules**: all in `scripts/brief.mjs`, plainly commented.

## Costs

GitHub: free (public repo, Pages, ~90 Actions minutes/month, within free tier). Pushover: $5 once. Anthropic API: roughly 1-3 cents per brief with Sonnet, under a cent with Haiku. Todoist: your existing plan.
