// Pure helper: extract guild/channel ids from a Discord channel URL.
// Maps the @me DM pseudo-guild to "dm" so it satisfies the backend's
// guild_id validation (^[A-Za-z0-9_-]{1,30}$).
function parseChannelUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return null;
  }
  if (u.hostname !== 'discord.com') return null;
  const m = u.pathname.match(/^\/channels\/(@me|\d+)\/(\d+)/);
  if (!m) return null;
  const guildId = m[1] === '@me' ? 'dm' : m[1];
  return { guildId, channelId: m[2] };
}

if (typeof module !== 'undefined') module.exports = { parseChannelUrl };
