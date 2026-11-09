"""Read a fixed public feed and keep its pending shares outside chat memory."""
from contextlib import closing, contextmanager
from email.utils import parsedate_to_datetime
from hashlib import sha256
from html import unescape
from pathlib import Path
import re
import sqlite3
import time
from urllib.parse import urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from xml.etree import ElementTree


FEED = "https://www.nasa.gov/feed/"
HOSTS = {"www.nasa.gov", "nasa.gov", "science.nasa.gov"}
MAX_BYTES = 512 * 1024


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def read_feed():
    request = Request(FEED, headers={"User-Agent": "Maomao-Harness/1.0", "Accept": "application/rss+xml, application/xml"})
    with build_opener(NoRedirect()).open(request, timeout=7) as response:
        return response.read(MAX_BYTES + 1)


def entries(payload, now):
    if len(payload) > MAX_BYTES or re.search(br"<!\s*(?:DOCTYPE|ENTITY)\b", payload, re.I):
        raise ValueError("invalid_public_feed")
    for item in ElementTree.fromstring(payload).findall("./channel/item")[:20]:
        try:
            published = parsedate_to_datetime(item.findtext("pubDate", ""))
            if published.tzinfo is None or not now - 7 * 86400 <= published.timestamp() <= now + 300:
                continue
            link = urlsplit(item.findtext("link", ""))
            if (link.scheme != "https" or link.netloc not in HOSTS or not link.path.startswith("/")
                    or len(link.path) > 900 or any(c.isspace() or ord(c) < 32 for c in link.path)):
                continue
        except (TypeError, ValueError, OverflowError):
            continue
        title = " ".join(re.sub(r"<[^>]+>", " ", unescape(item.findtext("title", ""))).split())
        if not title or len(title) > 100 or re.search(r"https?://|tg://|<@", title, re.I):
            continue
        url = urlunsplit((link.scheme, link.netloc, link.path, "", ""))
        yield sha256(url.rstrip("/").encode()).hexdigest(), url, title, published.timestamp()


@contextmanager
def transaction(path):
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with closing(sqlite3.connect(path, timeout=4)) as db, db:
        path.chmod(0o600)
        db.execute("BEGIN IMMEDIATE")
        db.execute("CREATE TABLE IF NOT EXISTS runs (started REAL PRIMARY KEY)")
        db.execute("""CREATE TABLE IF NOT EXISTS articles (id TEXT PRIMARY KEY, url TEXT NOT NULL,
                    title TEXT NOT NULL, published REAL NOT NULL, shared INTEGER NOT NULL DEFAULT 0)""")
        yield db


def candidate(path, now=None, fetch=read_feed):
    now = time.time() if now is None else now
    with transaction(path) as db:
        db.execute("DELETE FROM runs WHERE started<=?", (now - 86400,))
        db.execute("DELETE FROM articles WHERE published<?", (now - 7 * 86400,))
        count, last = db.execute("SELECT count(*), max(started) FROM runs").fetchone()
        read = count < 4 and (last is None or now - last >= 7200)
        if read:
            db.execute("INSERT INTO runs VALUES (?)", (now,))
    if read:
        try:
            found = list(entries(fetch(), now))
        except (OSError, ValueError, ElementTree.ParseError):
            found = []
        with transaction(path) as db:
            db.executemany("INSERT OR IGNORE INTO articles(id,url,title,published) VALUES (?,?,?,?)", found)
    with transaction(path) as db:
        row = db.execute("SELECT id,url,title FROM articles WHERE shared=0 ORDER BY published DESC,id LIMIT 1").fetchone()
    if not row:
        return {}
    article, url, title = row
    return {"requestId": article, "source": "activity", "text": f"刚刷到 NASA 的一篇新文章喵：《{title}》", "url": url}


def mark_shared(path, article):
    with transaction(path) as db:
        db.execute("UPDATE articles SET shared=1 WHERE id=?", (article,))
