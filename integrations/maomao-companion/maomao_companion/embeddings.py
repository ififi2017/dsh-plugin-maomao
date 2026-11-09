"""Optional OpenRouter embeddings. No secrets, text logs or arbitrary endpoints."""
from __future__ import annotations

import concurrent.futures
import contextvars
import hashlib
import json
import math
import re
import sqlite3
import threading
import time
import urllib.request
from datetime import datetime
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

from .dialogue import speaker_and_text

MODELS = {"qwen/qwen3-embedding-8b", "baai/bge-m3"}
PERSONAL_QUERY = re.compile(r"^(?:我|我的|之前我|上次我|你(?:还)?记得我|还记得我|关于我)")
LEXICAL_PARTS = re.compile(r"[\u4e00-\u9fff]+|[a-z0-9]+", re.I)
LEXICAL_STOP = {"我", "我的", "你", "你的", "什么", "之前", "记得", "现在", "今天", "最近", "关于"}


def lexical_tokens(text):
    tokens = set()
    for part in LEXICAL_PARTS.findall(str(text).lower()):
        if part in LEXICAL_STOP:
            continue
        if re.fullmatch(r"[\u4e00-\u9fff]+", part):
            tokens.update(part[i:i+2] for i in range(len(part)-1))
        elif len(part) >= 2:
            tokens.add(part)
    return tokens


def lexical_score(query, document):
    query_tokens = lexical_tokens(query)
    if not query_tokens:
        return 0.0
    matched = query_tokens & lexical_tokens(document["text"])
    if not matched:
        return 0.0
    key = str(document["record"].get("topic", ""))
    exact = bool(len(key) >= 2 and key.lower() in query.lower())
    score = len(matched) / len(query_tokens)
    return min(0.95, 0.55 + 0.4*score) if exact else (0.5 + 0.3*score if len(matched) >= 2 and score >= 0.35 else 0.0)


def signature(text):
    return hashlib.sha256(text.encode()).hexdigest()


def normalized(vector, dimensions):
    if not isinstance(vector, list) or len(vector) != dimensions or any(type(x) not in (int, float) or not math.isfinite(x) for x in vector):
        raise ValueError("invalid embedding vector")
    norm = math.sqrt(sum(x*x for x in vector))
    if not math.isfinite(norm) or norm < 1e-12:
        raise ValueError("empty embedding vector")
    return [x/norm for x in vector]


def host_key(model):
    # Official resolver honors configured profile and credential pools. Never borrow a key
    # from an unrelated custom endpoint, and never persist or print the runtime object.
    from hermes_cli.runtime_provider import resolve_runtime_provider
    runtime = resolve_runtime_provider(requested="openrouter", target_model=model)
    if runtime.get("provider") != "openrouter" or urlparse(runtime.get("base_url", "")).hostname != "openrouter.ai":
        raise PermissionError("canonical OpenRouter account required")
    key = runtime.get("api_key")
    if not isinstance(key, str) or not key:
        raise PermissionError("OpenRouter credential unavailable")
    return key


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise PermissionError("embedding redirects are disabled")


