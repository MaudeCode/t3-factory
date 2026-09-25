import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  renameSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { oidcSchema, type createOidc } from "./oidc.ts";
import { spawn } from "node:child_process";
import { z } from "zod";

const privateAddress = (host: string) =>
  /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host) &&
  /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) &&
  host.split(".").every((n) => Number(n) <= 255);
export const webConfigSchema = z
  .object({
    host: z
      .string()
      .refine(privateAddress, "Bind to a loopback or private LAN address")
      .default("127.0.0.1"),
    port: z.number().int().min(1024).max(65535).default(3848),
    publicOrigin: z.url().default("http://127.0.0.1:3848"),
  })
  .strict()
  .refine((c) => {
    const url = new URL(c.publicOrigin);
    return (
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          (privateAddress(url.hostname) ||
            ["localhost", "[::1]"].includes(url.hostname))))
    );
  }, "The address must be HTTPS, or HTTP on your private network");
type WebConfig = z.infer<typeof webConfigSchema>;
type Result = { code: number; data: any };
type Operation = {
  id: string;
  input: unknown;
  state: "running" | "done" | "uncertain";
  createdAt: string;
  result?: Result;
};
const dispatchSchema = z
  .object({
    ticket: z
      .string()
      .trim()
      .regex(/^(?:[A-Za-z0-9]+-\d+)?$/)
      .default(""),
    model: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .default("auto"),
    overrideLimits: z.boolean().default(true),
    allowMissingReadyLabel: z.boolean().default(false),
  })
  .strict()
  .refine(input => !input.allowMissingReadyLabel || !!input.ticket, "The readiness-label override requires a specific ticket");
const requestId = z.string().uuid();

export function runFactory(args: string[], input?: unknown): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./main.ts", import.meta.url)), ...args],
      {
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let output = "",
      size = 0,
      exceeded = false;
    const append = (chunk: Buffer) => {
      size += chunk.length;
      if (size > 4_000_000) {
        exceeded = true;
        child.kill();
      } else output += chunk.toString();
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      child.kill();
    }, 180_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (exceeded)
        return reject(
          new Error(
            "Factory response exceeded the size limit; check its status before retrying",
          ),
        );
      let data: any;
      try {
        data = JSON.parse(output);
      } catch {
        for (const line of output.trim().split("\n").toReversed()) {
          try {
            data = JSON.parse(line);
            break;
          } catch {}
        }
      }
      resolve({
        code: code ?? 1,
        data: data ?? {
          message:
            output.trim().slice(-1200) ||
            "Factory command ended without a response. Check status before retrying.",
        },
      });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  });
}

