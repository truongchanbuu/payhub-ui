import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/view.js", ["view.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);
const routes = new Map([
  ["/api/scenario", ["/__mock/scenario", ["GET", "PUT", "DELETE"], []]],
  [
    "/api/transactions",
    ["/__mock/transactions", ["GET"], ["testId", "merchantRef"]],
  ],
  ["/api/attempts", ["/__mock/attempts", ["GET"], ["testId"]]],
  ["/api/refund-events", ["/__mock/refund-events", ["GET"], ["limit"]]],
]);

function backendOrigin(value) {
  const url = new URL(value);
  const local =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (!local && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(
      "PAYHUB_URL must be an HTTPS origin, or a local HTTP origin for development.",
    );
  }
  return url.origin;
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type });
  res.end(type.startsWith("application/json") ? JSON.stringify(body) : body);
}

async function scenarioBody(req) {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    return { status: 415 };
  if (Number(req.headers["content-length"]) > 1024) return { status: 413 };
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 1024) return { status: 413 };
  }
  try {
    const value = JSON.parse(body);
    if (
      !value ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      typeof value.scenario !== "string"
    ) {
      return { status: 400 };
    }
    return { body: JSON.stringify(value) };
  } catch {
    return { status: 400 };
  }
}

export function createUiServer({ backendUrl, timeoutMs = 12000 } = {}) {
  const origin = backendOrigin(backendUrl);
  return createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    try {
      const url = new URL(req.url, "http://ui.local");
      if (url.pathname === "/healthz" && req.method === "GET")
        return send(res, 200, { status: "ok" });
      const asset = assets.get(url.pathname);
      if (asset && req.method === "GET") {
        const body = await readFile(
          new URL(`./public/${asset[0]}`, import.meta.url),
        );
        return send(res, 200, body, asset[1]);
      }
      const route = routes.get(url.pathname);
      if (!route) return send(res, 404, { errorCode: "NOT_FOUND" });
      const [path, methods, params] = route;
      if (!methods.includes(req.method))
        return send(res, 405, { errorCode: "METHOD_NOT_ALLOWED" });
      const key = req.headers["x-admin-key"];
      if (typeof key !== "string" || !key.trim() || key.length > 4096)
        return send(res, 401, { errorCode: "UNAUTHORIZED" });
      const target = new URL(path, origin);
      for (const [name, value] of url.searchParams) {
        if (
          !params.includes(name) ||
          url.searchParams.getAll(name).length !== 1
        ) {
          return send(res, 400, { errorCode: "INVALID_QUERY" });
        }
        target.searchParams.set(name, value);
      }
      const headers = { "X-Admin-Key": key, Accept: "application/json" };
      let body;
      if (req.method === "PUT") {
        const parsed = await scenarioBody(req);
        if (parsed.status)
          return send(res, parsed.status, {
            errorCode: "INVALID_SCENARIO_BODY",
          });
        body = parsed.body;
        headers["Content-Type"] = "application/json";
      }
      const response = await fetch(target, {
        method: req.method,
        headers,
        body,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const data = await response.json();
      send(res, response.status, data);
    } catch (error) {
      if (!res.headersSent)
        send(res, error.name === "TimeoutError" ? 504 : 502, {
          errorCode: "PAYHUB_UNAVAILABLE",
        });
      else res.end();
    }
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const server = createUiServer({ backendUrl: process.env.PAYHUB_URL });
  server.listen(Number(process.env.PORT || 3001), "0.0.0.0", () => {
    console.log(`PayHub UI listening on port ${server.address().port}`);
  });
  const close = () => {
    server.close();
    server.closeIdleConnections();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
