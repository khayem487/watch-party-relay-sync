# Publish the actual Watch Party application

The actual application is live at **https://khayem-watch-party.vercel.app/**. On 26 October 2026, public browser checks verified real video playback, pause, seek and bidirectional chat between two distinct Vercel deployments sharing Upstash Redis over TLS. Reloading the second visitor restored the exact paused position and continuing chat. These checks are separate from the 13 passing Redis CI tests.

The deployment uses Upstash **Free**, a single database in Frankfurt, with eviction disabled. Its credentials are encrypted server variables for **Production only**. The Vercel container also runs in `fra1`. No paid plan, card, Preview/Development database connection or wider GitHub App access was added. The following checklist describes setup for another installation and the public demo's operating limits.

## Configuration to supply

1. A native Redis service offering a TLS `rediss://` URL, commands including `EVAL` and sorted sets, and Pub/Sub. An HTTP-only REST token is not a replacement for the native connection URL.
2. Add that URL to the hosting platform as the encrypted server variable `REDIS_URL`. Do not put it in source, shell history, build arguments, screenshots or README examples with real credentials. Keep development/test and production databases or namespaces separate.
3. Optionally set a unique `REDIS_PREFIX`. Leave `MEDIA_ALLOWED_HOSTS` empty for the first direct-video deployment. `ALLOW_PRIVATE_MEDIA` and `ENABLE_LOCAL_SUBTITLES` must remain false in public hosting.

The existing official Vercel GitHub application permission does not cover this repository. A manual CLI deployment can use the prepared source without expanding that permission. Creating a new provider account or accepting a provider's terms is a separate account action; the code does not perform it.

## Before production publication

- Run the GitHub Actions test workflow, which uses an isolated official Redis 8 service on its Linux runner. Alternatively, supply a dedicated test Redis endpoint as `TEST_REDIS_URL` and run `npm test`. Both integration tests must run rather than skip. The process test starts two independent HTTP/WebSocket servers and restarts one of them while keeping the other alive. The CI service is temporary and does not create a production Redis resource or test production TLS.
- Confirm that the chosen Vercel project supports the container/WebSocket runtime. `vercel.json` routes every request to `Dockerfile.vercel`; the container requires shared Redis and cannot silently use memory.
- Publish manually from the reviewed branch, with production environment variables already configured. A build marked READY is only the start of the verification.

## Verify the actual public deployment

- `/health` must return HTTP 200, `roomStore: "redis"` and `multiInstance: true`; `/api/config` must agree. Proxy and local subtitle capabilities should remain disabled.
- Use two real visitors in one generated room and play the sample video, pause, seek and chat. Each viewer may need to click Play once because of browser autoplay rules.
- Verify visitors routed to two distinct cloud instances, or two isolated preview deployments using a dedicated shared test namespace. Two browser tabs by themselves do not establish a multi-instance test.
- Force an actual reconnect or a new deployment, then confirm paused room state and continuing chat. A room TTL of one hour and presence leases of 70 seconds remain deliberate limits.
- Test that an unrelated room does not receive the messages and that no configured Redis secret appears in public responses or logs.

Vercel WebSocket connections are tied to one function instance and can end at its duration limit. The existing browser reconnection path and shared state address that lifecycle; they do not make a perpetual connection or promise unlimited availability. See [Vercel's WebSocket guide](https://vercel.com/kb/guide/real-time-chat-websockets) and [Container Runtime](https://vercel.com/docs/functions/runtimes/container).

The official documentation currently lists both Container Runtime and Fluid WebSockets as beta features available on all plans. Hobby WebSocket connections have a maximum lifetime of 300 seconds, so reconnecting is part of normal operation.

Before accepting a Redis provider's offer, confirm that its **free plan includes native TLS**. In particular, [Redis Cloud's TLS documentation](https://redis.io/docs/latest/operate/rc/security/database-security/tls-ssl/) says that TLS is unavailable on Free Redis Cloud Essentials plans. That free offer cannot satisfy the cloud `rediss://` requirement. A provider must support the required commands and RESP3 as well as TLS; do not disable transport security or silently select a paid plan to get past this requirement.

Media is played directly from a permitted public URL. Hosting the server does not make a visitor's local Stremio endpoint accessible to other visitors. No public proxy of private addresses is enabled by this deployment.
