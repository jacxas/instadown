#!/usr/bin/env python3
"""
Instagram Downloader - CLI para InstaDown

`server.js` invoca este script como proceso hijo. Importante: la salida estándar
solo debe contener UNA línea de JSON, porque el servidor la parsea. Los logs van
a stderr.

Uso:
    python3 instagram_downloader.py <accion> <argumento> --out-dir <dir>

Acciones:
    get_user_info <username>
    download_post <url>
    download_profile_pic <username>
    download_stories <username>
    download_highlights <username>

Salida:
    {"ok": true,  "data": {...}}
    {"ok": false, "error": "..."}   (código de salida 1)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional

logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(levelname)s %(message)s")
logger = logging.getLogger("instadown")

# Instagram solo permite estos caracteres en un nombre de usuario. Validarlo
# también evita path traversal, porque el username se usa en nombres de carpeta.
USERNAME_RE = re.compile(r"^[A-Za-z0-9._]{1,30}$")


class DownloadError(Exception):
    """Error esperado: se devuelve como mensaje al usuario, sin stacktrace."""


def safe_username(value: str) -> str:
    username = (value or "").strip().lstrip("@")
    if not USERNAME_RE.match(username):
        raise DownloadError("Nombre de usuario inválido")
    return username


def safe_dirname(value: str) -> str:
    """Nombre de carpeta seguro para títulos de destacados (texto libre)."""
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", value).strip("._")
    cleaned = cleaned[:60] or "destacado"
    if cleaned in {".", ".."}:
        cleaned = "destacado"
    return cleaned


def get_client():
    """Cliente de instagrapi, autenticado si hay credenciales en el entorno.

    Instagram limita el acceso anónimo, así que en producción conviene definir
    INSTAGRAM_USERNAME / INSTAGRAM_PASSWORD (idealmente una cuenta dedicada).
    """
    from instagrapi import Client

    client = Client()
    client.delay_range = [1, 3]

    username = os.environ.get("INSTAGRAM_USERNAME", "").strip()
    password = os.environ.get("INSTAGRAM_PASSWORD", "").strip()

    if username and password:
        session_file = Path(tempfile.gettempdir()) / (
            "instadown_session_" + hashlib.sha256(username.encode()).hexdigest()[:12] + ".json"
        )
        if session_file.exists():
            try:
                client.load_settings(session_file)
                client.login(username, password)
                logger.info("Sesión reutilizada desde %s", session_file)
                return client
            except Exception as exc:  # sesión caducada o dispositivo no confiable
                logger.warning("No se pudo reutilizar la sesión (%s); se reintenta login completo", exc)

        client.login(username, password)
        try:
            session_file.parent.mkdir(parents=True, exist_ok=True)
            client.dump_settings(session_file)
        except Exception as exc:
            logger.warning("No se pudo guardar la sesión: %s", exc)
        logger.info("Sesión iniciada como %s", username)
    else:
        logger.warning("Sin INSTAGRAM_USERNAME/INSTAGRAM_PASSWORD: se intenta acceso anónimo")

    return client


def media_pk(client, url: str) -> str:
    """Obtiene el pk del media a partir de la URL.

    Se usa la API pública de instagrapi; la versión anterior importaba
    `decode_media_id` de `instagrapi.utils`, que no existe en 2.x.
    """
    if "instagram.com" not in url:
        raise DownloadError("URL inválida: debe ser de instagram.com")
    try:
        return client.media_pk_from_url(url)
    except Exception:
        # Respaldo manual para /p/, /reel/, /tv/
        for marker in ("/p/", "/reel/", "/reels/", "/tv/"):
            if marker in url:
                code = url.split(marker, 1)[1].split("/")[0].split("?")[0]
                if code:
                    try:
                        return client.media_pk_from_code(code)
                    except Exception:
                        break
    raise DownloadError("No se pudo interpretar la URL de la publicación")


def write_bytes(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(payload)


def download_one(client, media, target_dir: Path, name: str) -> Optional[Dict[str, str]]:
    """Descarga una foto o un vídeo y devuelve su descriptor."""
    media_type = getattr(media, "media_type", None)
    pk = getattr(media, "pk", None)
    if media_type == 1:
        path = target_dir / f"{name}.jpg"
        write_bytes(path, client.photo_download(pk))
        return {"file": str(path), "type": "photo"}
    if media_type == 2:
        path = target_dir / f"{name}.mp4"
        write_bytes(path, client.video_download(pk))
        return {"file": str(path), "type": "video"}
    return None


def action_get_user_info(client, username: str, out_dir: Path) -> Dict[str, Any]:
    user = client.user_info_by_username(safe_username(username))
    return {
        "id": str(user.pk),
        "username": user.username,
        "full_name": user.full_name,
        "biography": user.biography,
        "follower_count": user.follower_count,
        "following_count": user.following_count,
        "media_count": user.media_count,
        "profile_pic_url": user.profile_pic_url,
        "is_private": user.is_private,
    }


def action_download_post(client, url: str, out_dir: Path) -> Dict[str, Any]:
    pk = media_pk(client, url)
    media = client.media_info(pk)

    target_dir = out_dir / f"post_{safe_dirname(str(pk))}"
    items: List[Dict[str, str]] = []

    if media.media_type == 8:  # carrusel
        kind = "carousel"
        for index, resource in enumerate(media.resources):
            item = download_one(client, resource, target_dir, f"{index + 1:02d}")
            if item:
                items.append(item)
    else:
        kind = "video" if media.media_type == 2 else "photo"
        item = download_one(client, media, target_dir, "01")
        if item:
            items.append(item)

    if not items:
        raise DownloadError("La publicación no tiene contenido descargable")

    return {
        "type": kind,
        "items": items,
        "caption": media.caption_text or "",
        "likes": media.like_count or 0,
        "comments": media.comment_count or 0,
    }


def action_download_profile_pic(client, username: str, out_dir: Path) -> Dict[str, Any]:
    username = safe_username(username)
    user = client.user_info_by_username(username)
    if not user.profile_pic_url:
        raise DownloadError("El usuario no tiene foto de perfil pública")

    target_dir = out_dir / f"profile_{username}"
    path = target_dir / "avatar.jpg"
    write_bytes(path, client.photo_download_by_url(str(user.profile_pic_url), "avatar"))

    return {
        "username": user.username,
        "full_name": user.full_name,
        "items": [{"file": str(path), "type": "photo"}],
    }


def action_download_stories(client, username: str, out_dir: Path) -> Dict[str, Any]:
    username = safe_username(username)
    user = client.user_info_by_username(username)
    stories = client.user_stories(user.pk)

    target_dir = out_dir / f"stories_{username}"
    items: List[Dict[str, str]] = []
    for index, story in enumerate(stories, start=1):
        item = download_one(client, story, target_dir, f"{index:02d}")
        if item:
            items.append(item)

    if not items:
        raise DownloadError("El usuario no tiene historias activas")

    return {"username": user.username, "items": items}


def action_download_highlights(client, username: str, out_dir: Path) -> Dict[str, Any]:
    username = safe_username(username)
    user = client.user_info_by_username(username)
    highlights = client.user_highlights(user.pk)

    root = out_dir / f"highlights_{username}"
    items: List[Dict[str, str]] = []
    for highlight in highlights:
        folder = root / safe_dirname(highlight.title or str(highlight.pk))
        for index, media in enumerate(highlight.items, start=1):
            item = download_one(client, media, folder, f"{index:02d}")
            if item:
                item["highlight"] = highlight.title or ""
                items.append(item)

    if not items:
        raise DownloadError("El usuario no tiene destacados")

    return {"username": user.username, "items": items}


ACTIONS = {
    "get_user_info": (action_get_user_info, "username"),
    "download_post": (action_download_post, "url"),
    "download_profile_pic": (action_download_profile_pic, "username"),
    "download_stories": (action_download_stories, "username"),
    "download_highlights": (action_download_highlights, "username"),
}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="InstaDown downloader")
    parser.add_argument("action", choices=sorted(ACTIONS))
    parser.add_argument("argument", help="username o URL según la acción")
    parser.add_argument(
        "--out-dir",
        default=os.environ.get("DOWNLOADS_DIR", tempfile.mkdtemp(prefix="instadown_")),
        help="Directorio donde se guardan las descargas",
    )
    return parser


def emit(payload: Dict[str, Any], exit_code: int = 0) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    raise SystemExit(exit_code)


def main(argv: Optional[List[str]] = None) -> None:
    args = build_parser().parse_args(argv)
    handler, _ = ACTIONS[args.action]
    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    try:
        client = get_client()
        data = handler(client, args.argument, out_dir)
        emit({"ok": True, "data": data})
    except DownloadError as exc:
        logger.error("%s", exc)
        emit({"ok": False, "error": str(exc)}, 1)
    except ImportError as exc:
        logger.error("Dependencia faltante: %s", exc)
        emit(
            {"ok": False, "error": "El servidor no tiene instalado instagrapi (ejecutá: pip install -r requirements.txt)"},
            1,
        )
    except Exception as exc:  # red, bloqueo de Instagram, login requerido...
        logger.error("Fallo inesperado: %s", exc)
        # No se filtra el detalle interno al cliente: puede contener credenciales
        # o rutas del servidor.
        emit({"ok": False, "error": "No se pudo completar la operación con Instagram"}, 1)


if __name__ == "__main__":
    main()
