"""Throwaway harness: emulate the Zotero local HTTP server on 127.0.0.1:23119 and run the real
probe against each documented state. Not part of the package; lives in /tmp on purpose."""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE = {"mode": "ready"}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _send(self, code, body, ctype="application/json", extra=None):
        raw = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        host = self.headers.get("Host", "")
        ua = self.headers.get("User-Agent", "")
        allowed = self.headers.get("Zotero-Allowed-Request")
        api_version = self.headers.get("Zotero-API-Version")
        mode = STATE["mode"]

        if self.path.startswith("/connector/"):
            if mode == "pref_off":
                return self._send(200, "Zotero is running", "text/plain")
            return self._send(200, "Zotero is running", "text/plain")

        # /api/...
        if mode == "pref_off":
            return self._send(403, '{"error":"Local API is disabled"}')
        if mode == "host_strict" and host != "localhost:23119":
            return self._send(403, '{"error":"Invalid Host header"}')
        if mode == "needs_allowed_header" and allowed != "1":
            # Zotero 10 reportedly drops browser-looking requests silently; emulate a hard refusal.
            return self._send(403, '{"error":"Missing Zotero-Allowed-Request"}')
        if mode == "no_format_json" and "format=json" in self.path:
            return self._send(404, '<html><body>404 Not Found</body></html>', "text/html")
        if mode == "needs_auth":
            return self._send(401, '{"error":"Authentication required"}')
        if mode == "html_ok":
            return self._send(200, "<html><body>[]</body></html>", "text/html")
        if mode == "ready":
            body = json.dumps([{"key": "ABCD1234", "data": {"name": "Literature", "parentCollection": False}}])
            return self._send(200, body, "application/json",
                              {"Zotero-Server-ID": "12345", "Zotero-API-Version": "3"})
        if mode == "empty_list":
            return self._send(200, "[]", "application/json", {"Zotero-Server-ID": "12345"})
        if mode == "silent_drop":
            # Close without answering.
            self.close_connection = True
            self.connection.close()
            return
        return self._send(404, '{"error":"unknown emulation"}')


def run_state(mode):
    STATE["mode"] = mode
    from research_stack import integrations
    try:
        result = integrations.probe_zotero()
    except Exception as exc:  # a crash is itself a finding
        return {"outcome": "CRASH", "code": type(exc).__name__, "detail": str(exc)}
    return result


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 23119), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    modes = ["ready", "empty_list", "pref_off", "host_strict", "needs_allowed_header",
             "no_format_json", "needs_auth", "html_ok", "silent_drop"]
    for mode in modes:
        print(f"--- {mode} ---")
        print(json.dumps(run_state(mode), ensure_ascii=False))
    server.shutdown()


if __name__ == "__main__":
    main()
