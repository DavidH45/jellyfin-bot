const axios = require('axios');

const BASE = () => process.env.JELLYSEERR_URL.replace(/\/$/, '');
const HEADERS = () => ({
  'X-Api-Key': process.env.JELLYSEERR_API_KEY,
  'Content-Type': 'application/json',
});

/**
 * Import a list of Jellyfin user IDs into Jellyseerr.
 * Uses POST /user/import/from/jellyfin (Jellyseerr/Overseerr API).
 *
 * Returns array of created/existing Jellyseerr user objects.
 * Each object contains at least { id, jellyfinUserId, username, ... }
 */
async function importFromJellyfin(jellyfinUserIds) {
  // Try all known Jellyseerr/Overseerr path variants
  const paths = [
    `${BASE()}/api/v1/user/import-from-jellyfin`,   // Jellyseerr hyphenated (most common)
    `${BASE()}/api/v1/user/import/from/jellyfin`,   // slash-path variant
    `${BASE()}/user/import-from-jellyfin`,          // no api/v1 prefix hyphenated
    `${BASE()}/user/import/from/jellyfin`,          // no api/v1 prefix slash-path
  ];

  // Jellyseerr expects { jellyfinUserIds: [...] } as the request body
  const body = { jellyfinUserIds };

  let lastErr;
  for (const url of paths) {
    try {
      const res = await axios.post(url, body, { headers: HEADERS() });
      return Array.isArray(res.data) ? res.data : [];
    } catch (err) {
      // Only retry on 404; any other error (auth, network, validation) should throw immediately
      if (err?.response?.status !== 404) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

module.exports = { importFromJellyfin };