function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function saveJSON(path: string, data: unknown) {
  writeFileSync(`${path}.tmp`, JSON.stringify(data), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
export function createFactoryWeb(options: {
  config: WebConfig;
  secret: string;
  oidc?: Awaited<ReturnType<typeof createOidc>>;
  dataDir: string;
  readState: () => unknown;
  run?: typeof runFactory;
  assetDir?: string;
  now?: () => number;
}) {
  const { config, secret, dataDir } = options,
    run = options.run ?? runFactory,
    now = options.now ?? Date.now;
  const origin = new URL(config.publicOrigin).origin,
    localOrigin = `http://127.0.0.1:${config.port}`;
  const allowedOrigins = [
    ...new Set([
      origin,
      localOrigin,
      `http://${config.host}:${config.port}`,
      `http://localhost:${config.port}`,
    ]),
  ];
  const assets =
    options.assetDir ?? fileURLToPath(new URL("../web/", import.meta.url));
  const pairs = new Map<string, number>(),
    attempts = new Map<string, { count: number; until: number }>();
  const operations = join(dataDir, "web-requests");
  mkdirSync(operations, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(operations).filter((n) =>
    /^[a-f0-9-]{36}\.json$/.test(n),
  )) {
    const file = join(operations, name),
      saved = JSON.parse(readFileSync(file, "utf8")) as Operation;
    if (saved.state === "running")
      saveJSON(file, {
        ...saved,
        state: "uncertain",
        result: {
          code: 1,
          data: {
            message:
              "Web server restarted during dispatch. Inspect factory status before starting another run.",
          },
        },
      });
  }
  const sign = (value: string) =>
    createHmac("sha256", secret).update(value).digest("base64url");
  const authenticated = (req: IncomingMessage) => {
    const cookie = req.headers.cookie
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("factory_session="))
      ?.slice(16);
    if (!cookie || cookie.length > 300) return false;
    const [expires, nonce, signature] = cookie.split(".");
    return (
      !!signature &&
      /^\d+$/.test(expires) &&
      Number(expires) > now() &&
      Number(expires) <= now() + 31 * 86_400_000 &&
      equal(sign(`${expires}.${nonce}`), signature)
    );
  };
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const body = async (req: IncomingMessage) => {
    if (req.headers["content-type"]?.split(";")[0] !== "application/json")
      throw new Error("Expected application/json");
    let data = "";
    for await (const chunk of req) {
      data += chunk;
      if (Buffer.byteLength(data) > 512_000)
        throw new Error("Request is too large");
    }
    return JSON.parse(data || "{}");
  };
  let settingsBusy = false;
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const host = req.headers.host ?? "";
    if (!allowedOrigins.some((value) => new URL(value).host === host))
      return json(res, 403, { message: "Host is not allowed" });
    const path = new URL(req.url ?? "/", localOrigin).pathname;
    const admin =
      !options.oidc &&
      equal(req.headers.authorization ?? "", `Bearer ${secret}`);
    try {
      if (path === "/api/auth" && req.method === "GET")
        return json(res, 200, {
          mode: options.oidc ? "oidc" : "pairing",
          loginUrl: `${origin}/auth/login`,
        });
      if (options.oidc && path === "/auth/login" && req.method === "GET")
        return await options.oidc.login(req, res);
      if (options.oidc && path === "/auth/callback" && req.method === "GET") {
        try {
          await options.oidc.callback(req, res);
        } catch {
          res.writeHead(302, { Location: "/?auth_error=denied" });
          res.end();
        }
        return;
      }
      if (
        options.oidc &&
        (path === "/api/pair" ||
          (path === "/api/session" && req.method === "POST"))
      )
        return json(res, 403, {
          message: "Pairing is disabled. Sign in with SSO.",
        });
      if (
        req.method === "POST" &&
        !admin &&
        !allowedOrigins.includes(req.headers.origin ?? "")
      )
        return json(res, 403, { message: "Origin is not allowed" });
      if (path === "/api/pair" && req.method === "POST") {
        if (!admin)
          return json(res, 401, {
            message: "Pairing must be started from the Mac",
          });
        for (const [code, expiry] of pairs)
          if (expiry <= now()) pairs.delete(code);
        if (pairs.size >= 10)
          return json(res, 429, { message: "Too many pending pairing links" });
        const code = randomBytes(24).toString("base64url");
        pairs.set(code, now() + 10 * 60_000);
        return json(res, 200, {
          url: `${origin}/#pair=${code}`,
          expiresInSeconds: 600,
        });
      }
      if (path === "/api/session" && req.method === "POST") {
        const ip = req.socket.remoteAddress ?? "unknown",
          attempt = attempts.get(ip);
        if (attempt && attempt.until > now() && attempt.count >= 10)
          return json(res, 429, {
            message: "Too many attempts. Try again in a minute.",
          });
        const { code } = z
          .object({ code: z.string().max(100) })
          .strict()
          .parse(await body(req));
        const expiry = pairs.get(code);
        pairs.delete(code);
        if (!expiry || expiry <= now()) {
          if (attempts.size > 1000) attempts.clear();
          attempts.set(ip, {
            count: attempt && attempt.until > now() ? attempt.count + 1 : 1,
            until: now() + 60_000,
          });
          return json(res, 401, {
            message:
              "Pairing link is invalid or expired. Create another from your Mac.",
          });
        }
        const value = `${now() + 30 * 86_400_000}.${randomBytes(18).toString("base64url")}`;
        const secure = req.headers.origin?.startsWith("https:")
          ? "; Secure"
          : "";
        res.setHeader(
          "Set-Cookie",
          `factory_session=${value}.${sign(value)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure}`,
        );
        return json(res, 200, { ok: true });
      }
      if (path.startsWith("/api/")) {
        if (
          !(options.oidc
            ? await options.oidc.authenticated(req)
            : authenticated(req))
        )
          return json(res, 401, {
            message: options.oidc
              ? "Sign in to control the factory"
              : "Pair this device to control the factory",
          });
        if (path === "/api/session" && req.method === "DELETE") {
          if (!allowedOrigins.includes(req.headers.origin ?? ""))
            return json(res, 403, { message: "Origin is not allowed" });
          res.setHeader(
            "Set-Cookie",
            "factory_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
          );
          options.oidc?.logout(req, res);
          return json(res, 200, { ok: true });
        }
        if (path === "/api/state" && req.method === "GET")
          return json(res, 200, options.readState());
        if (path === "/api/models" && req.method === "GET") {
          const result = await run(["model-catalog"]);
          return json(res, result.code ? 503 : 200, result.data);
        }
        if (
          (path === "/api/config" && req.method === "POST") ||
          (path === "/api/enabled" && req.method === "POST")
        ) {
          const input = await body(req);
          if (settingsBusy)
            return json(res, 409, {
              message: "Another settings change is being saved. Try again.",
            });
          settingsBusy = true;
          try {
            const result =
              path === "/api/config"
                ? await run(["config-save"], input)
                : await run([
                    z.object({ enabled: z.boolean() }).strict().parse(input)
                      .enabled
                      ? "resume"
                      : "pause",
                  ]);
            return json(
              res,
              result.code ? 409 : 200,
              result.code ? result.data : { ok: true },
            );
          } finally {
            settingsBusy = false;
          }
        }
        if (path === "/api/dispatch" && req.method === "POST") {
          const id = requestId.parse(req.headers["idempotency-key"]),
            input = dispatchSchema.parse(await body(req));
          const file = join(operations, `${id}.json`);
          if (existsSync(file)) {
            const previous = JSON.parse(
              readFileSync(file, "utf8"),
            ) as Operation;
            if (JSON.stringify(dispatchSchema.parse(previous.input)) !== JSON.stringify(input))
              return json(res, 409, {
                message: "Request ID already belongs to another dispatch",
              });
            return json(res, 200, previous);
          }
          const operation: Operation = {
            id,
            input,
            state: "running",
            createdAt: new Date(now()).toISOString(),
          };
          writeFileSync(file, JSON.stringify(operation), {
            flag: "wx",
            mode: 0o600,
          });
          const args = [
            "dispatch",
            "--model",
            input.model,
            ...(input.ticket ? ["--ticket", input.ticket.toUpperCase()] : []),
            ...(input.overrideLimits ? ["--override-limits"] : []),
            ...(input.allowMissingReadyLabel ? ["--allow-missing-ready-label"] : []),
          ];
          void run(args)
            .then((result) =>
              saveJSON(file, { ...operation, state: "done", result }),
            )
            .catch(() =>
              saveJSON(file, {
                ...operation,
                state: "uncertain",
                result: {
                  code: 1,
                  data: {
                    message:
                      "Dispatch response was lost. Check factory status before starting another run.",
                  },
                },
              }),
            );
          return json(res, 202, operation);
        }
        if (path.startsWith("/api/operations/") && req.method === "GET") {
          const id = requestId.parse(path.slice("/api/operations/".length)),
            file = join(operations, `${id}.json`);
          return existsSync(file)
            ? json(res, 200, JSON.parse(readFileSync(file, "utf8")))
            : json(res, 404, { message: "Dispatch request not found" });
        }
        return json(res, 404, { message: "Not found" });
      }
      if (req.method !== "GET")
        return json(res, 405, { message: "Method not allowed" });
      const files: Record<string, [string, string]> = {
        "/": ["index.html", "text/html"],
        "/app.js": ["app.js", "text/javascript"],
        "/style.css": ["style.css", "text/css"],
        "/icon.svg": ["icon.svg", "image/svg+xml"],
        "/icon.png": ["icon.png", "image/png"],
        "/apple-touch-icon.png": ["apple-touch-icon.png", "image/png"],
        "/manifest.webmanifest": [
          "manifest.webmanifest",
          "application/manifest+json",
        ],
      };
      const asset = files[path];
      if (!asset) return json(res, 404, { message: "Not found" });
      res.writeHead(200, { "Content-Type": asset[1] });
      res.end(readFileSync(join(assets, asset[0])));
    } catch (error) {
      json(
        res,
        error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 503,
        {
          message:
            error instanceof z.ZodError
              ? error.issues
                  .map((i) => `${i.path.join(".")}: ${i.message}`)
                  .join("; ")
              : error instanceof SyntaxError
                ? "Invalid JSON"
                : "Request could not be completed. Check the factory log.",
        },
      );
    }
  });
  server.requestTimeout = 200_000;
  server.headersTimeout = 15_000;
  server.maxConnections = 100;
  return server;
}

