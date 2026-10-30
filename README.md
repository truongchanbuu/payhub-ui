# PayHub UI

A small Vietnamese demo console for the SmartReturn PayHub mock. Search a Return
Request and follow HTTP attempts, accepted payments, replays, callbacks and
Salesforce refund outcome events in one place.

## Run

Requires Node.js 24. No runtime dependencies or frontend build step.

```sh
npm ci
cp .env.example .env
npm start
```

Open <http://localhost:3001> and enter the **PayHub ADMIN_KEY**. The key is supplied
by the operator, forwarded only to the configured PayHub, and retained only in the
page's memory. It is never placed in browser storage, URLs or source files. Reload
or disconnect to clear it.

| Environment variable | Purpose                                                             |
| -------------------- | ------------------------------------------------------------------- |
| `PAYHUB_URL`         | Required PayHub HTTPS origin; local HTTP is allowed for development |
| `PORT`               | Listener port; defaults to `3001`                                   |

The included example targets `https://payhub-2u1i.onrender.com`. The UI and PayHub
are separate services; the UI proxies only the approved admin endpoints, avoiding
cross-origin browser requests. It does not expose a refund-creation endpoint or
implement Salesforce retry scheduling.

## Demo flow

1. Connect with the PayHub Admin Key.
2. Select a scenario and confirm **Áp dụng** before submitting an inspection.
   This changes the shared mock's default for new transactions, so run cases
   serially and use a fresh Return Request for each case.
3. Submit Inspection in Salesforce. Paste its request number into the tracker.
   Keep namespace `default` unless Salesforce sends a different `X-Mock-Test-Id`.
4. The visible page refreshes every three seconds. HTTP attempts and retry timing
   still follow Salesforce's configuration; UI polling does not trigger retries.
5. Show accepted count versus attempt/replay counts. Key fingerprints are SHA-256
   hashes from PayHub traces, not raw idempotency keys.
6. Inspect callback delivery, then the matching Salesforce outcome event. Return
   to Salesforce to verify its final request/refund state and Accounting work.
7. Reset the scenario to SUCCESS after testing.

| Scenario                          | What to demonstrate                                                              |
| --------------------------------- | -------------------------------------------------------------------------------- |
| `SUCCESS`                         | One accepted refund, immediate result, no callback                               |
| `PENDING_SUCCESS`                 | Acceptance followed by a successful callback                                     |
| `PENDING_FAILED`                  | Acceptance followed by a failed payment result                                   |
| `SUCCESS_THEN_TIMEOUT`            | Accepted before a lost response; retry replays the original result               |
| `RETRY_503_2_SUCCESS`             | Two pre-acceptance failures, then success on attempt three                       |
| `DUPLICATE_CALLBACK`              | Two callback deliveries for the same refund                                      |
| `HTTP_500`, `HTTP_503`, `TIMEOUT` | Persistent errors; Salesforce owns retries and escalation                        |
| `INVALID_AMOUNT`                  | Terminal 422 rejection without acceptance                                        |
| `RETRY_503_3`                     | Success only on attempt four; a three-attempt Salesforce policy never reaches it |

A PayHub final SUCCESS is distinct from a callback delivery HTTP 2xx, and both are
distinct from Salesforce's persisted business state. The UI labels each separately.
The optional event panel requires the PayHub backend's
`SALESFORCE_REFUND_EVENTS_ENABLED=true` and its existing subscriber credentials.
No event in the retained tail is not evidence of refund failure.

PayHub stores state only in RAM. Backend sleep, restart or redeploy clears traces,
scenarios, callbacks and retained events. Refresh cannot recover cleared history.
The UI also deliberately retains no transaction history of its own.

## Deploy on Render

Create a **Blueprint** from this repository's `render.yaml`. It provisions a
separate Node web service with `npm ci --omit=dev`, `npm start`, a `/healthz` health
check, and deploys from `main` after CI succeeds. No Admin Key is needed in Render's
environment: the operator enters the key when connecting through the UI.

If the GitHub repository is private, allow the Render GitHub integration to access
it. This repository must be connected as a new service; pushing it does not deploy
the existing PayHub backend or create a Render service automatically.

Serve the deployed UI over HTTPS. Public visitors can load the static shell, but
all monitoring and scenario requests require the correct PayHub Admin Key.

## Verify

```sh
npm test
```

Native `node:test` tests use ephemeral local HTTP servers to verify the proxy,
authentication, route/query allowlists, scenario writes, static asset restrictions,
upstream failures, redirects and timeouts. No test connects to Salesforce.
