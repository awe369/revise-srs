// Google sign-in for the extension (chrome.identity web auth flow, token in local storage).
// The manifest's fixed "key" keeps the extension ID — and so the redirect URL Google checks — the same
// for everyone who loads this folder: https://lmagcfmilnehgfjbcepfnigdhhoiieae.chromiumapp.org/

import { GOOGLE_CLIENT_ID, DRIVE_SCOPE } from './lib/google-config.js';
import { DriveError } from './lib/drive.js';

async function authorize(interactive) {
  const { gemail = '' } = await chrome.storage.local.get('gemail');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    response_type: 'token',
    redirect_uri: chrome.identity.getRedirectURL(),
    scope: DRIVE_SCOPE,
    include_granted_scopes: 'true',
    ...(interactive ? { prompt: 'select_account' } : { prompt: 'none' }),
    ...(gemail ? { login_hint: gemail } : {}),
  });
  let redirect;
  try {
    redirect = await chrome.identity.launchWebAuthFlow({ url: url.href, interactive });
  } catch (e) {
    throw new DriveError(401, interactive ? `Google sign-in was cancelled (${e.message})` : 'Sign in with Google to sync your cards.');
  }
  const p = new URLSearchParams(new URL(redirect).hash.slice(1));
  if (!p.get('access_token')) throw new DriveError(401, p.get('error') === 'interaction_required' || p.get('error') === 'login_required'
    ? 'Sign in with Google to sync your cards.' : `Google sign-in failed: ${p.get('error') || 'no token'}`);
  const gtoken = { token: p.get('access_token'), exp: Date.now() + (Number(p.get('expires_in')) || 3600) * 1000 };
  await chrome.storage.local.set({ gtoken, gsignedIn: true });
  return gtoken.token;
}

/** A valid access token; silently renews it while the user stays signed in to Google. */
export async function getGoogleToken(interactive = false) {
  if (!GOOGLE_CLIENT_ID) throw new DriveError(401, 'Google Drive is not set up in this copy of the extension yet (no client ID).');
  const { gtoken, gsignedIn } = await chrome.storage.local.get(['gtoken', 'gsignedIn']);
  if (!interactive && gtoken && gtoken.exp > Date.now() + 60_000) return gtoken.token;
  if (!interactive && !gsignedIn) throw new DriveError(401, 'Sign in with Google to sync your cards.');
  return authorize(interactive);
}

export async function dropGoogleToken() {
  await chrome.storage.local.remove('gtoken');
}

export async function signInGoogle(email) {
  const token = await getGoogleToken(true);
  if (email) await chrome.storage.local.set({ gemail: email });
  return token;
}

export async function signOutGoogle() {
  const { gtoken } = await chrome.storage.local.get('gtoken');
  if (gtoken?.token) fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(gtoken.token)}`, { method: 'POST' }).catch(() => {});
  await chrome.storage.local.remove(['gtoken', 'gsignedIn', 'gemail']);
}
