# Channels: Slack on Bun (the first channel)

> Implements the **Channel** concept from [`SPEC.md` §4A](../SPEC.md). A channel is a
> pluggable adapter at the *edge* of a flow — how a run is triggered (**ingress**) and how
> the flow talks back to a human or system (**egress**: status, HITL, alerts, delivery).
> Channels are not stations: stations transform work; channels move it across the flow's
> boundary.

Slack is our first channel because a customer's ad-factory flow already lives in Slack. We build
it on **`Bun.serve` and `fetch` — no web framework** (no Express/Hono). Bun's native HTTP
server, `crypto`, and `Bun.spawn` are all we need.

---

## 0. What "Slack channel" means for a flow

A single `flow.yaml` channel binding wires Slack to both edges:

```yaml
channels:
  ingress:                       # optional (egress-first MVP can omit)
    type: slack
    channel: C-CAMPAIGNS         # the watched channel id
    auth: { type: signing }      # Events API: request-signing verification
    event_id: { from: json_path, path: $.event_id }
  # or, for deployments with no public edge (§2A) — Socket Mode:
  #   type: slack
  #   transport: socket
  #   channel: C-CAMPAIGNS
  #   app_token_env: SLACK_APP_TOKEN   # xapp-…, connections:write; replaces `auth`
  #   event_id: { from: json_path, path: $.event_id }
  egress:
    - type: slack
      token_env: SLACK_BOT_TOKEN
      target: "#campaigns"
      uses: [status, hitl, alerts, delivery]   # any subset
```

Ingress has two **transports** carrying the same Slack event envelopes: `events` (the
default — Events API webhooks, needs a public HTTPS endpoint, §2) and `socket` (Socket
Mode — an outbound websocket, zero inbound reachability, §2A). `auth` is required with
`events`; `app_token_env` is required with (and only legal with) `socket` — the binding
validator rejects mixed shapes at boot, like any other config error.

