# Main text of one HTML page for the router demo (src/lesen/trafilatura.mjs).
# stdin: JSON {"html": "...", "url": "..."} (UTF-8). stdout: one JSON line, ASCII only
# {"ok": true, "text": "<markdown>", "titel": "..."} or {"ok": false, "error": "..."}.
# As measured (router-ausbau/schritt1-seite-lesen): trafilatura 2.3.1, output_format markdown,
# no comments. Always run with -I (isolated: no PYTHON* variables, no script directory on sys.path);
# the caller holds the time limit and ends the process.
import json
import sys


def main():
    try:
        req = json.loads(sys.stdin.buffer.read().decode("utf-8"))
        html, url = req.get("html") or "", req.get("url") or None
    except Exception as e:
        return {"ok": False, "error": "Eingabe: %s" % type(e).__name__}
    try:
        import trafilatura
        from trafilatura.settings import use_config
        cfg = use_config()
        cfg.set("DEFAULT", "EXTRACTION_TIMEOUT", "0")  # signal based, not on Windows; the caller kills
        text = trafilatura.extract(html, url=url, output_format="markdown", include_comments=False, config=cfg) or ""
        titel = None
        try:
            meta = trafilatura.extract_metadata(html, default_url=url)
            titel = meta.title if meta else None
        except Exception:
            pass
        return {"ok": True, "text": text, "titel": titel}
    except Exception as e:
        return {"ok": False, "error": "trafilatura: %s: %s" % (type(e).__name__, str(e)[:200])}


if __name__ == "__main__":
    sys.stdout.write(json.dumps(main(), ensure_ascii=True) + "\n")
    sys.stdout.flush()