class OpenRouterEmbeddings:
    def __init__(self, model="qwen/qwen3-embedding-8b", dimensions=1024, key_provider=host_key):
        if model not in MODELS or type(dimensions) is not int or dimensions != 1024:
            raise ValueError("unsupported embedding model/dimensions")
        self.model, self.dimensions, self.key_provider = model, dimensions, key_provider

    def embed(self, texts, query=False, timeout=10):
        if not isinstance(texts, list) or not 1 <= len(texts) <= 16 or any(not isinstance(t, str) or not t.strip() or len(t) > 600 for t in texts):
            raise ValueError("embedding input exceeds bounds")
        inputs = texts
        if query and self.model.startswith("qwen/"):
            inputs = ["Instruct: Retrieve relevant personal preferences and past conversation notes for the user query.\nQuery: "+t for t in texts]
        payload = {"model": self.model, "input": inputs, "dimensions": self.dimensions, "encoding_format": "float",
                   "provider": {"only": ["DeepInfra"], "data_collection": "deny", "max_price": {"prompt": 0.02}}}
        request = urllib.request.Request("https://openrouter.ai/api/v1/embeddings", data=json.dumps(payload).encode(),
                    headers={"Authorization": "Bearer "+self.key_provider(self.model), "Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.build_opener(NoRedirect()).open(request, timeout=timeout) as response:
                raw = response.read(2_000_001)
            if len(raw) > 2_000_000:
                raise ValueError("embedding response too large")
            result = json.loads(raw)
            if str(result.get("model", "")).lower() != self.model.lower():
                raise ValueError("embedding model mismatch")
            rows = result["data"]
            if not isinstance(rows, list) or len(rows) != len(texts) or any(not isinstance(r, dict) or type(r.get("index")) is not int for r in rows) or sorted(r.get("index") for r in rows) != list(range(len(texts))):
                raise ValueError("embedding response indices mismatch")
            return [normalized(row["embedding"], self.dimensions) for row in sorted(rows, key=lambda r: r["index"])]
        except Exception:
            # Provider errors may contain submitted text/headers. Expose a fixed error only.
            raise RuntimeError("embedding request unavailable") from None


class GoogleEmbeddings:
    model = "google/gemini-embedding-001"
    dimensions = 1024

    def __init__(self, key_provider):
        self.key_provider = key_provider

    def embed(self, texts, query=False, timeout=10):
        if not isinstance(texts, list) or not 1 <= len(texts) <= 16 or any(not isinstance(t, str) or not t.strip() or len(t) > 600 for t in texts):
            raise ValueError("embedding input exceeds bounds")
        model = "models/gemini-embedding-001"
        payload = {"requests": [{"model": model, "content": {"parts": [{"text": text}]},
                                 "taskType": "RETRIEVAL_QUERY" if query else "RETRIEVAL_DOCUMENT",
                                 "outputDimensionality": self.dimensions} for text in texts]}
        request = urllib.request.Request(f"https://generativelanguage.googleapis.com/v1beta/{model}:batchEmbedContents",
                    data=json.dumps(payload).encode(), headers={"x-goog-api-key": self.key_provider(self.model),
                    "Content-Type": "application/json"}, method="POST")
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=timeout) as response:
            raw = response.read(2_000_001)
        if len(raw) > 2_000_000:
            raise ValueError("embedding response too large")
        rows = json.loads(raw)["embeddings"]
        if not isinstance(rows, list) or len(rows) != len(texts):
            raise ValueError("embedding count mismatch")
        return [normalized(row["values"], self.dimensions) for row in rows]


def embedding_client(model, key_provider):
    if model == GoogleEmbeddings.model:
        return GoogleEmbeddings(key_provider)
    return OpenRouterEmbeddings(model=model, key_provider=key_provider)


class SemanticMemory:
    def __init__(self, store, client, allowed, query_seconds=2, threshold=0.5, daily_limit=200):
        self.store, self.client, self.allowed = store, client, allowed
        if not 0 < query_seconds <= 3 or not 0 <= threshold <= 1 or not 1 <= daily_limit <= 500:
            raise ValueError("invalid semantic retrieval limits")
        self.query_seconds, self.threshold, self.daily_limit = query_seconds, threshold, daily_limit
        self.closed = False
        self.lock = threading.Lock()
        self.future = None
        self.pool = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="companion-query")
        with store.db() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS memory_vectors(
                  scope TEXT NOT NULL,id TEXT NOT NULL,model TEXT NOT NULL,dimensions INTEGER NOT NULL,
                  signature TEXT NOT NULL,vector TEXT NOT NULL,updated REAL NOT NULL,
                  PRIMARY KEY(scope,id,model,dimensions));
                CREATE TABLE IF NOT EXISTS query_vectors(
                  scope TEXT NOT NULL,id TEXT NOT NULL,model TEXT NOT NULL,dimensions INTEGER NOT NULL,
                  vector TEXT NOT NULL,updated REAL NOT NULL,PRIMARY KEY(scope,id,model,dimensions));
                CREATE TABLE IF NOT EXISTS embedding_calls(scope TEXT NOT NULL,day TEXT NOT NULL,created REAL NOT NULL);
            """)
        self.fts_available = False
        try:
            with store.db() as db:
                db.execute("CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(scope UNINDEXED,doc_id UNINDEXED,speaker_id UNINDEXED,tokens)")
                db.execute("CREATE TABLE IF NOT EXISTS memory_fts_meta(scope TEXT NOT NULL,id TEXT NOT NULL,signature TEXT NOT NULL,PRIMARY KEY(scope,id))")
            self.fts_available = True
        except sqlite3.OperationalError:
            # Keep bounded Python lexical matching on hosts without FTS5.
            pass

    def _allowed(self, job):
        return not self.closed and self.allowed(job)

    def _reserve_call(self, scope):
        now = time.time()
        day = datetime.fromtimestamp(now, ZoneInfo("Asia/Taipei")).date().isoformat()
        with self.store.db() as db:
            db.execute("DELETE FROM embedding_calls WHERE created<?", (now-7*86400,))
            used = db.execute("SELECT count(*) FROM embedding_calls WHERE scope=? AND day=?", (scope, day)).fetchone()[0]
            if used >= self.daily_limit:
                raise PermissionError("daily embedding budget exhausted")
            db.execute("INSERT INTO embedding_calls VALUES(?,?,?)", (scope, day, now))

    def _vectors(self, scope):
        with self.store.db() as db:
            return {r["id"]: dict(r) for r in db.execute("SELECT * FROM memory_vectors WHERE scope=? AND model=? AND dimensions=?", (scope, self.client.model, self.client.dimensions))}

    def progress(self, scope):
        docs = self.store.memory_documents(scope)
        rows = self._vectors(scope)
        return {"total": len(docs), "indexed": sum(rows.get(doc["id"], {}).get("signature") == signature(doc["text"]) for doc in docs)}

    def _sync_fts(self, scope, docs):
        if not self.fts_available:
            return
        current = {doc["id"]: doc for doc in docs}
        with self.store.db() as db:
            existing = {row["id"]: row["signature"] for row in db.execute(
                "SELECT id,signature FROM memory_fts_meta WHERE scope=?", (scope,))}
            for doc_id in existing.keys()-current.keys():
                db.execute("DELETE FROM memory_fts WHERE scope=? AND doc_id=?", (scope, doc_id))
                db.execute("DELETE FROM memory_fts_meta WHERE scope=? AND id=?", (scope, doc_id))
            for doc_id, doc in current.items():
                digest = signature(doc["text"])
                if existing.get(doc_id) == digest:
                    continue
                db.execute("DELETE FROM memory_fts WHERE scope=? AND doc_id=?", (scope, doc_id))
                tokens = lexical_tokens(doc["text"])
                if tokens:
                    speaker = doc["record"].get("speaker_id") or ""
                    db.execute("INSERT INTO memory_fts(scope,doc_id,speaker_id,tokens) VALUES(?,?,?,?)",
                               (scope, doc_id, speaker, " ".join(sorted(tokens))))
                db.execute("INSERT OR REPLACE INTO memory_fts_meta VALUES(?,?,?)", (scope, doc_id, digest))

    def _fts_candidates(self, scope, query, speaker_id="", personal=False):
        if not self.fts_available:
            return []
        tokens = sorted(lexical_tokens(query))[:24]
        if not tokens:
            return []
        expression = " OR ".join('"' + token.replace('"', "") + '"' for token in tokens)
        try:
            with self.store.db() as db:
                if personal:
                    rows = db.execute(
                        "SELECT doc_id FROM memory_fts WHERE memory_fts MATCH ? AND scope=? AND (speaker_id=? OR speaker_id='') ORDER BY bm25(memory_fts) LIMIT 20",
                        (expression, scope, speaker_id)).fetchall()
                else:
                    rows = db.execute(
                        "SELECT doc_id FROM memory_fts WHERE memory_fts MATCH ? AND scope=? ORDER BY bm25(memory_fts) LIMIT 20",
                        (expression, scope)).fetchall()
            return [row[0] for row in rows]
        except sqlite3.OperationalError:
            return []

    def index(self, job, historical_only=False):
        if not self._allowed(job):
            return 0
        docs = self.store.memory_documents(job["scope"])
        self._sync_fts(job["scope"], docs)
        existing = self._vectors(job["scope"])
        missing = [doc for doc in docs if doc["id"] not in existing or existing[doc["id"]]["signature"] != signature(doc["text"])][:16]
        if historical_only:
            missing = [doc for doc in missing if doc["kind"] == "historical_note"]
        # Remove expired/superseded records even if no network call is needed.
        current = {doc["id"]: signature(doc["text"]) for doc in docs}
        with self.store.db() as db:
            for key, row in existing.items():
                if current.get(key) != row["signature"]:
                    db.execute("DELETE FROM memory_vectors WHERE scope=? AND id=? AND model=? AND dimensions=?", (job["scope"], key, self.client.model, self.client.dimensions))
        if not missing or not self._allowed(job):
            return 0
        self._reserve_call(job["scope"])
        vectors = self.client.embed([doc["text"][:600] for doc in missing])
        if not self._allowed(job):
            return 0
        current = {doc["id"]: signature(doc["text"]) for doc in self.store.memory_documents(job["scope"])}
        count = 0
        with self.store.db() as db:
            for doc, vector in zip(missing, vectors):
                if current.get(doc["id"]) != signature(doc["text"]):
                    continue
                vector = normalized(vector, self.client.dimensions)
                db.execute("INSERT OR REPLACE INTO memory_vectors VALUES(?,?,?,?,?,?,?)", (job["scope"], doc["id"], self.client.model, self.client.dimensions, signature(doc["text"]), json.dumps(vector), time.time()))
                count += 1
        return count

    def _cached_query(self, scope, query):
        with self.store.db() as db:
            row = db.execute("SELECT vector FROM query_vectors WHERE scope=? AND id=? AND model=? AND dimensions=? AND updated>?", (scope, signature(query), self.client.model, self.client.dimensions, time.time()-86400)).fetchone()
        return normalized(json.loads(row[0]), self.client.dimensions) if row else None

    def _query(self, job, query):
        if not self._allowed(job):
            return None
        self._reserve_call(job["scope"])
        vector = self.client.embed([query], query=True, timeout=5)[0]
        vector = normalized(vector, self.client.dimensions)
        if not self._allowed(job):
            return None
        with self.store.db() as db:
            db.execute("INSERT OR REPLACE INTO query_vectors VALUES(?,?,?,?,?,?)", (job["scope"], signature(query), self.client.model, self.client.dimensions, json.dumps(vector), time.time()))
            db.execute("DELETE FROM query_vectors WHERE scope=? AND rowid NOT IN (SELECT rowid FROM query_vectors WHERE scope=? ORDER BY updated DESC LIMIT 64)", (job["scope"], job["scope"]))
        return vector

    def recall(self, job, query):
        if not self._allowed(job):
            return []
        query = str(query).strip()[:300]
        if not query:
            return []
        speaker_id, plain_query = speaker_and_text(query)
        personal = bool(speaker_id and PERSONAL_QUERY.match(plain_query.strip()))
        docs = {doc["id"]: doc for doc in self.store.memory_documents(job["scope"])
                if not (personal and doc["record"].get("speaker_id")
                        and doc["record"]["speaker_id"] != speaker_id)}
        if not docs or not self.store.current(job["scope"], job["version"]):
            return []
        lexical = {key: lexical_score(plain_query, doc) for key, doc in docs.items()}
        scored = {key: value for key, value in lexical.items() if value >= 0.6}
        for rank, key in enumerate(self._fts_candidates(job["scope"], plain_query, speaker_id, personal)):
            if key in docs and lexical.get(key, 0) >= 0.6:
                scored[key] = max(scored.get(key, 0), min(0.9, 0.78/(1+0.08*rank)))
        rows = [row for key, row in self._vectors(job["scope"]).items()
                if key in docs and row["signature"] == signature(docs[key]["text"])]
        if rows:
            vector = self._cached_query(job["scope"], query)
            if vector is None:
                with self.lock:
                    # No unbounded queue when a provider is slow. Keep local lexical hits.
                    if self.future is not None and not self.future.done():
                        future = None
                    else:
                        context = contextvars.copy_context()
                        self.future = self.pool.submit(context.run, self._query, job, query)
                        future = self.future
                if future is not None:
                    try:
                        vector = future.result(timeout=self.query_seconds)
                    except Exception:
                        vector = None
            if vector is not None:
                for row in rows:
                    embedded = normalized(json.loads(row["vector"]), self.client.dimensions)
                    score = sum(a*b for a,b in zip(vector, embedded))
                    if score >= self.threshold:
                        scored[row["id"]] = max(scored.get(row["id"], 0), score)
        if not self._allowed(job) or not self.store.current(job["scope"], job["version"]):
            return []
        ranked = sorted(((score, docs[key]) for key, score in scored.items()),
                        key=lambda pair: (-pair[0], pair[1]["id"]))
        if not ranked:
            return []
        # A much weaker second hit should not pull unrelated memories into the reply.
        return [{"kind": doc["kind"], **doc["record"]} for score,doc in ranked[:3] if score >= ranked[0][0]-0.12]

    def close(self):
        self.closed = True
        self.pool.shutdown(wait=False, cancel_futures=True)
