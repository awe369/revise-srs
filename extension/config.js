// Extension settings. Repo details sync across your Chrome profiles; the token stays on this device.

export const DEFAULT_CONFIG = {
  owner: 'awe369',
  repo: 'revise-srs',
  branch: 'main',
  path: 'data/cloze.json',
  siteUrl: '',          // review website; derived from owner/repo when empty
  floatingButton: true, // show the "Cloze" pill when text is selected
};

export async function getConfig() {
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get(DEFAULT_CONFIG),
    chrome.storage.local.get({ token: '' }),
  ]);
  return { ...DEFAULT_CONFIG, ...sync, token: local.token };
}

export async function setConfig({ token, ...rest }) {
  await chrome.storage.sync.set(rest);
  if (token !== undefined) await chrome.storage.local.set({ token });
}

export function siteUrlFor(cfg) {
  if (cfg.siteUrl) return cfg.siteUrl;
  if (!cfg.owner || !cfg.repo) return '';
  const owner = cfg.owner.toLowerCase();
  // A repo named <owner>.github.io is served from the root.
  return cfg.repo.toLowerCase() === `${owner}.github.io`
    ? `https://${owner}.github.io/cloze/`
    : `https://${owner}.github.io/${cfg.repo}/cloze/`;
}
