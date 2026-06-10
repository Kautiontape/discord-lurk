const { test } = require('node:test');
const assert = require('node:assert');
const { parseChannelUrl } = require('../lib/parse.js');

test('parses a guild channel url', () => {
  assert.deepStrictEqual(
    parseChannelUrl('https://discord.com/channels/123/456'),
    { guildId: '123', channelId: '456' });
});

test('maps @me DM to guild "dm"', () => {
  assert.deepStrictEqual(
    parseChannelUrl('https://discord.com/channels/@me/789'),
    { guildId: 'dm', channelId: '789' });
});

test('ignores trailing path segments', () => {
  assert.deepStrictEqual(
    parseChannelUrl('https://discord.com/channels/123/456/999888'),
    { guildId: '123', channelId: '456' });
});

test('returns null when no channel in url', () => {
  assert.strictEqual(parseChannelUrl('https://discord.com/channels/123'), null);
});

test('returns null for non-discord host', () => {
  assert.strictEqual(parseChannelUrl('https://example.com/channels/1/2'), null);
});

test('returns null for garbage', () => {
  assert.strictEqual(parseChannelUrl('not a url'), null);
});