| Edge | Slack mechanism | Conduit use |
|---|---|---|
| **Ingress** | Events API (`event_callback`) → webhook, *or* the same envelopes over a Socket Mode websocket (§2A) | a message becomes a parent card's substrate → `conduit run` |
| **Egress: status** | `chat.postMessage` into a per-run thread | mirror the journal (genba / War Room) |
| **Egress: hitl** | Block Kit interactive message + Interactivity webhook | a `hold` lane asks a human; the reply maps back to the card |
| **Egress: alerts** | `chat.postMessage` | andon / liveness-watchdog / scrap notifications |
| **Egress: delivery** | `chat.postMessage` (link) or the `files.getUploadURLExternal → completeUploadExternal` external-upload sequence (a station's `deliver:` block) | hand off the Meta CSV / a link, or a produced file straight into the triggering thread |

**MVP scope:** egress-first. Trigger runs from the CLI, use Slack for status/HITL/delivery.
Add ingress (the webhook) when you want hands-off triggering. See §6.

---

## 1. The Channel contract

The kernel never knows it's talking to Slack. It talks to a small interface; Slack is one
implementation (CLI, webhook, email are others).

```ts
// The kernel calls these. Slack/CLI/webhook each implement them.
export interface Channel {
  /** Deliver an outward event: status update, alert, or final delivery. Effectful (§5). */
  send(e: EgressEvent): Promise<void>;
  /** Post a human-in-the-loop prompt. Fire-and-forget; the reply returns via ingress. */
  ask(r: HitlRequest): Promise<void>;
}

export type EgressEvent =
  | { kind: "status";   runId: string; text: string }
  | { kind: "alert";    runId: string; severity: "warn" | "halt"; text: string }
  | { kind: "delivery"; runId: string; artifactPath: string; text: string };

export interface HitlRequest {
  runId: string;
  cardId: string;          // the `hold` card awaiting a decision
  correlationId: string;   // round-trips so the reply maps back to this exact card
  prompt: string;
  options: { id: string; label: string }[];   // for a rank/selection
  timeoutMs: number;       // honors flow.yaml hold_timeout
}
```

Ingress is the inverse: an external event → a **TriggerRequest** the kernel turns into a
run, *or* a **HitlReply** the kernel injects into a waiting `hold` card.

```ts
export type Ingress =
  | { kind: "trigger"; lineId: string; substrate: Record<string, unknown> }
  | { kind: "hitl_reply"; correlationId: string; selection: string; note?: string };
```

Everything below is the Slack implementation of these two interfaces.

---

## 2. Ingress — the webhook listener (`transport: events`)

The listener is the **thin trigger-listener** of [`SPEC.md` §4A](../SPEC.md): it verifies,
dedups, and either spawns `conduit run` or enqueues a `hitl_reply`. It holds no
orchestration state and is crash-isolated from the runs it triggers.

This section is the Events API (webhook) transport. Everything after the ack — parse →
channel-resolve → derive event id → dedup → spawn/enqueue — is transport-agnostic; §2A
shows the Socket Mode transport feeding the identical pipeline.

```ts
// conduit-listen.ts  — run with: bun conduit-listen.ts
import { createHmac, timingSafeEqual } from "node:crypto";

import { Database } from "bun:sqlite";

const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET!;
const TRIGGER_PREFIX = process.env.CONDUIT_TRIGGER_PREFIX ?? "conduit:"; // invocation gate — only messages starting with this prefix trigger a run

// Durable dedup: survive listener restarts without re-triggering billed runs (§5, §11)
const db = new Database(process.env.CONDUIT_DB ?? "conduit.sqlite");
db.run(`CREATE TABLE IF NOT EXISTS ingress_events (
  event_id   TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
)`);

/** Returns true if already seen (duplicate); inserts and returns false if new. */
function isSeenOrRecord(eventId: string): boolean {
  return db.run(
    `INSERT OR IGNORE INTO ingress_events(event_id, received_at) VALUES (?, ?)`,
    [eventId, Date.now()]
  ).changes === 0;
}

/** Verify a Slack request: HMAC over `v0:timestamp:rawBody`, timing-safe, 5-min replay window. */
function verifySlack(raw: string, h: Headers): boolean {
  const sig = h.get("x-slack-signature");
  const ts = h.get("x-slack-request-timestamp");
  if (!sig || !ts) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // replay protection
  const expected =
    "v0=" + createHmac("sha256", SIGNING_SECRET).update(`v0:${ts}:${raw}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}

