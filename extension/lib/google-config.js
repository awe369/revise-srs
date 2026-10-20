// Google sign-in for "save cards in my own Google Drive".
// One OAuth client (a "Web application" client in Google Cloud) serves both the website and the extension.
// Setup steps: extension/README.md → "Google Drive setup". Paste the client ID below.

export const GOOGLE_CLIENT_ID = '';

// drive.file = the app can only see files it created itself (never the rest of your Drive).
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const DRIVE_FOLDER = 'ClozeForge';
export const DRIVE_FILE = 'cloze-cards.json';

export const googleReady = () => !!GOOGLE_CLIENT_ID;
