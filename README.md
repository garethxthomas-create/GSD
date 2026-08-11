# GSD — Getting Stuff Done

A standalone version of the GSD system. Todoist is the source of truth, Claude (via the Anthropic API) is the brain, GitHub runs everything. No server, no subscription required.

Three parts, one repo:

1. **The briefs** (`.github/workflows/briefs.yml` + `scripts/brief.mjs`). GitHub Actions runs three times a day: a morning brief at 8:00am (picks Today's Three, applies strikes to overdue tasks, sends the plan), a 2:30pm check-in, and a 5:00pm evening review (rolls unfinished priorities to tomorrow with a strike; three strikes sends a task to the Pit of Doom). Each brief arrives as a phone push (ntfy) and an email.
2. **The dashboard** (`index.html`, served by GitHub Pages). Today's Three, a focus timer with a 90-minute daily target, Done buttons that close tasks in Todoist, a capture box that feeds the Inbox, and three Claude-powered flows: Plan my day, SHTF (rebuild the day when it detonates), and Avoiding (one ten-minute move to break resistance).
3. **Todoist** holds all the data. Strikes are ordinary labels (`gsd-strike-1/2/3`), the Pit is a project, `@reference` marks bookmarks the system should ignore. Nothing is locked in; delete this repo and your tasks are untouched.

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
| `NTFY_TOPIC` | a private, unguessable topic name you invent, e.g. `gsd-gareth-x7k2m9` |
| `GMAIL_ADDRESS` | your Gmail address |
| `GMAIL_APP_PASSWORD` | see below |

Gmail app password: Google Account → Security → 2-Step Verification (must be on) → App passwords → create one named "GSD" → copy the 16-character password. If you skip the two Gmail secrets, everything still works, you just get push only.

### 4. Phone push

Install the **ntfy** app (iOS/Android, free) → subscribe to the exact topic name you put in `NTFY_TOPIC`. Anyone who knows the topic name can see the messages, which is why it should be unguessable.

### 5. Turn on Pages and Actions

- Repo → Settings → Pages → Source: "Deploy from a branch" → Branch: `main`, folder `/ (root)` → Save. Your dashboard will be at `https://<username>.github.io/gsd/`. Open it, tap the gear, paste your Todoist token and Anthropic key (they stay in your browser only). Add it to your phone home screen.
- Repo → Actions tab → enable workflows if prompted.

### 6. Test it

Actions tab → "GSD briefs" → Run workflow → mode: `morning` → Run. Within a minute or two your phone should buzz and an email should land. If the run fails, open it and read the log; the error messages are plain.

## Daily rhythm

8:00am brief tells you Today's Three with first actions. Work; use the dashboard timer and Done buttons, or just tick things in Todoist. 2:30pm check-in shows what's done and asks what happens next. 5:00pm review closes the day; unfinished P1/P2 tasks roll to tomorrow and take a strike. Three strikes and a task goes to the Pit of Doom, where it stops nagging you until you deliberately rescue it. Capture anything, any time, into the Inbox; the morning brief sorts it.

## Adjusting things

- **Times**: edit the three cron lines in `briefs.yml`. They're UTC; Ashburn is UTC-4 in summer, UTC-5 in winter, so briefs drift an hour later when clocks change unless you edit them each November/March.
- **Model**: default is `claude-sonnet-4-5`. Cheaper: set a `GSD_MODEL` env in the workflow (or model field in dashboard settings) to a Haiku model.
- **Weekends off**: change `* * *` to `* * 1-5` in the cron lines.
- **Strike rules**: all in `scripts/brief.mjs`, plainly commented.

## Costs

GitHub: free (public repo, Pages, ~90 Actions minutes/month, within free tier). ntfy: free. Anthropic API: roughly 1-3 cents per brief with Sonnet, under a cent with Haiku. Todoist: your existing plan.
