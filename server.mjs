#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const PORT = Number(process.env.PORT || 3000);
const ROOT = process.cwd();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const server = createServer(async (req, res) => {
  try {
    const reqUrl = new URL(req.url || "/", `http://localhost:${PORT}`);

    // Built-in Geocoding Proxy (/api/geocode) -> Photon OpenStreetMap API
    if (reqUrl.pathname === "/api/geocode") {
      const q = (reqUrl.searchParams.get("q") || "").trim();
      const lang = (reqUrl.searchParams.get("lang") || "en").slice(0, 2);
      if (q.length < 2) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ results: [] }));
        return;
      }
      try {
        const upstream = await fetch(
          `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lang=${lang === "hi" ? "en" : lang}`
        );
        const data = await upstream.json();
        const results = (data.features || [])
          .map((f) => {
            const coords = f.geometry?.coordinates;
            if (!coords) return null;
            const p = f.properties || {};
            const mainText = p.name || p.street || p.city || q;
            const subText = [p.district, p.city, p.state, p.country]
              .filter((x) => x && x !== mainText)
              .slice(0, 3)
              .join(", ");
            return {
              displayName: subText ? `${mainText}, ${subText}` : mainText,
              mainText,
              subText,
              lat: Number(coords[1]),
              lng: Number(coords[0]),
              provider: "photon",
            };
          })
          .filter(Boolean);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ results }));
      } catch {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ results: [] }));
      }
      return;
    }

    let pathname = reqUrl.pathname === "/" ? "/index.html" : reqUrl.pathname;
    if (pathname === "/manifest.webmanifest" || pathname === "/sw.js") {
      pathname = `/public${pathname}`;
    }

    const safePath = normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, "");
    const filePath = join(ROOT, safePath);
    const content = await readFile(filePath);
    const ext = extname(filePath).toLowerCase();

    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    });
    res.end(content);
  } catch {
    // SPA fallback to index.html
    try {
      const indexHtml = await readFile(join(ROOT, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(indexHtml);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    }
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n🚨 CERS v2.0 Live Server running at: http://localhost:${PORT}\n`);
});
