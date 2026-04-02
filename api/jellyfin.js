const axios = require('axios');

const BASE = () => process.env.JELLYFIN_URL.replace(/\/$/, '');
const HEADERS = () => ({
  'X-Emby-Token': process.env.JELLYFIN_API_KEY,
  'Content-Type': 'application/json',
});

/**
 * Create a new Jellyfin user.
 * The account is created enabled by default; call setUserPolicy to disable it.
 * Returns { Id, Name }
 */
async function createUser(username, password) {
  const res = await axios.post(
    `${BASE()}/Users/New`,
    { Name: username, Password: password },
    { headers: HEADERS() }
  );
  return res.data; // { Id, Name, ... }
}

/**
 * Set the IsDisabled policy flag on a Jellyfin user.
 * Must first fetch the current policy to avoid overwriting other fields.
 */
async function setUserPolicy(jellyfinId, disabled) {
  // Fetch current user object which contains Policy
  const userRes = await axios.get(`${BASE()}/Users/${jellyfinId}`, { headers: HEADERS() });
  const policy = { ...userRes.data.Policy, IsDisabled: disabled };

  await axios.post(
    `${BASE()}/Users/${jellyfinId}/Policy`,
    policy,
    { headers: HEADERS() }
  );
}

/**
 * Set (reset) a user's password.
 * Jellyfin requires the current password for non-admin resets, but admins
 * calling this via API key can omit it.
 */
async function setPassword(jellyfinId, newPassword) {
  await axios.post(
    `${BASE()}/Users/${jellyfinId}/Password`,
    { CurrentPw: '', NewPw: newPassword, ResetPassword: false },
    { headers: HEADERS() }
  );
}

/**
 * Permanently delete a Jellyfin user.
 */
async function deleteUser(jellyfinId) {
  await axios.delete(`${BASE()}/Users/${jellyfinId}`, { headers: HEADERS() });
}

/**
 * List all Jellyfin users (admin API).
 * Returns an array of user objects, each with at minimum { Id, Name, Policy }.
 */
async function listUsers() {
  const res = await axios.get(`${BASE()}/Users`, { headers: HEADERS() });
  return Array.isArray(res.data) ? res.data : [];
}

/**
 * Get library item counts from Jellyfin.
 * Returns { MovieCount, SeriesCount, EpisodeCount, MusicAlbumCount, SongCount, ... }
 */
async function getItemCounts() {
  const res = await axios.get(`${BASE()}/Items/Counts`, { headers: HEADERS() });
  return res.data;
}

module.exports = { createUser, setUserPolicy, setPassword, deleteUser, listUsers, getItemCounts };
