"""Conversation-scoped media operations for model-controlled sticker tools."""
import base64
import hashlib
from pathlib import Path
from tempfile import TemporaryDirectory

from .library import image_input


def sticker_tool(gallery, action, args, embedder=None, packs=None):
    packs = packs or {}
    if action in ('inspect', 'collect'):
        raw = base64.b64decode(args['data'], validate=True)
        if not 0 < len(raw) <= 5_000_000:
            raise ValueError('invalid_image_size')
        with TemporaryDirectory() as tmp:
            source = Path(tmp) / 'image'
            source.write_bytes(raw)
            jpeg, _, _ = image_input(source)
            if action == 'inspect':
                if not gallery.reserve('vision', 80):
                    return {'status': 'limit'}
                return {'status': 'ok', 'jpeg': base64.b64encode(jpeg).decode()}
            row = gallery.remember(source, args['description'], explicit=True, embedder=embedder)
            if not row or not row.get('path') or not row['eligible']:
                return {'status': 'not_collected'}
            return {'status': 'saved', 'id': row['id'], 'new': row['newly_collected'],
                    'description': row['description'], 'reason': row.get('steal_reason', '')}
    if action == 'search':
        query = args.get('query', '')[:200]
        matches = gallery.search(query, embedder) if query else []
        with gallery.db() as db:
            rows = db.execute('SELECT id,description,category,ocr FROM images WHERE eligible=1 AND path IS NOT NULL ORDER BY last_seen DESC LIMIT 24').fetchall()
        values = {r['id']: {k: r[k] for k in ('id', 'description', 'category')} for r in matches}
        for r in rows:
            values.setdefault(r['id'], {k: r[k] for k in ('id', 'description', 'category', 'ocr')})
        for code, item in packs.items():
            if Path(item['path']).is_file():
                values['pack:' + code] = {'id': 'pack:' + code, 'description': item['description'], 'category': item['category']}
        return {'status': 'ok', 'items': list(values.values())[:32]}
    if action == 'resolve':
        choice = args['id']
        if choice.startswith('pack:'):
            item = packs.get(choice[5:])
            candidate = Path(item['path']).resolve() if item else None
        else:
            row = gallery.known(choice)
            candidate = Path(row['path']).resolve() if row and row['eligible'] and row['path'] else None
            if candidate and not candidate.is_relative_to(gallery.root.resolve()):
                return {'status': 'missing'}
        if not candidate or not candidate.is_file() or candidate.stat().st_size > 2_000_000:
            return {'status': 'missing'}
        if candidate.suffix.lower() != '.gif':
            from PIL import Image, ImageOps
            image_input(candidate)
            normalized = gallery.root / (hashlib.sha256(candidate.read_bytes()).hexdigest() + '-512.png')
            with Image.open(candidate) as im:
                ImageOps.contain(im.convert('RGBA'), (512, 512)).save(normalized, format='PNG')
            normalized.chmod(0o600)
            candidate = normalized
        # Delivery transport owns receipt idempotence; model decides relevance and repetition.
        return {'status': 'ok', 'path': str(candidate)}
    raise ValueError('invalid_sticker_action')
