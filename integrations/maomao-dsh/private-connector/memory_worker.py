"""One ordinary-memory operation for an already authorized private owner."""
import json
import os
import re
import sqlite3
import sys
import time
from pathlib import Path

configured = os.environ.get("MAOMAO_COMPANION_PATH")
sys.path.insert(0, str(Path(configured).resolve() if configured else
                       Path(__file__).resolve().parents[2] / "maomao-companion"))
from maomao_companion.budget import BudgetedEmbeddings, OutboundBudget
from maomao_companion.dialogue import DialogueStore, PREFERENCE, PRIVATE_FACT
from maomao_companion.embeddings import SemanticMemory, embedding_client
from maomao_companion.contact import ContactLedger, Policy
from maomao_companion.life import public_url
from maomao_companion.library import MemeStore
from maomao_companion.sticker_tools import sticker_tool
from feed_activity import candidate, mark_shared


def contact(payload, root, scope):
    ledger = ContactLedger(root / "contacts.sqlite3", Policy(daily_limit=1,
                           dnd_start=int(os.environ.get("MAOMAO_PRIVATE_DND_START", "23")),
                           dnd_end=int(os.environ.get("MAOMAO_PRIVATE_DND_END", "8"))))
    op = payload["op"]
    if op == "contact_check":
        status = ledger.check(scope)
        with ledger.transaction() as db:
            last = db.execute("SELECT source FROM contacts WHERE scope=? AND status='sent' ORDER BY dispatched DESC LIMIT 1", (scope,)).fetchone()
        return {**status, "last_source": last[0] if last else None}
    if op == "contact_incoming":
        ledger.incoming(scope, payload["turnId"])
        if re.fullmatch(r"(?:晚安|我要睡了|我去睡了)[喵～~！!。\s]*", payload["text"]):
            ledger.goodnight(scope)
        return {}
    if op == "contact_reserve":
        args = payload["details"]
        source = args["source"]
        if source not in {"activity", "lonely"} or (source == "activity" and
                (not args["url"].startswith("https://") or not public_url(args["url"]))):
            raise ValueError("invalid_public_contact_source")
        if PRIVATE_FACT.search(payload["text"]):
            raise ValueError("private_contact_content")
        state = ledger.check(scope)
        if not state["last_incoming"] or len(payload["text"]) > state["max_chars"]:
            return {}
        try:
            ticket = ledger.reserve(scope, source, payload["turnId"], args["fingerprint"])
            return {"ticket": ticket}
        except PermissionError:
            return {}
    if op == "contact_dispatch":
        try:
            ledger.dispatch(payload["turnId"])
            return {"allowed": True}
        except PermissionError:
            return {}
    if op == "contact_finish":
        ledger.finish(payload["turnId"], payload["details"]["outcome"])
        return {}
    raise ValueError("invalid_contact_operation")


def recall_history(path, scope, body, *, desktop=False):
    if not path.is_file():
        return []
    with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True) as db:
        notes = [quote for (quote,) in db.execute(
            "SELECT quote FROM historical_notes WHERE scope=? ORDER BY imported DESC,id LIMIT 100", (scope,))
            if not PRIVATE_FACT.search(quote)]
    tokens = set(re.findall(r"[a-z0-9]{3,}|[\u4e00-\u9fff]{2,}", body.lower()))
    chunks = {tok[i:i + 2] for tok in tokens for i in range(len(tok) - 1)
              if re.fullmatch(r"[\u4e00-\u9fff]+", tok)} | {tok for tok in tokens if tok.isascii()}
    chunks.difference_update({"猫猫", "记得", "知道", "什么", "之前", "以前", "喜欢", "最喜", "我的", "帮我", "怎么"})
    exact = {token for token in tokens if desktop and token.isascii() and len(token) >= 4}

    def relevance(note):
        lower = note.lower()
        return sum(chunk in lower for chunk in chunks) + len(exact.intersection(re.findall(r"[a-z0-9]+", lower)))

    selected = [quote for quote in sorted(notes, key=relevance, reverse=True) if relevance(quote) >= 2][:3]
    overview = r"(?:以前|之前|过去).{0,5}聊过(?:什么|哪些)|有哪些旧记忆|聊过些什么"
    if not selected and re.search(overview if desktop else r"以前|之前|记得|旧记忆|旧资料", body):
        selected = notes[:3]
    return selected


