'use strict';
const dns = require('node:dns/promises');
const http = require('node:http');
const https = require('node:https');
const ipaddr = require('ipaddr.js');

class MediaPolicyError extends Error {
  constructor(message, status = 403) { super(message); this.status = status; }
}

function publicAddress(address) {
  try {
    let parsed = ipaddr.parse(address);
    if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) parsed = parsed.toIPv4Address();
    return parsed.range() === 'unicast';
  } catch { return false; }
}

function createMediaPolicy({ allowedHosts = [], allowPrivate = false, lookup = dns.lookup } = {}) {
  const hosts = new Set(allowedHosts.map(host => host.trim().toLowerCase()).filter(Boolean));
  async function validate(raw) {
    let url;
    try { url = new URL(raw); } catch { throw new MediaPolicyError('Invalid media URL.', 400); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || raw.length > 4096)
      throw new MediaPolicyError('Only HTTP(S) media URLs without credentials are accepted.');
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!hosts.has(hostname)) throw new MediaPolicyError('This media host is not approved for relay.');
    if (!allowPrivate && url.port && !((url.protocol === 'https:' && url.port === '443') ||
        (url.protocol === 'http:' && url.port === '80')))
      throw new MediaPolicyError('Non-standard upstream ports are blocked.');
    let addresses;
    try { addresses = await lookup(hostname, { all: true, verbatim: true }); }
    catch { throw new MediaPolicyError('Media host resolution failed.', 502); }
    if (!addresses.length || addresses.some(item => !allowPrivate && !publicAddress(item.address)))
      throw new MediaPolicyError('Private, loopback, reserved and mixed DNS targets are blocked.');
    return { url, address: addresses[0].address, family: addresses[0].family };
  }

  // Resolution is validated once and then pinned into the actual socket lookup.
  // Every redirect is parsed, allow-listed and resolved again; automatic redirects are disabled.
  async function open(raw, { method = 'GET', range, signal, maxRedirects = 3 } = {}) {
    let current = raw;
    for (let redirects = 0; redirects <= maxRedirects; redirects++) {
      const resolved = await validate(current);
      const response = await new Promise((resolve, reject) => {
        const request = (resolved.url.protocol === 'https:' ? https : http).request(resolved.url, {
          method, agent: false, signal,
          headers: { 'accept-encoding': 'identity', ...(range ? { range } : {}) },
          lookup: (_hostname, options, callback) => {
            if (typeof options === 'function') { callback = options; options = {}; }
            if (options?.all) callback(null, [{ address: resolved.address, family: resolved.family }]);
            else callback(null, resolved.address, resolved.family);
          }
        }, resolve);
        request.setTimeout(30000, () => request.destroy(new Error('Media upstream timed out.')));
        request.on('error', reject);
        request.end();
      });
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.destroy();
        current = new URL(response.headers.location, resolved.url).toString();
        continue;
      }
      return { response, url: resolved.url.toString() };
    }
    throw new MediaPolicyError('Too many upstream redirects.', 502);
  }
  return { validate, open, enabled: hosts.size > 0 };
}

module.exports = { createMediaPolicy, publicAddress, MediaPolicyError };
