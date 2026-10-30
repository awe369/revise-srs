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

## Highlights, notes and more

- **Highlight (HTML and PDF):** select text while reading (long-press on a phone). A small bar appears: pick a colour
  (yellow / green / blue / pink) or ✎ to add a note. Tap a highlight to recolour it, add a note or remove it.
  The 🖍 button in the reader lists all highlights, with *Go to*. PDF highlights remember their page number.
  Scanned PDFs (pages that are just images) have no text, so they can't be highlighted — use 📝 notes for those.
- **Highlights file:** use 🖍 → **Make highlights file** (or a folder's options) to collect every
  highlight and note into a new file, e.g. *biofertilizers — Highlights*. It goes into your library and
  comes up for revision like any other file. Run it again later to update it; its schedule stays the same.
- **Notes:** the 📝 button keeps your own notes for any file, HTML or PDF.
- **Resume reading:** each file reopens where you stopped.
- **Upload a whole folder** from a laptop (button or drag & drop). Sub-folders are created automatically.
- **Max files per day** (⚙️ Settings): new dates are spread out, and a backlog can be spread over the next days.
- **Offline:** open a folder's options → *Save for offline reading*. Revisions you make offline are saved
  when you're back online.
- **Stats tab:** revision activity, Hard/Good/Easy mix per subject, and your toughest files.

## Cloze cards from any website 🧠

Make Anki-style fill-in-the-blank cards from **any website** with the Chrome extension in `extension/`,
and review them in the **Cloze** tab (bottom right) — `https://<your-username>.github.io/<repo-name>/cloze/`.

- Select text on any page → click **[…] Cloze** (or press **Alt+Shift+C**). The selected word is hidden inside its
  sentence; click more words to hide them too. **Ctrl+Enter** saves to `data/cloze.json`.
- Schedule: **1 → 3 → 7 → 15 → 30 → 60 → 120 → 240 days**, then doubling. *Again* / *Hard* / *Good* / *Easy*.
- **Anki:** cards can also be saved into Anki automatically (AnkiConnect add-on, note type *ClozeForge* that looks
  like the site) — made, edited and deleted cards stay in sync. See [`extension/README.md`](extension/README.md#anki).
- **Open source** opens the original page at the exact sentence — with the answer **still hidden there** (blue boxes; click one to peek).
- **Storage:** your own **Google Drive** (sign in with Google — anyone can use it, each person's cards go to their
  own Drive) or this GitHub repo (uses the same token as Revise; due cloze cards then also appear in the morning
  Telegram / WhatsApp reminder). Google Drive needs a one-time setup — see
  [`extension/README.md`](extension/README.md#google-drive-setup-one-time-by-the-site-owner--10-minutes).

**Install the extension:** Code → *Download ZIP* → unzip → `chrome://extensions` → turn on **Developer mode** →
**Load unpacked** → choose the `extension` folder → paste your token in the page that opens → *Save & test*.
Details: [`extension/README.md`](extension/README.md).

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

## Daily reminder on Telegram or WhatsApp (7:00 AM)

1. In Telegram, open **@BotFather**, send `/newbot`, and pick a name. Copy the **bot token** it gives you.
2. Open your new bot and press **Start**, so it is allowed to message you.
3. Get your **chat ID**: open **@userinfobot** in Telegram and press Start. It replies with your ID (a number).
4. In this repo, go to **Settings → Secrets and variables → Actions → New repository secret** and add:
   - `TELEGRAM_BOT_TOKEN` = the bot token
   - `TELEGRAM_CHAT_ID` = your chat ID
5. Test it: **Actions → Daily revision reminder → Run workflow**. You should get a message within a minute.

### WhatsApp instead of (or as well as) Telegram

WhatsApp has no free official way to send yourself messages, so this uses **CallMeBot**, a free
third-party service for personal use. It's run by someone else and can sometimes be slow or down, and it
sees the message text (file names and links).

1. Get CallMeBot's current WhatsApp number from <https://www.callmebot.com/blog/free-api-whatsapp-messages/>
   and save it in your phone contacts.
2. Send it this exact WhatsApp message: `I allow callmebot to send me messages`.
   It replies with your **API key**. If no reply comes within 2 minutes, wait a day and try again (the
   service limits sign-ups).
3. Add two repository secrets: `WHATSAPP_PHONE` = your number with country code (e.g. `+919876543210`)
   and `WHATSAPP_APIKEY` = the key.
4. Test with **Actions → Daily revision reminder → Run workflow**.

If both Telegram and WhatsApp secrets are set, you get both messages. Delete the Telegram secrets to
stop the Telegram message.

Each morning the message lists what's due, and each name is a link that opens that file. GitHub sometimes
starts scheduled runs a few minutes late. Without the Telegram secrets, the workflow falls back to opening a
GitHub issue each morning, so GitHub notifies you instead.

## Where things are stored

| Path | What |
| --- | --- |
| `files/` | Your uploaded HTML / PDF files |
| `data/srs.json` | Folders, schedules and revision history |
| `data/notes/` | Highlights and notes, one file per note |
| `data/cloze.json` | Cloze cards and their review history |
| `cloze/`, `extension/` | Cloze review page and the Chrome extension |
| `index.html` | The whole app (no build step) |

> ⚠️ On a free GitHub plan, Pages only works on **public** repos, so anyone with the link can see
> the files in `files/`. Don't upload anything private.

Uploaded HTML files are shown in a sandbox, so scripts inside a note can't read your token.
Files must be under 45 MB.