export function webSettings(env = process.env) {
  const config = webConfigSchema.parse({
    host: env.FACTORY_WEB_HOST,
    port: env.FACTORY_WEB_PORT ? Number(env.FACTORY_WEB_PORT) : undefined,
    publicOrigin: env.FACTORY_PUBLIC_ORIGIN,
  });
  const mode = z.enum(["oidc", "pairing"]).parse(env.FACTORY_AUTH_MODE);
  const oidc =
    mode === "oidc"
      ? oidcSchema.parse({
          issuer: env.OIDC_ISSUER,
          clientId: env.OIDC_CLIENT_ID,
          clientSecret: env.OIDC_CLIENT_SECRET,
          requiredGroup: env.OIDC_REQUIRED_GROUP,
          sessionHours: env.OIDC_SESSION_HOURS,
          recheckSeconds: env.OIDC_RECHECK_SECONDS,
        })
      : undefined;
  if (oidc && !config.publicOrigin.startsWith("https:"))
    throw new Error("SSO requires HTTPS");
  const secret = env.FACTORY_WEB_SESSION_SECRET ?? "";
  if (!oidc && secret.length < 32)
    throw new Error(
      "Set FACTORY_WEB_SESSION_SECRET to at least 32 random characters",
    );
  return { config, secret, oidc };
}
