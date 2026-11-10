"""Scoped ordinary-chat state. Never import private memories or legacy transcripts."""
from __future__ import annotations

import json
import hashlib
import re
import sqlite3
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

MOODS = {"calm", "happy", "curious", "concerned", "playful", "tired"}
STATES = {"open", "resolved", "paused"}
# Anchored, attributable statements only. Questions, conditionals and quoted code do not qualify.
PREFERENCE = re.compile(r"^我(更喜欢|最喜欢|很喜欢|特别喜欢|不太喜欢|不喜欢|喜欢|讨厌)([^\n，,。！？!?；;]{2,50})[。！!～~]?$")
PREFERENCE_QUERY = re.compile(r"我(?:更|最|很|特别)?(?:不太喜欢|不喜欢|喜欢|讨厌)(?:的(?:是)?)?(?:什么|啥|哪(?:个|种|些|一类))")
SPEAKER = re.compile(r"^\[群成员 ([0-9a-f]{12})\] ")
LOW_INFO = re.compile(r"^(?:好(?:的|哦|呀)?|嗯+|喵+|猫猫|哈哈+|收到|在吗|晚安|早安|[！!？?。.…～~\s]+)$")
LOW_INFO_SUMMARY = re.compile(r"(?:只发了|只发送|没有附带文字|未附带文字|只喊了|简短回应|应了一声|打招呼)")
PRIVATE_FACT = re.compile(r"R[ -]?18|成人|性行为|性暗示|露骨|私密模式|角色扮演|色情|老公|老婆|婚姻|亲亲|主仆|欧尼酱", re.I)
PREFERENCE_CUE = re.compile(r"喜欢|讨厌|偏好|希望|更想|更愿意|倾向|不要")
PROJECT_CUE = re.compile(r"在做|开发|维护|设计|上线|发布|运营|筹备|更新|在忙|项目|正在写|正在建|研究|测试")
PROJECT_END = re.compile(r"^(?:我|俺|咱).{0,12}(?:不做|停做|取消|放弃|做完|完成|结束|收尾了)")
MEMORY_TTL = {"preference": 365, "project": 30}


def speaker_and_text(text):
    speaker = SPEAKER.match(text)
    body = text[speaker.end():] if speaker else text
    if body.startswith("[Quoted message]:"):
        marker = "\n\n[Current message]:\n"
        if marker in body:
            body = body.rsplit(marker, 1)[1]
        elif "\n\n" in body:
            # Older QQ messages had no explicit boundary; the last paragraph
            # is the safest available approximation of the new user message.
            body = body.rsplit("\n\n", 1)[1]
        else:
            body = ""
    return (speaker[1] if speaker else ""), body


def indexable_episode(user_text, analysis):
    _, text = speaker_and_text(user_text)
    text = text.strip()
    if len(text) <= 1 or LOW_INFO.fullmatch(text) or (len(text) < 40 and LOW_INFO_SUMMARY.search(analysis["summary"])):
        return False
    if text.startswith("[") and text.endswith("]") and any(word in text for word in ("表情", "图片")):
        return False
    return True