function triggerRun(idea: string) {
  // Thin: just shell out. The kernel is a separate per-run process (§10A).
  Bun.spawn(["conduit", "run", "studio.yaml", "--idea", idea], {
    stdout: "ignore", stderr: "ignore", stdin: "ignore",
  });
}

Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  // Bun 1.2+ also supports a declarative `routes:` map — manual routing is fine for two paths.
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (req.method !== "POST") return new Response("nope", { status: 405 });

    // --- Events API (ingress triggers) ---
    if (pathname === "/hooks/slack/events") {
      const raw = await req.text();                 // RAW body first — the signature is over bytes
      if (!verifySlack(raw, req.headers)) return new Response("bad sig", { status: 401 });

      const evt = JSON.parse(raw);
      if (evt.type === "url_verification")          // one-time setup handshake
        return Response.json({ challenge: evt.challenge });

      const id = evt.event_id ?? `${evt.team_id}:${evt.event?.ts}`;
      if (isSeenOrRecord(id)) return new Response("ok (dup)", { status: 200 }); // at-least-once

      const text: string = evt.event?.text ?? "";
      if (evt.event?.type === "message" && !evt.event.bot_id && text.startsWith(TRIGGER_PREFIX))
        triggerRun(text.slice(TRIGGER_PREFIX.length).trim());

      return new Response("ok", { status: 200 });   // ack <3s; the run is out-of-band
    }

    // --- Interactivity (HITL replies: buttons / selects) ---
    if (pathname === "/hooks/slack/interactivity") {
      const raw = await req.text();                 // NOTE: form-encoded, but verify over the RAW body
      if (!verifySlack(raw, req.headers)) return new Response("bad sig", { status: 401 });

      const payload = JSON.parse(new URLSearchParams(raw).get("payload")!);
      const action = payload.actions?.[0];
      // action_id carries our correlationId; value carries the chosen option id (§3)
      injectHitlReply(action.action_id, action.value, payload.user?.id);

      return new Response("", { status: 200 });     // empty 200 = "leave the message as-is"
    }

    return new Response("not found", { status: 404 });
  },
});
```

### The four webhook rules (they bite if you skip them)
1. **Read the raw body, then verify.** `await req.text()` *before* parsing — the HMAC is
   over the exact bytes. (Interactivity is form-encoded, but you still hash the raw body,
   then pull `payload` out of it.)
2. **Verify the signature on *both* endpoints.** Events *and* interactivity. An unverified
   "trigger a flow" endpoint is remote code execution by Slack impersonation.
3. **Ack within ~3s; work out-of-band.** Slack retries on timeout. `Bun.spawn` is
   near-instant (vfork), so spawn-and-return; never block the response on the run.
4. **Dedup with SQLite, not memory.** Slack delivers at-least-once and retries
   (`X-Slack-Retry-Num`). Dedup by `event_id` using an `INSERT OR IGNORE` into
   `ingress_events` — a listener restart cannot re-trigger a billed run.
5. **Gate on invocation prefix.** Only trigger a run when the message starts with
   `CONDUIT_TRIGGER_PREFIX` (default: `conduit:`). Every message in the watched channel
   hits this webhook; without a prefix gate, any workspace member can launch billed runs
   at will.

### TLS
Slack requires HTTPS. In dev, front it with `cloudflared tunnel` or `ngrok`. In prod,
terminate TLS at a proxy, or pass `tls: { cert, key }` straight to `Bun.serve` — native, no
dependency. (Or skip the public edge entirely — that's what §2A is for.)

---

## 2A. Ingress — Socket Mode (`transport: socket`, no public edge)

Some deployments have no public HTTPS endpoint and shouldn't grow one — an engine sitting
next to a tailnet-only model box is the canonical case. **Socket Mode** inverts
the direction: the listener opens an *outbound* websocket and Slack delivers the same
event envelopes over it. Zero inbound reachability required. Slack's own positioning maps
exactly onto ours: Events API for distributed/public apps, Socket Mode for
internal/behind-firewall apps — i.e. conduit's self-hosted story.

How it works:

1. Call `apps.connections.open` with an **app-level token** (`xapp-…`, scope
   `connections:write` — a second secret alongside the bot token, via env like everything
   else, ADR-0003). It returns a `wss://` URL.
2. Connect. Slack pushes envelopes: `events_api` (the same `event_callback` body §2
   receives by webhook) and `interactive` (the same Interactivity payload — **HITL replies
   arrive over the same socket**; no second endpoint, no shim).
3. Ack each envelope by echoing its `envelope_id` back on the socket — the Socket Mode
   equivalent of the HTTP 2xx, same ~3s expectation, work still out-of-band.

```ts
const APP_TOKEN = process.env.SLACK_APP_TOKEN!;   // xapp-…, connections:write

async function connectSocketMode() {
  const { url } = await slack("apps.connections.open", {}, APP_TOKEN); // §3's helper, app token instead of bot token
  const ws = new WebSocket(url);
  ws.onmessage = (m) => {
    const env = JSON.parse(String(m.data));
    if (env.type === "hello") return;
    if (env.type === "disconnect") { connectSocketMode(); ws.close(); return; } // recycle
    if (env.envelope_id)
      ws.send(JSON.stringify({ envelope_id: env.envelope_id }));  // ack FIRST (<3s)
    handleEnvelope(env);  // → the same parse → dedup → spawn/enqueue pipeline as §2
  };
  ws.onclose = () => setTimeout(connectSocketMode, backoffMs()); // dropped socket → reconnect
}
```

### What changes vs. the webhook — and what doesn't