def run(payload):
    scope = payload["owner"]
    turn_id = payload["turnId"]
    if not all(isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value)
               for value in (scope, turn_id)):
        raise ValueError("invalid_ordinary_scope")
    root = Path(os.environ["MAOMAO_PRIVATE_ORDINARY"]).resolve()
    if payload["op"].startswith("contact_"):
        return contact(payload, root, scope)
    if payload["op"].startswith("activity_"):
        path = root / scope / "background.sqlite3"
        if payload["op"] == "activity_candidate":
            return candidate(path)
        if payload["op"] == "activity_shared":
            mark_shared(path, turn_id)
            return {}
        raise ValueError("invalid_activity_operation")
    key = os.environ.get("MAOMAO_PRIVATE_EMBEDDING_KEY")
    model = os.environ.get("MAOMAO_PRIVATE_EMBEDDING_MODEL", "qwen/qwen3-embedding-8b")
    if payload['op'] == 'sticker_tool':
        client = embedding_client(model, key_provider=lambda _: key) if key else None
        embedder = BudgetedEmbeddings(client, OutboundBudget(root / scope / 'embedding-budget.sqlite3', limit=200), scope) if client else None
        gallery = MemeStore(root / scope / 'gallery', scope)
        return sticker_tool(gallery, payload['details']['action'], payload['details'], embedder)
    if payload["op"] in ("index_status", "index_rebuild"):
        path = root / scope / "dialogue.sqlite3"
        if not path.is_file():
            return {"total": 0, "indexed": 0, "model": model}
        store = DialogueStore(path)
        client = embedding_client(model, key_provider=lambda _: key)
        if key:
            client = BudgetedEmbeddings(client, OutboundBudget(root / scope / "embedding-budget.sqlite3", limit=200), scope)
        semantic = SemanticMemory(store, client, lambda job: job["scope"] == scope)
        try:
            if payload["op"] == "index_rebuild":
                if not key:
                    raise ValueError("private_embedding_key_missing")
                semantic.index({"scope": scope})
            return {"model": model, **semantic.progress(scope)}
        finally:
            semantic.close()
    body = payload["text"]
    if not isinstance(body, str) or not body.strip() or body.strip().startswith("/") or PRIVATE_FACT.search(body):
        return {}
    owner = root / scope
    op = payload["op"]
    if op == "lark_history":
        notes = recall_history(owner / "dialogue.sqlite3", scope, body)
        return {"lark_reviewed_history": notes} if notes else {}
    if op == "desktop" and not PREFERENCE.fullmatch(body) and not (owner / "dialogue.sqlite3").is_file():
        return {}
    owner.mkdir(mode=0o700, parents=True, exist_ok=True)
    owner.chmod(0o700)
    store = DialogueStore(owner / "dialogue.sqlite3")
    if op == "desktop":
        # Do not add other desktop messages or assistant responses to durable chat memory.
        if PREFERENCE.fullmatch(body) and not (payload.get("details") or {}).get("learningManaged"):
            store.begin(scope, turn_id, body, time.time())
        context = store.context(scope, body)
        result = {key: context[key] for key in ("user_preferences", "active_projects")}
        notes = recall_history(store.path, scope, body, desktop=True)
        if notes:
            result["hermes_history"] = [{"statement": note} for note in notes]
        return result
    if op == "begin":
        turn = store.begin(scope, turn_id, body, time.time(), extract=not (payload.get("details") or {}).get("learningManaged"))
        context = store.context(scope, body)
        # Cross-channel context contains durable ordinary facts, not recent turns or mood.
        result = {key: context[key] for key in ("user_preferences", "active_projects")}
    elif op == "finish":
        turn = store.turn(scope, turn_id)
        if not turn:
            return {}
        if not PRIVATE_FACT.search(payload["answer"]):
            store.finish(scope, turn_id, payload["answer"])
        result = {}
    else:
        raise ValueError("invalid_ordinary_operation")
    if not turn or not key:
        return result
    client = BudgetedEmbeddings(embedding_client(model, key_provider=lambda _: key),
                                OutboundBudget(owner / "embedding-budget.sqlite3", limit=200), scope)
    semantic = SemanticMemory(store, client, lambda job: job["scope"] == scope)
    job = {"scope": scope, "version": turn["version"]}
    try:
        if op == "begin":
            recalled = semantic.recall(job, body)
            if recalled:
                result["semantic"] = recalled
        else:
            semantic.index(job)
    except Exception:
        pass  # A remote or vector failure leaves local memory available.
    finally:
        semantic.close()
    return result


if __name__ == "__main__":
    try:
        line = sys.stdin.readline(6_750_001)
        if len(line) > 6_750_000:
            raise ValueError("ordinary_request_too_large")
        payload = json.loads(line)
        if payload.get('op') != 'sticker_tool' and len(line) > 24_000:
            raise ValueError('ordinary_request_too_large')
        print(json.dumps(run(payload), ensure_ascii=False))
    except Exception:
        sys.exit(1)