class DialogueStore:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with self.db() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS turns(
                  scope TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL,
                  user_text TEXT NOT NULL, assistant_text TEXT NOT NULL,
                  received REAL NOT NULL, analysis TEXT,
                  PRIMARY KEY(scope,id));
                CREATE TABLE IF NOT EXISTS dialogue_state(
                  scope TEXT PRIMARY KEY, version INTEGER NOT NULL,
                  topic TEXT NOT NULL, status TEXT NOT NULL, summary TEXT NOT NULL,
                  mood TEXT NOT NULL, intensity INTEGER NOT NULL, updated REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS facts(
                  scope TEXT NOT NULL, topic TEXT NOT NULL, polarity INTEGER NOT NULL,
                  quote TEXT NOT NULL, source_id TEXT NOT NULL, updated REAL NOT NULL,
                  PRIMARY KEY(scope,topic));
                CREATE TABLE IF NOT EXISTS historical_notes(
                  scope TEXT NOT NULL,id TEXT NOT NULL,quote TEXT NOT NULL,source TEXT NOT NULL,
                  imported REAL NOT NULL,PRIMARY KEY(scope,id));
                CREATE TABLE IF NOT EXISTS durable_facts(
                  scope TEXT NOT NULL, speaker_id TEXT NOT NULL, kind TEXT NOT NULL,
                  key TEXT NOT NULL, statement TEXT NOT NULL, quote TEXT NOT NULL,
                  source_id TEXT NOT NULL, updated REAL NOT NULL, expires_at REAL NOT NULL,
                  PRIMARY KEY(scope,speaker_id,kind,key));
                CREATE TABLE IF NOT EXISTS memory_items(
                  id TEXT PRIMARY KEY, scope TEXT NOT NULL, speaker_id TEXT NOT NULL,
                  kind TEXT NOT NULL, key TEXT NOT NULL, statement TEXT NOT NULL,
                  quote TEXT NOT NULL, source_id TEXT NOT NULL, occurred_at REAL NOT NULL,
                  updated REAL NOT NULL, expires_at REAL NOT NULL, polarity INTEGER,
                  status TEXT NOT NULL, supersedes TEXT, confidence REAL NOT NULL);
                CREATE INDEX IF NOT EXISTS memory_items_lookup
                  ON memory_items(scope,speaker_id,status,kind,updated);
                CREATE TABLE IF NOT EXISTS memory_evidence(
                  item_id TEXT NOT NULL,source_id TEXT NOT NULL,quote TEXT NOT NULL,
                  occurred_at REAL NOT NULL,PRIMARY KEY(item_id,source_id));
                CREATE TABLE IF NOT EXISTS memory_cursor(
                  scope TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS memory_events(
                  scope TEXT NOT NULL,id TEXT NOT NULL,speaker_id TEXT NOT NULL,
                  version INTEGER NOT NULL,received REAL NOT NULL,content_hash TEXT NOT NULL,
                  status TEXT NOT NULL,updated REAL NOT NULL,PRIMARY KEY(scope,id));
                CREATE TABLE IF NOT EXISTS memory_migrations(name TEXT PRIMARY KEY);
            """)
            self._migrate_legacy(db)
            self._migrate_event_receipts(db)
        self.path.chmod(0o600)

    @staticmethod
    def _memory_id(scope, speaker_id, kind, key, source_id):
        return hashlib.sha256("\\0".join((scope, speaker_id, kind, key, source_id)).encode()).hexdigest()

    def _record_memory(self, db, scope, speaker_id, kind, key, statement, quote,
                       source_id, occurred_at, polarity=None, confidence=1.0):
        """Append a sourced revision; never silently overwrite a correction."""
        key = " ".join(key.strip().split())[:60]
        if kind not in MEMORY_TTL or not key or not quote or not source_id:
            return False
        item_id = self._memory_id(scope, speaker_id, kind, key, source_id)
        if db.execute("SELECT 1 FROM memory_items WHERE id=?", (item_id,)).fetchone():
            return False
        previous = db.execute(
            "SELECT id,statement,polarity,status,occurred_at FROM memory_items WHERE scope=? AND speaker_id=? AND kind=? AND key=? ORDER BY occurred_at DESC LIMIT 1",
            (scope, speaker_id, kind, key)).fetchone()
        old_arrival = bool(previous and occurred_at < previous["occurred_at"])
        if previous and previous["status"] == "active" and not old_arrival:
            old_status = "archived" if previous["statement"] == statement and previous["polarity"] == polarity else "superseded"
            db.execute("UPDATE memory_items SET status=? WHERE id=?", (old_status, previous["id"]))
        expires = occurred_at + MEMORY_TTL[kind]*86400
        db.execute("INSERT INTO memory_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                   (item_id, scope, speaker_id, kind, key, statement[:120], quote[:100],
                    source_id, occurred_at, occurred_at, expires, polarity,
                    "superseded" if old_arrival else "active",
                    previous["id"] if previous and not old_arrival else None, confidence))
        db.execute("INSERT INTO memory_evidence VALUES(?,?,?,?)", (item_id, source_id, quote[:100], occurred_at))
        return True

    def _migrate_legacy(self, db):
        if db.execute("SELECT 1 FROM memory_migrations WHERE name='sourced-items-v1'").fetchone():
            return
        for row in db.execute("SELECT * FROM facts ORDER BY updated").fetchall():
            self._record_memory(db, row["scope"], "", "preference", row["topic"],
                                row["quote"], row["quote"], row["source_id"],
                                row["updated"], row["polarity"])
        for row in db.execute("SELECT * FROM durable_facts ORDER BY updated").fetchall():
            polarity = (-1 if re.search(r"不喜欢|讨厌", row["quote"]) else 1) if row["kind"] == "preference" else None
            self._record_memory(db, row["scope"], row["speaker_id"], row["kind"],
                                row["key"], row["statement"], row["quote"],
                                row["source_id"], row["updated"], polarity)
        db.execute("INSERT INTO memory_migrations VALUES('sourced-items-v1')")

    def _migrate_event_receipts(self, db):
        if db.execute("SELECT 1 FROM memory_migrations WHERE name='event-receipts-v1'").fetchone():
            return
        for row in db.execute("SELECT * FROM turns").fetchall():
            speaker_id, _ = speaker_and_text(row["user_text"])
            status = "analyzed" if row["analysis"] is not None else "generated" if row["assistant_text"] else "accepted"
            db.execute("INSERT OR IGNORE INTO memory_events VALUES(?,?,?,?,?,?,?,?)",
                       (row["scope"], row["id"], speaker_id, row["version"], row["received"],
                        hashlib.sha256(row["user_text"].encode()).hexdigest(), status, row["received"]))
        db.execute("INSERT INTO memory_migrations VALUES('event-receipts-v1')")

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.path, isolation_level=None, timeout=3)
        db.row_factory = sqlite3.Row
        try:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("BEGIN IMMEDIATE")
            yield db
            if db.in_transaction:
                db.execute("COMMIT")
        except BaseException:
            if db.in_transaction:
                db.execute("ROLLBACK")
            raise
        finally:
            db.close()

    def begin(self, scope, turn_id, user_text, received, extract=True):
        text = str(user_text).strip()[:2000]
        speaker = SPEAKER.match(text)
        body = text[speaker.end():] if speaker else text
        if body.startswith("[Quoted message]:"):
            speaker_id, current_text = speaker_and_text(text)
            if not current_text.strip():
                return None
            text = ("[群成员 "+speaker_id+"] " if speaker_id else "") + current_text.strip()
        if not turn_id or not text or text.startswith("/"):
            return None
        with self.db() as db:
            old = db.execute("SELECT * FROM turns WHERE scope=? AND id=?", (scope, turn_id)).fetchone()
            if old:
                return dict(old)
            current = db.execute("SELECT version FROM dialogue_state WHERE scope=?", (scope,)).fetchone()
            version = (current[0] if current else 0)+1
            db.execute("INSERT INTO dialogue_state VALUES(?,?,'','open','','calm',0,?) ON CONFLICT(scope) DO UPDATE SET version=excluded.version", (scope, version, received))
            db.execute("INSERT INTO turns VALUES(?,?,?,?,?,?,NULL)", (scope, turn_id, version, text, "", received))
            speaker_id, body = speaker_and_text(text)
            db.execute("INSERT INTO memory_events VALUES(?,?,?,?,?,?,?,?)",
                       (scope, turn_id, speaker_id, version, received,
                        hashlib.sha256(text.encode()).hexdigest(), "accepted", received))
            match = PREFERENCE.fullmatch(body) if extract else None
            if match:
                topic = match[2].strip()
                if topic and not PRIVATE_FACT.search(body) and not any(x in topic for x in ("吗", "么", "如果", "的话", "是不是", "`", "http", "忽略", "指令", "系统")):
                    polarity = -1 if match[1] in {"不喜欢", "不太喜欢", "讨厌"} else 1
                    if speaker_id:
                        db.execute("INSERT INTO durable_facts VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(scope,speaker_id,kind,key) DO UPDATE SET statement=excluded.statement,quote=excluded.quote,source_id=excluded.source_id,updated=excluded.updated,expires_at=excluded.expires_at", (scope, speaker_id, "preference", topic, body, body, turn_id, received, received+365*86400))
                    else:
                        db.execute("INSERT INTO facts VALUES(?,?,?,?,?,?) ON CONFLICT(scope,topic) DO UPDATE SET polarity=excluded.polarity,quote=excluded.quote,source_id=excluded.source_id,updated=excluded.updated", (scope, topic, polarity, body, turn_id, received))
                    self._record_memory(db, scope, speaker_id, "preference", topic, body,
                                        body, turn_id, received, polarity)
            if (extract and PROJECT_END.search(body) and not PRIVATE_FACT.search(body)
                    and not any(x in body for x in ("?", "？", "如果", "假如", "`", "http"))):
                for old in db.execute(
                    "SELECT id,key FROM memory_items WHERE scope=? AND speaker_id=? AND kind='project' AND status='active'",
                    (scope, speaker_id)).fetchall():
                    if len(old["key"]) < 2 or old["key"] not in body:
                        continue
                    item_id = self._memory_id(scope, speaker_id, "project", old["key"], turn_id)
                    if db.execute("SELECT 1 FROM memory_items WHERE id=?", (item_id,)).fetchone():
                        continue
                    db.execute("UPDATE memory_items SET status='superseded' WHERE id=?", (old["id"],))
                    statement = "用户明确表示项目已完成" if re.search(r"做完|完成|结束", body) else "用户明确表示项目已停止"
                    db.execute("INSERT INTO memory_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                               (item_id, scope, speaker_id, "project", old["key"], statement,
                                body[:100], turn_id, received, received, received+30*86400,
                                None, "archived", old["id"], 1.0))
                    db.execute("INSERT INTO memory_evidence VALUES(?,?,?,?)",
                               (item_id, turn_id, body[:100], received))
            # Bounded ordinary chat retention; stable facts remain separately attributable.
            db.execute("DELETE FROM turns WHERE scope=? AND received<?", (scope, received-7*86400))
            db.execute("DELETE FROM turns WHERE scope=? AND id NOT IN (SELECT id FROM turns WHERE scope=? ORDER BY received DESC,version DESC LIMIT 100)", (scope, scope))
            db.execute("DELETE FROM facts WHERE scope=? AND topic NOT IN (SELECT topic FROM facts WHERE scope=? ORDER BY updated DESC LIMIT 100)", (scope, scope))
            db.execute("DELETE FROM durable_facts WHERE scope=? AND expires_at<?", (scope, received))
            db.execute("DELETE FROM durable_facts WHERE scope=? AND rowid NOT IN (SELECT rowid FROM durable_facts WHERE scope=? ORDER BY updated DESC LIMIT 100)", (scope, scope))
            db.execute("UPDATE memory_items SET status='expired' WHERE scope=? AND status='active' AND expires_at<?", (scope, received))
            obsolete = [r[0] for r in db.execute(
                "SELECT id FROM memory_items WHERE scope=? AND status!='active' AND updated<?",
                (scope, received-365*86400))]
            for item_id in obsolete:
                db.execute("DELETE FROM memory_evidence WHERE item_id=?", (item_id,))
                db.execute("DELETE FROM memory_items WHERE id=?", (item_id,))
            db.execute("DELETE FROM memory_events WHERE scope=? AND received<?",
                       (scope, received-30*86400))
            db.execute("DELETE FROM memory_events WHERE scope=? AND id NOT IN "
                       "(SELECT id FROM memory_events WHERE scope=? ORDER BY version DESC LIMIT 1000)",
                       (scope, scope))
            return dict(db.execute("SELECT * FROM turns WHERE scope=? AND id=?", (scope, turn_id)).fetchone())

    def turn(self, scope, turn_id):
        with self.db() as db:
            row = db.execute("SELECT * FROM turns WHERE scope=? AND id=?", (scope, turn_id)).fetchone()
            return dict(row) if row else None

    def finish(self, scope, turn_id, assistant_text):
        with self.db() as db:
            db.execute("UPDATE turns SET assistant_text=? WHERE scope=? AND id=? AND assistant_text=''", (str(assistant_text)[:2000], scope, turn_id))
            if assistant_text:
                db.execute("UPDATE memory_events SET status='generated',updated=? WHERE scope=? AND id=? AND status='accepted'",
                           (time.time(), scope, turn_id))

    def current(self, scope, version):
        with self.db() as db:
            row = db.execute("SELECT version FROM dialogue_state WHERE scope=?", (scope,)).fetchone()
            return bool(row and row[0] == version)

    def apply_analysis(self, scope, turn_id, result, now=None):
        now = time.time() if now is None else now
        base = {"topic", "status", "summary", "quote", "mood", "intensity"}
        if not isinstance(result, dict) or not base <= set(result) or set(result)-base not in (set(), {"long_term"}):
            return False
        if not isinstance(result["status"], str) or not isinstance(result["mood"], str) or result["status"] not in STATES or result["mood"] not in MOODS or type(result["intensity"]) is not int or not 0 <= result["intensity"] <= 3:
            return False
        if any(not isinstance(result[k], str) or len(result[k]) > size for k, size in (("topic", 60), ("summary", 160), ("quote", 100))):
            return False
        with self.db() as db:
            turn = db.execute("SELECT * FROM turns WHERE scope=? AND id=?", (scope, turn_id)).fetchone()
            state = db.execute("SELECT * FROM dialogue_state WHERE scope=?", (scope,)).fetchone()
            if not turn or not state or turn["analysis"] is not None:
                return False
            _, current_body = speaker_and_text(turn["user_text"])
            if not result["quote"] or result["quote"] not in current_body:
                return False
            # An old turn may still contribute sourced long-term memory, but must
            # never move the current topic or mood backwards.
            latest = turn["version"] == state["version"]
            if not latest:
                db.execute("UPDATE turns SET analysis=? WHERE scope=? AND id=?",
                           (json.dumps(result, ensure_ascii=False), scope, turn_id))
                db.execute("UPDATE memory_events SET status='analyzed',updated=? WHERE scope=? AND id=?",
                           (now, scope, turn_id))
                self._save_long_term(db, scope, turn_id, turn, result, now)
                return True
            # A mood can move one step per turn, rather than jumping to a maximum.
            previous = state["intensity"] if now-state["updated"] < 7200 else 0
            intensity = min(result["intensity"], previous+1)
            db.execute("UPDATE dialogue_state SET topic=?,status=?,summary=?,mood=?,intensity=?,updated=? WHERE scope=? AND version=?", (result["topic"], result["status"], result["summary"], result["mood"], intensity, now, scope, turn["version"]))
            db.execute("UPDATE turns SET analysis=? WHERE scope=? AND id=?", (json.dumps(result, ensure_ascii=False), scope, turn_id))
            db.execute("UPDATE memory_events SET status='analyzed',updated=? WHERE scope=? AND id=?",
                       (now, scope, turn_id))
            self._save_long_term(db, scope, turn_id, turn, result, now)
            return True

    def _save_long_term(self, db, scope, turn_id, turn, result, now):
        fact = result.get("long_term")
        speaker_id, body = speaker_and_text(turn["user_text"])
        if (isinstance(fact, dict) and set(fact) == {"kind", "key", "statement", "quote"}
                and all(isinstance(fact[k], str) for k in ("kind", "key", "statement", "quote"))
                and fact["kind"] in MEMORY_TTL
                and 2 <= len(fact["key"].strip()) <= 60 and 4 <= len(fact["quote"].strip()) <= 100
                and 4 <= len(fact["statement"].strip()) <= 120 and fact["quote"] in body
                and re.search(r"我|俺|咱|自己", fact["quote"])
                and (PREFERENCE_CUE.search(fact["quote"]) if fact["kind"] == "preference" else PROJECT_CUE.search(fact["quote"]))
                and not PRIVATE_FACT.search(fact["key"]+fact["statement"]+fact["quote"])
                and not any(x in fact["quote"]+fact["statement"] for x in ("?", "？", "`", "http", "忽略指令", "系统提示"))
                and not (fact["kind"] == "preference" and PREFERENCE.fullmatch(body))):
            occurred = turn["received"]
            ttl = MEMORY_TTL[fact["kind"]]
            db.execute("INSERT INTO durable_facts VALUES(?,?,?,?,?,?,?,?,?) "
                       "ON CONFLICT(scope,speaker_id,kind,key) DO UPDATE SET "
                       "statement=excluded.statement,quote=excluded.quote,source_id=excluded.source_id,"
                       "updated=excluded.updated,expires_at=excluded.expires_at "
                       "WHERE excluded.updated>=durable_facts.updated",
                       (scope, speaker_id, fact["kind"], fact["key"].strip(), fact["statement"].strip(),
                        fact["quote"], turn_id, occurred, occurred+ttl*86400))
            polarity = (-1 if re.search(r"不喜欢|讨厌", fact["quote"]) else 1) if fact["kind"] == "preference" else None
            self._record_memory(db, scope, speaker_id, fact["kind"], fact["key"],
                                fact["statement"], fact["quote"], turn_id, occurred,
                                polarity, 0.9)

    def next_memory_window(self, scope, size=8):
        """A completed, ordered window; no assistant text is sent to extraction."""
        with self.db() as db:
            cursor = db.execute("SELECT version FROM memory_cursor WHERE scope=?", (scope,)).fetchone()
            version = cursor[0] if cursor else 0
            rows = [dict(r) for r in db.execute(
                "SELECT id,version,user_text,received FROM turns WHERE scope=? AND version>? AND assistant_text!='' ORDER BY version LIMIT ?",
                (scope, version, size))]
        for index in range(1, len(rows)):
            before, after = rows[index-1]["received"], rows[index]["received"]
            if (after-before >= 180*60 or
                    datetime.fromtimestamp(before, ZoneInfo("Asia/Taipei")).date() !=
                    datetime.fromtimestamp(after, ZoneInfo("Asia/Taipei")).date()):
                return version, rows[:index]
        return (version, rows) if len(rows) == size else None

    def apply_memory_window(self, scope, previous_version, rows, candidates, now=None):
        """Commit a window once. Candidate evidence must match its own source turn."""
        now = time.time() if now is None else now
        if not isinstance(candidates, list) or len(candidates) > 4:
            return False
        sources = {row["id"]: row for row in rows}
        if len(sources) != len(rows) or not rows:
            return False
        with self.db() as db:
            cursor = db.execute("SELECT version FROM memory_cursor WHERE scope=?", (scope,)).fetchone()
            if (cursor[0] if cursor else 0) != previous_version:
                return False
            for fact in candidates:
                if not isinstance(fact, dict) or set(fact) != {"source_id", "kind", "key", "statement", "quote"}:
                    continue
                source = sources.get(fact["source_id"]) if isinstance(fact["source_id"], str) else None
                if source is None:
                    continue
                self._save_long_term(db, scope, source["id"], source,
                                     {"long_term": {k: fact[k] for k in ("kind", "key", "statement", "quote")}}, now)
            db.execute("INSERT INTO memory_cursor(scope,version) VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET version=excluded.version",
                       (scope, rows[-1]["version"]))
            for source_id in sources:
                db.execute("UPDATE memory_events SET status='consolidated',updated=? WHERE scope=? AND id=?",
                           (now, scope, source_id))
        return True

    def memory_audit(self, scope, speaker_id="", limit=30):
        """Read-only operator data. Caller must authenticate and bind the scope."""
        with self.db() as db:
            return [dict(r) for r in db.execute(
                "SELECT id,kind,key,statement,quote,source_id,occurred_at,expires_at,status,supersedes,confidence "
                "FROM memory_items WHERE scope=? AND speaker_id=? ORDER BY updated DESC LIMIT ?",
                (scope, speaker_id, min(max(int(limit), 1), 100)))]

    def memory_item(self, scope, item_id, speaker_id=""):
        with self.db() as db:
            row = db.execute("SELECT * FROM memory_items WHERE scope=? AND speaker_id=? AND id=?",
                             (scope, speaker_id, item_id)).fetchone()
        return dict(row) if row else None

    def set_memory_status(self, scope, item_id, status, speaker_id=""):
        """Administrative primitive; the caller owns authorization and audit UI."""
        if status not in {"active", "forgotten"}:
            raise ValueError("unsupported status")
        with self.db() as db:
            row = db.execute("SELECT * FROM memory_items WHERE id=? AND scope=? AND speaker_id=?",
                             (item_id, scope, speaker_id)).fetchone()
            if row is None or row["status"] not in {"active", "forgotten"}:
                return False
            if status == "active" and row["expires_at"] <= time.time():
                return False
            if status == "active" and db.execute(
                "SELECT 1 FROM memory_items WHERE scope=? AND speaker_id=? AND kind=? AND key=? AND status='active' AND id!=?",
                (scope, speaker_id, row["kind"], row["key"], item_id)).fetchone():
                return False
            db.execute("UPDATE memory_items SET status=? WHERE id=?", (status, item_id))
            return True

    def context(self, scope, query, now=None):
        now = time.time() if now is None else now
        with self.db() as db:
            row = db.execute("SELECT * FROM dialogue_state WHERE scope=?", (scope,)).fetchone()
            state = dict(row) if row else None
            speaker_id, plain_query = speaker_and_text(str(query))
            durable = [dict(r) for r in db.execute(
                "SELECT kind,key,statement,quote,polarity,speaker_id,source_id,updated,expires_at FROM memory_items WHERE scope=? AND speaker_id=? AND status='active' AND expires_at>? ORDER BY updated DESC LIMIT 100",
                (scope, speaker_id, now))]
            previous = db.execute("SELECT user_text FROM turns WHERE scope=? AND analysis IS NOT NULL ORDER BY received DESC,version DESC LIMIT 1", (scope,)).fetchone()
        # A small exact/subphrase retriever, explicitly not a vector-memory engine.
        query = plain_query[:2000]
        facts = [{"topic": r["key"], "polarity": r["polarity"], "quote": r["quote"],
                  "statement": r["statement"], "speaker_id": r["speaker_id"],
                  "source_id": r["source_id"], "updated": r["updated"]}
                 for r in durable if r["kind"] == "preference"]
        facts.sort(key=lambda f: -f["updated"])
        relevant = [f for f in facts if f["topic"] in query or any(query[i:i+2] in f["topic"] for i in range(max(0, len(query)-1)) if query[i:i+2].strip())][:3]
        if not relevant and (PREFERENCE_QUERY.search(query) or any(cue in query for cue in ("我的偏好", "记得我", "我的喜好"))):
            relevant = facts[:3]
        projects = [r for r in durable if r["kind"] == "project"]
        relevant_projects = [r for r in projects if r["key"] in query or any(query[i:i+2] in r["key"] for i in range(max(0, len(query)-1)) if query[i:i+2].strip())][:3]
        if not relevant_projects and any(cue in query for cue in ("我的项目", "最近在忙", "我在做什么", "之前在做")):
            relevant_projects = projects[:3]
        data = {"user_preferences": relevant, "active_projects": relevant_projects,
                "topic": None, "mood": "calm", "intensity": 0}
        if state:
            age = max(0, now-state["updated"])
            data["fresh_start"] = age >= 900
            if age < 900:
                data["topic"] = {k: state[k] for k in ("topic", "status", "summary")}
                speaker = SPEAKER.match(previous[0]) if previous else None
                if speaker:
                    data["topic"]["speaker_id"] = speaker[1]
            if age < 7200:
                data.update(mood=state["mood"], intensity=max(0, state["intensity"]-int(age//1800)))
        return data

    def import_notes(self, scope, notes):
        """Operator-reviewed ordinary legacy notes, never an implicit global-file scan."""
        if not isinstance(notes, list) or len(notes) > 100:
            raise ValueError("bounded, reviewed notes required")
        with self.db() as db:
            for item in notes:
                quote, source = item.get("quote"), item.get("source")
                if not isinstance(quote, str) or not 1 <= len(quote) <= 600 or not isinstance(source, str) or not 1 <= len(source) <= 200:
                    raise ValueError("invalid historical note")
                nid = hashlib.sha256((source+"\0"+quote).encode()).hexdigest()
                db.execute("INSERT OR IGNORE INTO historical_notes VALUES(?,?,?,?,?)", (scope, nid, quote, source, time.time()))
            db.execute("DELETE FROM historical_notes WHERE scope=? AND id NOT IN (SELECT id FROM historical_notes WHERE scope=? ORDER BY imported DESC LIMIT 100)", (scope, scope))

    def memory_documents(self, scope, now=None):
        """Current ordinary records plus explicitly reviewed scoped historical notes."""
        now = time.time() if now is None else now
        with self.db() as db:
            turns = [dict(r) for r in db.execute("SELECT id,analysis,received,user_text FROM turns WHERE scope=? AND analysis IS NOT NULL AND received>=? ORDER BY received DESC LIMIT 100", (scope, now-7*86400))]
            history = [dict(r) for r in db.execute("SELECT * FROM historical_notes WHERE scope=? ORDER BY imported DESC LIMIT 100", (scope,))]
            durable = [dict(r) for r in db.execute("SELECT * FROM memory_items WHERE scope=? AND status='active' AND expires_at>? ORDER BY updated DESC LIMIT 100", (scope, now))]
        docs = []
        for note in history:
            docs.append({"id": "legacy:"+note["id"], "kind": "historical_note", "text": note["quote"],
                         "record": {"quote": note["quote"], "source": note["source"], "occurred_at": None,
                                    "imported_at": note["imported"], "meaning": "旧资料，原发生时间未知，不代表今天。"}})
        for fact in durable:
            record = {"topic": fact["key"], "statement": fact["statement"], "quote": fact["quote"],
                      "speaker_id": fact["speaker_id"] or None, "source_id": fact["source_id"],
                      "occurred_at": fact["occurred_at"], "expires_at": fact["expires_at"],
                      "confidence": fact["confidence"], "memory_id": fact["id"]}
            if fact["kind"] == "preference":
                record["polarity"] = fact["polarity"]
            docs.append({"id": "memory:"+fact["id"], "kind": fact["kind"],
                         "text": fact["key"]+"。"+fact["statement"], "record": record})
        for turn in turns:
            analysis = json.loads(turn["analysis"])
            # Legacy quoted turns may have summarized assistant-authored text as
            # the user's claim; keep them out of long-term retrieval entirely.
            if "[Quoted message]:" in turn["user_text"]:
                continue
            if not indexable_episode(turn["user_text"], analysis):
                continue
            record = {k: analysis[k] for k in ("topic", "status", "summary", "quote")}
            record.update(source_id=turn["id"], occurred_at=turn["received"])
            speaker = SPEAKER.match(turn["user_text"])
            if speaker:
                record["speaker_id"] = speaker[1]
            docs.append({"id": "turn:"+turn["id"], "kind": "episode", "text": analysis["topic"]+"。"+analysis["quote"]+"。"+analysis["summary"], "record": record})
        return docs