| | `transport: events` | `transport: socket` |
|---|---|---|
| Reachability | public HTTPS endpoint | outbound wss only |
| Auth | HMAC signature per request (`SLACK_SIGNING_SECRET`) | the connection itself — authenticated at `apps.connections.open`; no per-envelope verification, signing secret unused |
| Ack | HTTP 2xx within ~3s | echo `envelope_id` within ~3s |
| HITL replies | separate Interactivity webhook | `interactive` envelopes on the same socket |
| `url_verification` handshake | yes (one-time) | none |

**Unchanged, deliberately:** at-least-once delivery (unacked envelopes are redelivered →
the same durable SQLite dedup by event id), the invocation-prefix gate, the thin-listener
rule (verify/dedup/spawn only — no orchestration at the edge), and the entire post-ack
pipeline. The transports differ only in delivery + ack; the `Channel` contract and the
kernel are untouched.

### Connection lifecycle (the part that is actually new)

The webhook listener is passive; a socket client owns a long-lived connection. The rules:

- **Slack recycles connections** (roughly hourly): a `disconnect` frame with
  `reason: refresh_requested` arrives first. Open the *new* connection before closing the
  old one so no envelope falls in the gap — Slack permits multiple concurrent connections
  per app precisely for this handoff.
- **Reconnect with backoff** on any close. While disconnected, unacked envelopes are
  redelivered on reconnect; dedup absorbs the replays.
- **Don't treat `disconnect` as an error.** `link_disabled` (app disabled) is the one
  terminal reason — surface it as an alert, don't retry-loop against it.

---

## 3. Egress — talking back to Slack

Egress is plain `fetch` against the Slack Web API with a bot token. No SDK required.

```ts
const TOKEN = process.env.SLACK_BOT_TOKEN!;

async function slack(method: string, body: unknown, token = TOKEN) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`slack ${method}: ${json.error}`);
  return json;
}
```

### Status thread (genba)
One Slack thread per run keeps the channel readable. Post the root once, keep the `ts`, and
thread every status update under it.

```ts
async function openRunThread(channel: string, runId: string) {
  const { ts } = await slack("chat.postMessage", {
    channel, text: `:gear: Conduit run \`${runId}\` started`,
  });
  return ts; // persist on the run row; reuse as thread_ts for all updates
}

async function status(channel: string, thread_ts: string, text: string) {
  await slack("chat.postMessage", { channel, thread_ts, text });
}
```

### HITL — the round-trip (this is the interesting one)
A `hold` card asks a human; the reply must land back on *that exact card*. The
`correlationId` rides out in the button `action_id`, and comes back in §2's interactivity
handler.

```ts
async function askHitl(channel: string, thread_ts: string, r: HitlRequest) {
  await slack("chat.postMessage", {
    channel, thread_ts,
    text: r.prompt,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: r.prompt } },
      {
        type: "actions",
        elements: r.options.map((o) => ({
          type: "button",
          text: { type: "plain_text", text: o.label },
          action_id: r.correlationId,   // ← round-trips to map the reply back to the card
          value: o.id,                  // ← the chosen option
        })),
      },
    ],
  });
  // The kernel does NOT block here. The card sits in `hold` (no budget, no slot, §3).
  // The reply arrives later at /hooks/slack/interactivity → injectHitlReply(correlationId, value).
}
```

`injectHitlReply` (called from the interactivity webhook) looks up the `hold` card by
`correlationId`, writes the selection as a managerial note, and lets the kernel advance it
on the next tick. If `hold_timeout` fires first, the kernel applies the card's `on_timeout`
action (`scrap`, `proceed_with_findings`, or `escalate`) — no orphaned waits. `on_timeout`
is required in `flow.yaml` whenever `hold_timeout` is set (SPEC §4A).

### Alerts
```ts
const alert = (channel: string, ts: string, sev: string, text: string) =>
  slack("chat.postMessage", { channel, thread_ts: ts, text: `${sev === "halt" ? ":rotating_light:" : ":warning:"} ${text}` });
