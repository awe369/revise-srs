# ClozeForge

Make Anki-style **cloze cards from any website**, save them to this repo (`data/cloze.json`), and review them in the **Cloze** tab of the Revise app with a fixed-ladder spaced-repetition schedule: **1 → 3 → 7 → 15 → 30 → 60 → 120 → 240 days, then ×2**.

```
extension/   Chrome extension (Manifest V3) — capture cards on any page
  lib/       shared core (cloze parser, scheduler, deck merge, GitHub storage) — also used by the site
cloze/       review page, served by GitHub Pages at https://<user>.github.io/<repo>/cloze/
tests/       node --test tests/*.test.mjs
```

## Setup (5 minutes)

1. Revise must already be connected (GitHub Pages on, token pasted — see the main README).
   The Cloze page reuses that token automatically.
2. **Install the extension**: download this repo (Code → Download ZIP) and unzip it → open `chrome://extensions` →
   enable *Developer mode* → *Load unpacked* → pick the `extension` folder. The options page opens with user and
   repo already filled in: paste your token (the same one, or a new one with *Contents: Read and write*) →
   *Save & test connection*.
3. Open the **Cloze** tab in Revise (or `https://<user>.github.io/<repo>/cloze/`).

## Google Drive setup (one time, by the site owner — ~10 minutes)

With this done, **anyone** can use the extension and the review site: each person signs in with Google and their
cards go to **their own** Google Drive (`ClozeForge/cloze-cards.json`). The app only asks for the `drive.file`
permission, so it can see only the file it created — nobody else's data ever passes through you.

1. Open <https://console.cloud.google.com/> → project picker (top left) → **New project** → name `ClozeForge` → **Create**,
   and make sure it's selected.
2. Turn on the Drive API: <https://console.cloud.google.com/apis/library/drive.googleapis.com> → **Enable**.
3. Sign-in screen: <https://console.cloud.google.com/auth/overview> → **Get started**
   - App name `ClozeForge`, your email → **Next** → Audience **External** → **Next** → your email → agree → **Create**.
   - **Data access** → **Add or remove scopes** → search `drive.file` → tick `…/auth/drive.file` → **Update** → **Save**.
   - **Audience** → **Publish app** → **Confirm**, so anyone can sign in. (`drive.file` is a non-sensitive scope, so
     Google doesn't require a review. If you'd rather keep it in *Testing*, add each user's Gmail under *Test users*.)
4. **Clients** → **Create client** → type **Web application** → name `ClozeForge`
   - **Authorized JavaScript origins**: `https://awe369.github.io`
   - **Authorized redirect URIs**: `https://lmagcfmilnehgfjbcepfnigdhhoiieae.chromiumapp.org/`
     (the extension's fixed ID, set by `"key"` in `manifest.json`)
   - **Create** and copy the **Client ID** (`….apps.googleusercontent.com`). It is not a secret; no client secret is needed.
5. Paste it into `extension/lib/google-config.js` (`GOOGLE_CLIENT_ID = '…'`) and push. Privacy page for the
   consent screen, if asked: `https://awe369.github.io/revise-srs/cloze/privacy.html`.

Until a client ID is set, everything keeps using GitHub as before.

**For other people:** download this repo's ZIP → `chrome://extensions` → Developer mode → *Load unpacked* →
`extension` folder → **Sign in with Google** in the page that opens. Review at
`https://awe369.github.io/revise-srs/cloze/` and sign in there with the same Google account.

## Making cards

Select text on any page, then either click the floating **[…] Cloze** button, right-click → *Make cloze card*,
or press **Alt+Shift+C**.

- A short selection is automatically placed in its **sentence** with the selection already hidden.
  Switch to *Selection* / *Paragraph* to change how much context the card shows.
- **Click any word** in the preview to hide it (new cloze number = separate card). **Shift-click** to add it to the
  previous number (hidden together). Click a hidden word to un-hide it.
- In the text box, select text and press **Ctrl+Shift+C** (Anki's shortcut). Hints: `{{c1::answer::hint}}`.
- **Ctrl+Enter** saves. Offline or not configured yet? The card waits in an outbox and syncs later.

Every card stores the page URL plus a [text-fragment link](https://developer.mozilla.org/docs/Web/URI/Fragment/Text_fragments)
(`#:~:text=…`), so **Open source** jumps straight to — and highlights — the exact sentence.
**View here** loads the page beside the card (some sites forbid embedding; then use *Open source*).

## Quiz on the source page

With the extension installed, **Open source** (or clicking the source chip, or **O**) on the review page opens the
original page with **this card's answer hidden there too**: every place the answer appears is covered by a blue box,
the one in your sentence is darker and scrolled into view. Key words of a multi-word answer are hidden as well (so
the page title can't give "Manipur (Mount Harriet)" away). Click a box to peek at it, or use **Show answer** in the
small panel. **View here** (the side panel) does the same. Reloading the page shows it normally. Without the
extension (e.g. on a phone) the link just opens the page.

## Scheduling

Each cloze number is reviewed on its own.

| Button | Effect |
|---|---|
| **Again** | shows it again in 10 minutes and restarts the ladder |
| **Hard**  | repeats the current interval |
| **Good**  | one rung up: 1 → 3 → 7 → 15 → 30 → 60 → … days |
| **Easy**  | two rungs up |

*Overdue credit* (on by default): if you review a card late and still remember it, it climbs past every rung the
gap already proved — e.g. a 3-day card recalled after 20 days goes straight to 30 days.
The ladder, growth factor, new-cards-per-day limit and optional ±5% spread are editable on the site's Settings page
and sync to all devices.

Keyboard on the review page: **Space** reveal · **1–4** grade · **O** open source · **V** view beside · **E** edit ·
**Z** undo · **S** sync · **?** help.

## Storage & sync

**Google Drive** (default once set up): one JSON file per person, `ClozeForge/cloze-cards.json` in their own Drive.
Writes re-check the file's version right before uploading and retry on a change. Switching from GitHub to Drive
copies your existing cards across on the first sign-in (Settings also has *Copy them from GitHub*).

**GitHub**: all cards live in one JSON file, `data/cloze.json` on `main` (next to Revise's `data/srs.json`; branch and path
can be changed in the extension options and the Cloze settings). Every write is read → merge → write with the file's
SHA, retried on conflict. The merge is per card (newest edit wins) and per cloze (newest review wins, review logs
are unioned), so the extension, the site and several devices can all work offline and sync safely.

**Privacy:** if the repo is public, so are your cards. Use a private repo for private notes (the site then needs the
token to read them). Tokens are stored only locally (extension storage / browser storage of the site).

## Limitations

- Chrome's built-in PDF viewer, `chrome://` pages and the Chrome Web Store don't allow extensions.
- Text-fragment links depend on the page still containing the text; otherwise the page opens at the top.
