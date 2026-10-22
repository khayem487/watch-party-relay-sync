'use strict';
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

function jsonError(res, status, message) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error: message }));
}
function createProxyHandler(policy, rewritePlaylist) {
  let active = 0;
  return async function handleProxy(req, res, parsed) {
    if (!['GET', 'HEAD'].includes(req.method)) return jsonError(res, 405, 'Use GET or HEAD.');
    const target = parsed.searchParams.get('url');
    if (!target) return jsonError(res, 400, 'Missing media URL.');
    if (req.headers.range && !/^bytes=\d*-\d*$/.test(req.headers.range))
      return jsonError(res, 400, 'Only a single byte range is supported.');
    if (active >= 4) return jsonError(res, 429, 'Media relay is busy. Try again shortly.');
    active++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', abort);
    try {
      const { response: upstream, url } = await policy.open(target, {
        method: req.method, range: req.headers.range, signal: controller.signal
      });
      const type = String(upstream.headers['content-type'] || 'application/octet-stream').toLowerCase();
      const playlist = type.includes('mpegurl') || new URL(url).pathname.toLowerCase().endsWith('.m3u8');
      if (!playlist && !/^(video\/|audio\/|application\/(octet-stream|ogg)|text\/vtt)/.test(type)) {
        upstream.destroy();
        return jsonError(res, 415, 'The approved endpoint did not return a supported media type.');
      }
      if (req.method === 'HEAD') {
        res.writeHead(upstream.statusCode, { 'content-type': type });
        upstream.destroy(); res.end(); return;
      }
      if (playlist) {
        const chunks = []; let size = 0;
        for await (const chunk of upstream) {
          size += chunk.length;
          if (size > 1024 * 1024) { upstream.destroy(); return jsonError(res, 413, 'Playlist is too large.'); }
          chunks.push(chunk);
        }
        const body = Buffer.concat(chunks).toString('utf8');
        if (upstream.statusCode !== 200 || !body.trimStart().startsWith('#EXTM3U'))
          return jsonError(res, 502, 'The endpoint did not return a valid playlist.');
        const result = rewritePlaylist(body, url);
        res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl; charset=utf-8',
          'content-length': Buffer.byteLength(result), 'cache-control': 'no-store' });
        res.end(result); return;
      }
      res.statusCode = upstream.statusCode;
      for (const name of ['content-type', 'content-length', 'accept-ranges', 'content-range', 'last-modified'])
        if (upstream.headers[name]) res.setHeader(name, upstream.headers[name]);
      let transferred = 0;
      const limiter = new Transform({
        transform(chunk, _encoding, callback) {
          transferred += chunk.length;
          callback(transferred > 64 * 1024 * 1024 ? new Error('Media relay byte limit exceeded.') : null, chunk);
        }
      });
      await pipeline(upstream, limiter, res);
    } catch (error) {
      jsonError(res, error.status || 502, error.status ? error.message : 'Media relay failed or timed out.');
    } finally {
      active--;
      clearTimeout(timer);
      res.off('close', abort);
    }
  };
}
module.exports = { createProxyHandler };