```

### File delivery — the station-level `deliver:` block (SPEC §4A)

A link-only delivery is just `chat.postMessage`, as above. Handing off a produced **file**
(the Meta CSV, an edited image, a rendered clip) goes through a station's `deliver:` block
instead — declared once in `flow.yaml`, not hand-called from egress code:

```yaml
stations:
  - id: edit-photo
    worker: { kind: transform, ... }
    deliver:
      files: [work/edited.jpg]     # non-empty; verbatim declared paths, resolved under project_root
      thread_from: thread_ts       # optional — reads this field off the triggering ingress substrate
      caption: "here is your edit" # optional — rides the upload as initial_comment, never a separate send
```

The channel bound is whichever egress entry resolves via `uses: [delivery]` (first channel by
fallback when none of a flow's channels declare `uses` at all) — validated at load, so a
`deliver:` block with no delivery-capable channel never reaches runtime. On successful station
completion each declared file uploads via Slack's **external-upload three-step**:

1. `files.getUploadURLExternal` — request a pre-signed upload slot (filename + byte length).
2. A raw byte `POST` of the file to that URL (not a Web API call — no bot token on this request).
3. `files.completeUploadExternal` — finalize, carrying the target channel, optional `thread_ts`,
   optional `initial_comment` (the `caption`).

Like every other egress send this is outbox-guarded (§4 above), but keyed by
`(flow_version, card, station, attempt, file)` **plus a content fingerprint** of the file's
current bytes — a rework attempt that produces a new artifact re-delivers under a fresh key; an
unchanged same-attempt resume dedups against the committed key. A crash before or during steps 1–2
is always safe to blindly re-run the whole three-step: nothing is channel-visible yet, so nothing
can double-post. The genuinely dangerous window is a crash **after `completeUploadExternal`
succeeds but before the outbox commit lands** — the file may already be attached in the channel, or
the crash may have hit before Slack's response was even processed. That pending intent is handed to
a `files.info`/thread-history **reconciler**: a probe that can prove the file landed (skip) or
definitively did not (re-fire, exactly once) auto-resumes without a human; a probe that comes back
ambiguous — or no reconciler at all — hard-pauses the card to `hold` rather than silently retrying.
`thread_from` degrades the same way `hold`/HITL substrate resolution does: absent (a CLI-triggered
run) or unresolvable is not an error, just an unthreaded delivery, journaled as a degrade so it is
visible in `conduit explain`.

### Egress environment knobs

Four env variables tune the transport; all are optional, validated at read (an invalid value
silently falls back to the default), and read fresh per use so a test or a restarted listener
picks up overrides without a rebuild:

| Variable | Default | Governs |
|---|---|---|
| `SLACK_MAX_UPLOAD_BYTES` | `1073741824` (1 GiB) | Per-file size gate checked before a `deliver:`/`ask_attach` upload begins — an over-limit file is a named load-side failure, never a mid-upload surprise. |
| `SLACK_FETCH_TIMEOUT_MS` | `60000` (60 s) | Every Slack **Web API** fetch (`chat.postMessage`, upload steps 1 and 3, the `files.info` reconciler probe, `apps.connections.open`). A stall aborts and lands on the call's existing fail-closed path instead of wedging the run. |
| `SLACK_UPLOAD_TIMEOUT_MS` | `900000` (15 min) | The raw **byte `POST`** (upload step 2) only — budgeted separately so a legitimately slow large upload (up to the 1 GiB gate on a ~10 Mbps link) is not killed by the short API timeout. |
| `SLACK_API_BASE_URL` | `https://slack.com` | Base host for every production Slack call — Web API **and** Socket Mode's `apps.connections.open`. A non-absolute or non-http(s) value falls back to the default. Holds the bare host (no `/api` suffix); each call site appends exactly one `/api` segment. |

This is also the seam the `blackbox/` suite uses to point a real `conduit` child at a
fake Slack server instead of the genuine API — see `blackbox/README.md`.

---

## 4. Idempotency — channel egress is effectful (§5)

Posting to Slack is a side effect. On a resumed run you must not re-post a delivery or
re-ask an approval. So every egress `send`/`ask` goes through the **outbox**:

1. Write an intent row: `(runId, kind, correlationId, idempotency_key, status=pending)`.
2. Do the Slack call.
3. Mark `committed`.
4. On resume, a `pending` row means "may have sent" → check before retrying (Slack's
   `chat.postMessage` is not idempotent on its own; the outbox is your idempotency layer).

