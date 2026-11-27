#!/usr/bin/env python3
"""Run the native navigation test against Factory's existing ticket fixture."""
import base64
import functools
import hashlib
from html import escape
import json
import os
from pathlib import Path
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import secrets
import subprocess
import tempfile
from threading import Thread
from urllib.parse import parse_qs, urlencode, urlsplit

ios = Path(__file__).resolve().parent
root = ios.parent
fixture = root / "test/browser"

class SignInFixture(SimpleHTTPRequestHandler):
    """A test identity that returns through the same browser callback and cookie boundary as Factory."""
    cookie = "fixture=" + secrets.token_urlsafe()
    grants = {}
    first_page = True
    first_run = True

    def reply(self, status, body=b"", **headers):
        self.send_response(status)
        for key, value in headers.items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlsplit(self.path)
        if url.path == "/runs/link-first" and SignInFixture.first_run:
            SignInFixture.first_run = False
            return self.reply(404)  # The public gateway serves only Apple's association file.
        if url.path.startswith("/runs/link-"):
            # A unique page and query show which URL the scene actually loaded.
            return self.reply(200, f"<p>{escape(self.path)}</p>".encode(), **{"Content-Type": "text/html"})
        if url.path == "/" and SignInFixture.first_page:
            SignInFixture.first_page = False
            return self.reply(503)
        if url.path == "/api/auth":
            return self.reply(200, b'{"nativeHandoff":true}', **{"Content-Type": "application/json"})
        if url.path == "/auth/login":
            challenge = parse_qs(url.query).get("native_challenge", [""])[0]
            if not challenge:
                return self.reply(400)
            code = secrets.token_urlsafe(32)
            self.grants[code] = challenge
            callback = "house.thezoo.t3factory://sign-in?" + urlencode({"state": challenge, "code": code})
            return self.reply(302, Location=callback)
        if url.path == "/" and self.cookie not in self.headers.get("Cookie", "").split("; "):
            return self.reply(200, b"""<meta name="viewport" content="width=device-width"><body style="display:grid;min-height:80vh;place-items:center">
                              <button style="padding:16px" onclick="location.href='/auth/login'">Sign in with SSO</button>""",
                              **{"Content-Type": "text/html"})
        super().do_GET()

    def do_POST(self):
        if self.path != "/api/auth/native/exchange":
            return self.reply(404)
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        challenge = base64.urlsafe_b64encode(hashlib.sha256(body["verifier"].encode()).digest()).decode().rstrip("=")
        if self.grants.pop(body["code"], None) != challenge:
            return self.reply(403)
        self.reply(200, b'{"returnTo":"/"}', **{"Content-Type": "application/json",
                  "Set-Cookie": self.cookie + "; Path=/; HttpOnly; SameSite=Lax"})

    def log_request(self, code="-", size="-"):
        # Keep callback parameters and session cookies out of the test log.
        print(self.command, urlsplit(self.path).path, code, flush=True)


with tempfile.TemporaryDirectory() as directory:
    site = Path(directory)
    for resource in (root / "web").iterdir():
        if resource.name != "index.html":
            (site / resource.name).symlink_to(resource)
    # Both the fixture and the app must import the same instances of the router and store.
    (site / "index.html").write_text((fixture / "ticket.html").read_text().replace("/web/style.css", "/style.css"))
    (site / "ticket.js").write_text((fixture / "ticket.js").read_text().replace("../../web/", "/"))
    handler = functools.partial(SignInFixture, directory=site)
    with ThreadingHTTPServer(("localhost", 0), handler) as server:
        Thread(target=server.serve_forever, daemon=True).start()
        subprocess.run([
            "xcodebuild", "-quiet", "-project", str(ios / "Factory.xcodeproj"),
            "-scheme", "Factory", "-configuration", "Debug", "-parallel-testing-enabled", "NO",
            "-destination", os.getenv("FACTORY_SIMULATOR", "platform=iOS Simulator,name=iPhone Duo,OS=27.1"),
            "FACTORY_HOST=localhost:" + str(server.server_port), "test",
        ], check=True)
