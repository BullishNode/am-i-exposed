/**
 * Minimal HTTP router for the am-i-exposed API server.
 * No external dependencies - uses Node.js built-in http module.
 */

import type { IncomingMessage, ServerResponse } from "http";

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: Handler;
}

const routes: Route[] = [];

/** Clear all registered routes. Call before re-registering (e.g., in tests). */
export function clearRoutes(): void {
  routes.length = 0;
}

/**
 * Register a route. Supports path parameters via :param syntax.
 * Example: addRoute("GET", "/api/v1/labels/check/:address", handler)
 */
export function addRoute(method: string, path: string, handler: Handler): void {
  const paramNames: string[] = [];
  const patternStr = path.replace(/:(\w+)/g, (_, name) => {
    paramNames.push(name);
    return "([^/]+)";
  });
  routes.push({
    method: method.toUpperCase(),
    pattern: new RegExp(`^${patternStr}$`),
    paramNames,
    handler,
  });
}

/** Maximum request body size (10 MB). */
const MAX_BODY_SIZE = 10 * 1024 * 1024;

/** Read raw body bytes from request with size limit. */
function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    let resolved = false;
    const done = (value: Buffer | null) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };
    req.on("data", (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_SIZE) {
        req.destroy();
        done(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => done(Buffer.concat(chunks)));
    req.on("error", () => done(null));
  });
}

/** Parse JSON body from request. Returns null on failure or oversized body. */
export async function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  const buf = await readBody(req);
  if (!buf || buf.length === 0) return null;
  try {
    return JSON.parse(buf.toString("utf-8"));
  } catch {
    return null;
  }
}

/** Read raw body text from request with size limit. */
export async function parseRawBody(req: IncomingMessage): Promise<string> {
  const buf = await readBody(req);
  return buf ? buf.toString("utf-8") : "";
}

/** Send JSON response. */
export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

/** Send error response. */
export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: true, message });
}

/** Auth token. Null = no auth required. */
let authToken: string | null = null;

/** Set the required auth token. Requests must send Authorization: Bearer <token>. */
export function setAuthToken(token: string | null): void {
  authToken = token;
}

/** Main request handler - matches routes and dispatches. */
export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const pathname = url.pathname;

  // Auth check (health endpoint is always public)
  if (authToken && pathname !== "/api/v1/health") {
    const header = req.headers.authorization ?? "";
    if (header !== `Bearer ${authToken}`) {
      sendError(res, 401, "Unauthorized");
      return;
    }
  }
  const method = (req.method ?? "GET").toUpperCase();

  for (const route of routes) {
    if (route.method !== method) continue;
    const match = pathname.match(route.pattern);
    if (!match) continue;

    const params: Record<string, string> = {};
    route.paramNames.forEach((name, i) => {
      params[name] = decodeURIComponent(match[i + 1]);
    });

    try {
      await route.handler(req, res, params);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, message);
    }
    return;
  }

  sendError(res, 404, `Not found: ${method} ${pathname}`);
}