Pair this with §2's inbound dedup (`event_id`) and the channel is safe across crashes in
both directions.

---

## 5. Security checklist

- **Verify every inbound request** (events *and* interactivity) — HMAC, timing-safe,
  5-min replay window. (Webhook transport only; on `transport: socket` there is no inbound
  request to verify — the connection is the auth, so guard the app token accordingly.)
- **Least-privilege bot scopes:** `chat:write` (+ `chat:write.public` if posting to
  channels it isn't in). **Any flow declaring a station-level `deliver:` block also requires
  `files:write`** — the external-upload three-step (`files.getUploadURLExternal` /
  `files.completeUploadExternal`) 403s without it. Nothing else. The app-level token gets
  `connections:write` only.
  > **Deployment note:** Slack does not retroactively grant a new scope to an existing bot
  > token — adding `files:write` to an app's OAuth config does **not** take effect until the
  > workspace **reinstalls the app** (Slack's *"you've changed the permissions your app is
  > asking for"* reinstall flow). An already-installed bot upgrading to a flow with a
  > `deliver:` block must reinstall (or reauthorize) in each target workspace before its
  > existing `SLACK_BOT_TOKEN` gains upload access — the token value itself does not change,
  > but its granted scopes do.
- **Secrets** (`SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, and `SLACK_APP_TOKEN` on the
  socket transport) come from env, never the repo, and are masked in the journal
  (SPEC §11). Prefer *not logging* request bodies at all.
- **The listener is dumb on purpose.** It verifies, dedups, and spawns/enqueues — no
  orchestration logic lives at the edge, so a compromised or buggy listener can't corrupt a
  run's state (that lives in SQLite, written only by the kernel).

---

## 6. Evolution path (the "not a daemon *yet*" arc)

- **Egress-first MVP.** No webhook at all. `conduit run studio.yaml --idea "…"` from the
  CLI; Slack for status/HITL/delivery. Ships with steps 1–7 of the SPEC build order.
- **+ Ingress (this doc).** The thin `Bun.serve` listener spawns `conduit run`. You now
  have *one* small always-on process — the front door — but the **kernel stays per-run**.
- **+ Run backpressure (shipped).** The first slice of the `conduitd` arc,
  needed the first time a burst of simultaneous events hit a serial model box:
  `max_concurrent_runs` caps in-flight spawned runs listener-wide. Events beyond the cap
  stay `'accepted'` in `ingress_events` (the queue IS the SQLite state DB, as predicted
  below) and the re-drive sweep — kicked the moment a slot frees — launches them in
  arrival order.
- **→ `conduitd`.** Swap `triggerRun`'s `Bun.spawn` for *enqueue into the SQLite state DB*,
  and add a supervisor that pulls from the queue with concurrency limits. The thin listener
  has grown into the always-on service we deferred — without a rewrite. Defer until you
  actually need queuing/backpressure across many concurrent campaigns.

---

## 7. Testing a channel (the Bench)

Channels are fixture-testable like any edge adapter (SPEC §14):

- **Ingress (events):** feed a recorded Slack `event_callback` payload (with a
  freshly-signed header) to the `fetch` handler and assert it produces the right
  `TriggerRequest` / `HitlReply`.
- **Ingress (socket):** feed recorded `events_api` / `interactive` / `disconnect`
  envelopes to the envelope handler and assert the ack (`envelope_id` echoed), the same
  `TriggerRequest` / `HitlReply`, and the reconnect on `disconnect`. No tunnel needed —
  Socket Mode has no `url_verification` handshake at all.
- **Egress:** point `slack()` at a mock that records calls; assert the kernel emits the
  right `chat.postMessage`/blocks for status/hitl/alert/delivery, and that the outbox makes
  a re-run post nothing new.
- **Signature:** a negative test with a bad/absent signature must 401; a stale timestamp
  must 401.

No live Slack workspace needed for the unit layer — only for the one-time
`url_verification` smoke test against a real tunnel.
