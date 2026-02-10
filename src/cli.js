#!/usr/bin/env node
import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { spawn } from "node:child_process";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    out[k] = v;
  }
  return out;
}

function openBrowser(url) {
  const plat = process.platform;
  const cmd =
    plat === "darwin" ? "open" : plat === "win32" ? "cmd" : "xdg-open";
  const args = plat === "win32" ? ["/c", "start", "", url] : [url];
  spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
}

function proxyRequest(target, req, res) {
  const u = new URL(target);
  const isHttps = u.protocol === "https:";
  const libReq = isHttps ? httpsRequest : httpRequest;

  const opts = {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || (isHttps ? 443 : 80),
    method: req.method,
    path: req.url,
    headers: { ...req.headers, host: u.host },
  };

  const p = libReq(opts, (pr) => {
    res.writeHead(pr.statusCode || 500, pr.headers);
    pr.pipe(res);
  });

  p.on("error", (e) => {
    res.statusCode = 502;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(`Proxy error: ${e.message}`);
  });

  req.pipe(p);
}

const args = parseArgs(process.argv.slice(2));
const target = args.url || "http://localhost:5173";
const entry = args.entry || "/src/main.js";
const port = Number(args.port || "8787");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const uiDir = path.join(__dirname, "ui");

const encoderHtmlPath = path.join(uiDir, "encoder.html");
const encoderJsPath = path.join(uiDir, "encoder.js");
const previewHtmlPath = path.join(uiDir, "preview.html");
const previewJsPath = path.join(uiDir, "preview.js");

const libWorkerPath = path.join(__dirname, "worker.js");
const libBrowserIndexPath = path.join(__dirname, "browser", "index.js");

const server = http.createServer((req, res) => {
  const full = req.url || "/";
  const urlObj = new URL(full, "http://localhost");
  const pathname = urlObj.pathname;

  if (pathname === "/favicon.ico") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (pathname === "/__pa_encoder__/encoder") {
    const html = readFileSync(encoderHtmlPath, "utf-8");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
    return;
  }

  if (pathname === "/__pa_encoder__/ui/encoder.js") {
    const js = readFileSync(encoderJsPath, "utf-8");
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.end(js);
    return;
  }

  if (pathname === "/__pa_encoder__/ui/preview.html") {
    const html = readFileSync(previewHtmlPath, "utf-8");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
    return;
  }

  if (pathname === "/__pa_encoder__/ui/preview.js") {
    const js = readFileSync(previewJsPath, "utf-8");
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.end(js);
    return;
  }

  // Browser UI에서 import할 라이브러리 엔트리
  if (pathname === "/__pa_encoder__/lib/index.js") {
    const lib = readFileSync(libBrowserIndexPath, "utf-8");
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.end(lib);
    return;
  }

  // lib/index.js가 import.meta.url 기준 ./worker.js를 로드할 수 있도록
  if (pathname === "/__pa_encoder__/lib/worker.js") {
    const w = readFileSync(libWorkerPath, "utf-8");
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.end(w);
    return;
  }

  proxyRequest(target, req, res);
});

server.listen(port, () => {
  const uiUrl =
    `http://localhost:${port}/__pa_encoder__/encoder` +
    `?entry=${encodeURIComponent(entry)}`;

  console.log(`[pa_encoder] target: ${target}`);
  console.log(`[pa_encoder] entry : ${entry}`);
  console.log(`[pa_encoder] ui    : ${uiUrl}`);

  openBrowser(uiUrl);
});
