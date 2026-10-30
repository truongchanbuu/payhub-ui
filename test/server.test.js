import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createUiServer } from "../server.js";

const adminKey = "synthetic-test-admin-key";
async function listen(t, server) {
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}
async function setup(t, handler, options = {}) {
  const requests = [];
  const backend = await listen(
    t,
    createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: raw,
      });
      res.setHeader("Content-Type", "application/json");
      if (handler) return handler(req, res, raw);
      res.end(JSON.stringify({ scenario: "SUCCESS" }));
    }),
  );
  const url = await listen(
    t,
    createUiServer({ backendUrl: backend, ...options }),
  );
  return { url, requests };
}
const authorized = { "X-Admin-Key": adminKey };

test("public shell and assets load without exposing credentials or server files", async (t) => {
  const { url, requests } = await setup(t);
  for (const path of ["/", "/styles.css", "/app.js", "/view.js"]) {
    const response = await fetch(url + path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(
      response.headers.get("content-security-policy"),
      /frame-ancestors 'none'/,
    );
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.ok(!(await response.text()).includes(adminKey));
  }
  for (const path of ["/server.js", "/.env", "/package.json", "/%2e%2e/.env"]) {
    assert.equal((await fetch(url + path)).status, 404);
  }
  assert.deepEqual(await (await fetch(url + "/healthz")).json(), {
    status: "ok",
  });
  assert.equal(requests.length, 0);
});

test("all monitoring and scenario routes require the caller admin key", async (t) => {
  const { url, requests } = await setup(t);
  for (const path of [
    "scenario",
    "transactions",
    "attempts",
    "refund-events",
  ]) {
    assert.equal((await fetch(`${url}/api/${path}`)).status, 401);
  }
  assert.equal(requests.length, 0);
});

test("proxy forwards only the configured path, admin header, and approved query parameters", async (t) => {
  const { url, requests } = await setup(t);
  await fetch(url + "/api/transactions?testId=default&merchantRef=RR-TEST", {
    headers: {
      ...authorized,
      Cookie: "private-cookie=secret",
      Authorization: "Bearer should-not-forward",
    },
  });
  assert.equal(
    requests[0].url,
    "/__mock/transactions?testId=default&merchantRef=RR-TEST",
  );
  assert.equal(requests[0].headers["x-admin-key"], adminKey);
  assert.equal(requests[0].headers.cookie, undefined);
  assert.equal(requests[0].headers.authorization, undefined);
  for (const path of [
    "/api/transactions?url=https://other.example",
    "/api/attempts?testId=a&testId=b",
    "/api/scenario?scenario=TIMEOUT",
  ])
    assert.equal(
      (await fetch(url + path, { headers: authorized })).status,
      400,
    );
  assert.equal(
    (
      await fetch(url + "/api/attempts", {
        method: "DELETE",
        headers: authorized,
      })
    ).status,
    405,
  );
  assert.equal(
    (await fetch(url + "/api/refunds", { method: "POST", headers: authorized }))
      .status,
    404,
  );
  assert.equal(requests.length, 1);
});

test("scenario mutation sends validated JSON and supports reset", async (t) => {
  const { url, requests } = await setup(t);
  const headers = { ...authorized, "Content-Type": "application/json" };
  const endpoint = url + "/api/scenario";
  assert.equal(
    (await fetch(endpoint, { method: "PUT", headers, body: "{bad" })).status,
    400,
  );
  assert.equal(
    (
      await fetch(endpoint, {
        method: "PUT",
        headers,
        body: JSON.stringify({ scenario: "TIMEOUT", extra: true }),
      })
    ).status,
    400,
  );
  assert.equal(
    (await fetch(endpoint, { method: "PUT", headers, body: "x".repeat(1025) }))
      .status,
    413,
  );
  assert.equal(
    (await fetch(endpoint, { method: "PUT", headers: authorized, body: "{}" }))
      .status,
    415,
  );
  assert.equal(requests.length, 0);
  assert.equal(
    (
      await fetch(endpoint, {
        method: "PUT",
        headers,
        body: JSON.stringify({ scenario: "TIMEOUT" }),
      })
    ).status,
    200,
  );
  assert.deepEqual(JSON.parse(requests[0].body), { scenario: "TIMEOUT" });
  assert.equal(requests[0].method, "PUT");
  assert.equal(
    (await fetch(endpoint, { method: "DELETE", headers: authorized })).status,
    200,
  );
  assert.equal(requests[1].method, "DELETE");
});

test("upstream authentication and transaction-not-found responses remain distinguishable", async (t) => {
  const { url } = await setup(t, (req, res) => {
    const unauthorized = req.headers["x-admin-key"] !== adminKey;
    res.statusCode = unauthorized ? 401 : 404;
    res.end(
      JSON.stringify({
        errorCode: unauthorized ? "UNAUTHORIZED" : "TRANSACTION_NOT_FOUND",
      }),
    );
  });
  const unauthorized = await fetch(url + "/api/scenario", {
    headers: { "X-Admin-Key": "wrong" },
  });
  assert.equal(unauthorized.status, 401);
  const missing = await fetch(url + "/api/transactions?merchantRef=RR-NONE", {
    headers: authorized,
  });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), {
    errorCode: "TRANSACTION_NOT_FOUND",
  });
});

test("upstream redirects and non-JSON responses fail without leaking their content", async (t) => {
  let redirect = true;
  const { url } = await setup(t, (_req, res) => {
    if (redirect) {
      res.writeHead(302, { Location: "http://127.0.0.1:1/private" });
      res.end();
    } else res.end("private-backend-error");
  });
  for (const value of [true, false]) {
    redirect = value;
    const response = await fetch(url + "/api/scenario", {
      headers: authorized,
    });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      errorCode: "PAYHUB_UNAVAILABLE",
    });
  }
});

test("a slow backend times out with a controlled error", async (t) => {
  const { url } = await setup(t, () => {}, { timeoutMs: 20 });
  const response = await fetch(url + "/api/scenario", { headers: authorized });
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { errorCode: "PAYHUB_UNAVAILABLE" });
});

test("configuration rejects insecure or credential-bearing backend origins", () => {
  for (const backendUrl of [
    undefined,
    "http://example.com",
    "https://user:secret@example.com",
    "https://example.com/private",
    "https://example.com?key=secret",
  ]) {
    assert.throws(() => createUiServer({ backendUrl }));
  }
});
