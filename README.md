# Revise — spaced repetition for your notes

Upload the HTML and PDF notes you read and organise them into folders
(e.g. **Ghatna Chakra › Science › Biology**). Revise brings each file back
for revision on a schedule:

**Read today → 3 days → 10 days → 30 days → 60 days → every 60 days**

Everything is stored in this GitHub repo, so your phone and laptop always stay in sync.

## How revision works

When you open a file, rate it at the bottom:

| Button | What happens |
| --- | --- |
| **Hard** | It comes back tomorrow, and your place in the schedule stays the same |
| **Good** | It moves to the next gap (3 → 10 → 30 → 60) |
| **Easy** | It skips one gap |

- **Snooze** moves a due file to tomorrow without changing its progress.
- **Custom gaps:** use ⋮ → *Edit* on any file (e.g. `1, 3, 7, 21`), or set them while uploading. Leave the field blank to use the default.
- **Default gaps:** change them in ⚙️ Settings. Files with their own custom gaps keep them.
- **Mastered:** use ⋮ → *Mark as mastered* to stop reminders for a file.
- **Next date:** you can also set a file's next revision date by hand.

## One-time setup

1. **Turn on GitHub Pages:** repo **Settings → Pages → Build and deployment →
   Source: Deploy from a branch → Branch: `main` / `(root)` → Save**.
   After about a minute the app is live at `https://<your-username>.github.io/<repo-name>/`.
2. **Create a token:** go to <https://github.com/settings/personal-access-tokens/new>.
   - *Repository access:* **Only select repositories** → this repo
   - *Permissions:* Repository → **Contents: Read and write**
   - Click *Generate token* and copy it.
3. **Connect:** open the app, paste the token, and press **Connect**. Do this once on each
   device (phone, laptop). The token is stored only in that browser.
4. **Install it on your phone (optional):** browser menu → *Add to Home screen*.

## Daily reminder

The workflow in `.github/workflows/reminder.yml` runs every morning at 07:45 IST. If
anything is due, it opens an issue listing the files with links that open them directly,
and GitHub notifies you by email and in the GitHub mobile app. Yesterday's
reminder issue is closed automatically.

- **Test it:** **Actions → Daily revision reminder → Run workflow**.
- **Change the time:** edit the `cron` line in the workflow.

## Where things are stored

| Path | What |
| --- | --- |
| `files/` | Your uploaded HTML / PDF files |
| `data/srs.json` | Folders, schedules and revision history |
| `index.html` | The whole app (no build step) |

> ⚠️ On a free GitHub plan, Pages only works on **public** repos, so anyone with the link can see
> the files in `files/`. Don't upload anything private.

Uploaded HTML files are shown in a sandbox, so scripts inside a note can't read your token.
Files must be under 45 MB.
