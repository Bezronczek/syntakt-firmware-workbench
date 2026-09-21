"""Local test server for the site: like `python -m http.server`, but never lets the browser cache.
Browsers cache ES modules aggressively; without this, edits to js/*.js do not show up even after Ctrl+F5.
    python web/dev/serve.py [port]      (serves the web/ folder on 127.0.0.1)
"""
import os, sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

class NoCache(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
print(f"serving {os.getcwd()} on http://127.0.0.1:{port}/ (no caching)")
ThreadingHTTPServer(("127.0.0.1", port), NoCache).serve_forever()
