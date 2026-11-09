"""QQ-only ordinary memory bridge. JSON lines on stdin/stdout; no Hermes runtime."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import sys
import time
from tempfile import TemporaryDirectory
from pathlib import Path


def _companion_path() -> Path:
    configured = os.environ.get("MAOMAO_COMPANION_PATH", "")
    if configured:
        return Path(configured).resolve()
    return Path(__file__).resolve().parents[2] / "maomao-companion"


sys.path.insert(0, str(_companion_path()))
from maomao_companion.dialogue import DialogueStore  # noqa: E402
from maomao_companion.library import MemeStore, collection_reply, image_input  # noqa: E402
from maomao_companion.embeddings import OpenRouterEmbeddings, embedding_client  # noqa: E402
from maomao_companion.budget import BudgetedEmbeddings, OutboundBudget  # noqa: E402
from maomao_companion.delivery import requested_language, voice_denied, voice_followup, voice_requested  # noqa: E402

PACK = {
    "A2": ("赞同", "中，可以，猫猫比 OK"),
    "A3": ("晚安", "晚安，被窝里的困猫"),
    "B1": ("害羞", "才不是，猫猫嘴硬"),
    "B2": ("惊讶", "被抓包，僵住心虚"),
    "B3": ("生气", "俺生气了，猫猫炸毛"),
    "D1": ("其他", "忍住了，克制去抓小鸟"),
    "D2": ("无语", "今天空军，拍鸟落空"),
    "E1": ("开心", "表情包本猫，猫猫得意自拍"),
}


def _digest(*parts: str) -> str:
    return hashlib.sha256("\0".join(parts).encode()).hexdigest()


def _field(envelope: dict, key: str, maximum: int = 256) -> str:
    value = envelope.get(key)
    if not isinstance(value, str) or not 1 <= len(value) <= maximum:
        raise ValueError("invalid_envelope")
    return value


class OrdinaryService:
    def __init__(self, root: Path):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.root.chmod(0o700)
        self.stores = {}
        pack = os.environ.get("MAOMAO_STICKER_PACK")
        self.pack = Path(pack).resolve() / "512" if pack else None
        key = os.environ.get("MAOMAO_STICKER_EMBEDDING_KEY")
        self.embedding = OpenRouterEmbeddings(key_provider=lambda _: key) if key else None
        self.embedding_budget = OutboundBudget(self.root / "embedding-budget.sqlite3")

    def _scope(self, envelope: dict):
        if not isinstance(envelope, dict) or envelope.get("channel") != "qq":
            raise ValueError("qq_only")
        kind = envelope.get("scope")
        if kind not in ("group", "c2c"):
            raise ValueError("invalid_scope")
        bot_id = _field(envelope, "botId")
        chat_id = _field(envelope, "chatId")
        sender_id = _field(envelope, "senderId")
        message_id = _field(envelope, "messageId")
        if kind == "c2c" and chat_id != sender_id:
            raise ValueError("invalid_c2c_actor")
        scope = _digest("qq", bot_id, kind, chat_id)
        path = self.root
        for component in ("qq", _digest(bot_id), kind, _digest(chat_id)):
            path = path / component
            path.mkdir(exist_ok=True, mode=0o700)
            path.chmod(0o700)
        return kind, scope, sender_id, message_id, path

    def _stores(self, path, scope):
        if path not in self.stores:
            self.stores[path] = (DialogueStore(path / "dialogue.sqlite3"), MemeStore(path / "gallery", scope))
        return self.stores[path]

    def observe(self, envelope: dict) -> dict:
        kind, scope, sender, message_id, path = self._scope(envelope)
        text = envelope.get("text", "")
        if not isinstance(text, str):
            raise ValueError("invalid_text")
        attachments = envelope.get("attachments", [])
        if not isinstance(attachments, list):
            raise ValueError("invalid_attachments")
        has_image = any(isinstance(item, dict) and item.get("kind") == "image"
                        for item in attachments[:20])
        body = text.strip()[:2000]
        speaker = _digest(sender)[:12]
        store, gallery = self._stores(path, scope)
        query = (f"[群成员 {speaker}] " if kind == "group" else "") + body
        turn_id = _digest(scope, message_id)
        received = envelope.get("receivedAt")
        received = received / 1000 if isinstance(received, (int, float)) and 0 < received <= time.time() * 1000 + 300_000 else time.time()
        if body:
            store.begin(scope, turn_id, query, received)
        if body or has_image:
            gallery.observe_message(turn_id, sender, body or "[图片]")
        context = store.context(scope, query) if body else {}
        topic = context.get("topic")
        if isinstance(topic, dict) and topic.get("speaker_id") not in (None, "", speaker):
            context["topic"] = None
        return {"context": context, "speaker": speaker, "imageObserved": has_image}

    def _pack_file(self, code):
        if not self.pack or code not in PACK:
            return None
        for candidate in (self.pack / "gif" / (code + ".gif"), self.pack / (code + ".png")):
            if candidate.is_file() and candidate.resolve().is_relative_to(self.pack):
                return candidate.resolve()
        return None

    def media(self, op, envelope, args):
        _, scope, sender, message_id, path = self._scope(envelope)
        if op == "voice_intent":
            text = envelope["text"]
            requested = voice_requested(text)
            return {"requested": requested, "followup": not requested and not voice_denied(text) and voice_followup(text),
                    "language": requested_language(text)}
        _, gallery = self._stores(path, scope)
        if op == "vision_claim":
            return {"allowed": any(item.get("kind") == "image" for item in envelope["attachments"]) and gallery.reserve("vision", 80)}
        model = self.embedding
        if "embeddingOverride" in args:
            config = args["embeddingOverride"]
            model = embedding_client(config["model"], key_provider=lambda _: config["key"]) if config else None
        embedder = BudgetedEmbeddings(model, self.embedding_budget, scope) if model else None
        if op in ("image_preview", "prepare_image", "remember_image"):
            if not any(item.get("kind") == "image" for item in envelope["attachments"]):
                raise ValueError("image_receipt_required")
            raw = base64.b64decode(args["data"], validate=True)
            if not 0 < len(raw) <= 5_000_000:
                raise ValueError("invalid_image_size")
            with TemporaryDirectory() as tmp:
                source = Path(tmp) / "input"
                source.write_bytes(raw)
                if op == "image_preview":
                    thumbnail, _, _ = image_input(source)
                    return {"jpeg": base64.b64encode(thumbnail).decode()}
                if op == "prepare_image":
                    old = gallery.known(hashlib.sha256(raw).hexdigest())
                    if old and old["eligible"]:
                        return {"known": {"description": old["description"], "text": old["ocr"],
                            "category": old["category"], "is_meme": True, "confidence": .9,
                            "personal_or_sensitive": False, "steal_reason": old["steal_reason"]}}
                    thumbnail, _, _ = image_input(source)
                    if gallery.reserve("vision", 80):
                        return {"jpeg": base64.b64encode(thumbnail).decode()}
                    return {}
                result = args["result"]
                turn_id = _digest(scope, message_id)
                gallery.observe_message(turn_id, sender, envelope["text"] or "[图片]")
                if result["personal_or_sensitive"] is True:
                    return {}
                gallery.annotate_image(turn_id, envelope["text"], result["description"])
                if not result["is_meme"] or not args.get("collect"):
                    return {}
                remembered = gallery.remember(source, result, embedder=embedder)
                if remembered and remembered["newly_collected"] and gallery.claim_collection_notice(remembered["id"]):
                    return {"notice": collection_reply(remembered["steal_reason"]), "id": remembered["id"]}
                return {}
        if op == "finish_notice":
            gallery.finish_collection_notice(args["id"], args["success"] is True)
            return {}
        if op == "sticker_candidates":
            query = args["query"][:200].strip()
            if not query or not gallery.reserve("sticker_decision", 200):
                return []
            matches = [{key: item[key] for key in ("id", "description", "category")}
                       for item in gallery.search(query, embedder)]
            if not matches:
                with gallery.db() as db:
                    rows = db.execute("""SELECT id,description,category FROM images WHERE eligible=1
                        AND path IS NOT NULL ORDER BY last_seen DESC LIMIT 6""")
                    matches = [dict(row) for row in rows]
            return matches + [{"id": "pack:" + code, "category": category, "description": text}
                              for code, (category, text) in PACK.items() if self._pack_file(code)]
        if op == "claim_sticker":
            choice = args["id"]
            if choice.startswith("pack:"):
                candidate = self._pack_file(choice.removeprefix("pack:"))
            else:
                row = gallery.known(choice)
                candidate = Path(row["path"]).resolve() if row and row["eligible"] and row["path"] else None
                if not candidate or not candidate.is_relative_to(gallery.root.resolve()):
                    return None
            if not candidate or not candidate.is_file() or candidate.stat().st_size > 2_000_000:
                return None
            with gallery.db() as db:
                db.execute("CREATE TABLE IF NOT EXISTS sticker_delivery (id TEXT PRIMARY KEY, sent REAL NOT NULL)")
                db.execute("BEGIN IMMEDIATE")
                now = time.time()
                db.execute("DELETE FROM sticker_delivery WHERE sent<?", (now - 6 * 3600,))
                if db.execute("SELECT 1 FROM sticker_delivery WHERE id=? OR sent>?", (choice, now - 45)).fetchone():
                    return None
                db.execute("INSERT INTO sticker_delivery VALUES(?,?)", (choice, now))
            return str(candidate)
        raise ValueError("unsupported_operation")


def main() -> None:
    root = os.environ.get("MAOMAO_ORDINARY_ROOT")
    if not root or not Path(root).is_absolute():
        raise SystemExit("MAOMAO_ORDINARY_ROOT must be an absolute path")
    service = OrdinaryService(Path(root))
    for line in sys.stdin:
        request = None
        try:
            if len(line) > 6_750_000:
                raise ValueError("request_too_large")
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("invalid_request")
            request_id = request.get("id")
            if not isinstance(request_id, str) or len(request_id) > 80:
                raise ValueError("invalid_request")
            op = request.get("op")
            envelope = request.get("envelope")
            result = service.observe(envelope) if op == "observe" else service.media(op, envelope, request.get("args", {}))
            response = {"id": request_id, "ok": True, "result": result}
        except Exception as error:
            response = {"id": request.get("id") if isinstance(request, dict) else None,
                        "ok": False, "error": str(error) if isinstance(error, ValueError) else "storage_error"}
        sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
