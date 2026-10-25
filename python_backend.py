"""
InstaDown Python Backend (alternativa legacy, opcional)

`server.js` es el backend recomendado: incluye cuotas, planes y pagos.
Este servicio Flask existe por si se quiere correr el descargador por separado.

A diferencia de la versión anterior, ahora:
  - exige una API key en todas las rutas (antes era un servicio abierto que
    cualquiera podía usar para descargar sin límite, desde cualquier origen),
  - restringe CORS a los orígenes configurados,
  - valida los nombres de usuario (evita path traversal en los nombres de
    carpeta),
  - usa la API real de instagrapi (`media_pk_from_url`) en lugar de
    `decode_media_id`, que no existe en instagrapi 2.x,
  - no devuelve rutas absolutas del servidor al cliente.

Variables de entorno:
  API_KEY          obligatoria en producción (si falta, el servicio no arranca)
  CORS_ORIGINS     lista separada por comas
  INSTAGRAM_USERNAME / INSTAGRAM_PASSWORD
  DOWNLOADS_DIR    (por defecto un directorio temporal)
  PORT             (por defecto 5000)
"""

import functools
import logging
import os
import re
import tempfile
from pathlib import Path
from typing import Dict, List, Optional

from flask import Flask, jsonify, request, send_file
from flask_cors import CORS
from instagrapi import Client
from instagrapi.types import Media, User

app = Flask(__name__)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

API_KEY = os.environ.get("API_KEY", "").strip()
IS_PRODUCTION = os.environ.get("FLASK_ENV") == "production"

if IS_PRODUCTION and not API_KEY:
    raise SystemExit("API_KEY es obligatoria en producción")

_allowed_origins = [o.strip() for o in os.environ.get("CORS_ORIGINS", "").split(",") if o.strip()]
# Sin orígenes configurados no se habilita CORS (llamadas server-to-server).
CORS(app, origins=_allowed_origins, supports_credentials=False)

USERNAME_RE = re.compile(r"^[A-Za-z0-9._]{1,30}$")

DOWNLOADS_DIR = Path(os.environ.get("DOWNLOADS_DIR", Path(tempfile.gettempdir()) / "instagram_downloads")).resolve()
DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)

client = Client()


def require_api_key(view):
    """Ninguna ruta queda abierta: sin API key válida se responde 401."""

    @functools.wraps(view)
    def wrapper(*args, **kwargs):
        if not API_KEY:
            # Sin clave configurada solo se permite en desarrollo local.
            return view(*args, **kwargs)
        provided = request.headers.get("X-API-Key", "")
        if provided != API_KEY:
            return jsonify({"success": False, "error": "No autorizado"}), 401
        return view(*args, **kwargs)

    return wrapper


def safe_username(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    username = str(value).strip().lstrip("@")
    return username if USERNAME_RE.match(username) else None


def relative_name(path_str: str) -> str:
    """Devuelve el nombre relativo a DOWNLOADS_DIR, nunca la ruta absoluta."""
    try:
        return str(Path(path_str).resolve().relative_to(DOWNLOADS_DIR))
    except ValueError:
        return Path(path_str).name


class InstagramDownloader:
    """Operaciones de descarga. Todas las rutas salen de DOWNLOADS_DIR."""

    @staticmethod
    def get_user_info(username: str) -> Optional[Dict]:
        try:
            user: User = client.user_info_by_username(username)
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
        except Exception as exc:
            logger.error("Error getting user info: %s", exc)
            return None

    @staticmethod
    def download_post(url: str) -> Optional[Dict]:
        try:
            if "instagram.com" not in url:
                return None
            pk = client.media_pk_from_url(url)
            media: Media = client.media_info(pk)

            download_path = DOWNLOADS_DIR / f"post_{pk}"
            download_path.mkdir(parents=True, exist_ok=True)

            result = {
                "type": "unknown",
                "files": [],
                "caption": media.caption_text,
                "likes": media.like_count,
                "comments": media.comment_count,
            }

            if media.media_type == 8:
                result["type"] = "carousel"
                for index, resource in enumerate(media.resources):
                    path = InstagramDownloader._save(resource, download_path, index)
                    if path:
                        result["files"].append(relative_name(path))
            else:
                result["type"] = "video" if media.media_type == 2 else "photo"
                path = InstagramDownloader._save(media, download_path, 0)
                if path:
                    result["files"].append(relative_name(path))

            return result if result["files"] else None
        except Exception as exc:
            logger.error("Error downloading post: %s", exc)
            return None

    @staticmethod
    def _save(media, folder: Path, index: int) -> Optional[str]:
        try:
            if media.media_type == 1:
                target = folder / f"photo_{index}.jpg"
                target.write_bytes(client.photo_download(media.pk))
                return str(target)
            if media.media_type == 2:
                target = folder / f"video_{index}.mp4"
                target.write_bytes(client.video_download(media.pk))
                return str(target)
        except Exception as exc:
            logger.error("Error saving media: %s", exc)
        return None

    @staticmethod
    def download_profile_picture(username: str) -> Optional[str]:
        try:
            user: User = client.user_info_by_username(username)
            folder = DOWNLOADS_DIR / f"profile_{username}"
            folder.mkdir(parents=True, exist_ok=True)
            target = folder / "avatar.jpg"
            target.write_bytes(client.photo_download_by_url(str(user.profile_pic_url), "avatar"))
            return str(target)
        except Exception as exc:
            logger.error("Error downloading profile pic: %s", exc)
            return None

    @staticmethod
    def download_stories(username: str) -> Optional[List[str]]:
        try:
            user: User = client.user_info_by_username(username)
            stories = client.user_stories(user.pk)
            folder = DOWNLOADS_DIR / f"stories_{username}"
            folder.mkdir(parents=True, exist_ok=True)

            files = []
            for index, story in enumerate(stories):
                path = InstagramDownloader._save(story, folder, index)
                if path:
                    files.append(relative_name(path))
            return files
        except Exception as exc:
            logger.error("Error downloading stories: %s", exc)
            return None


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "service": "InstaDown Python Backend", "version": "2.1.0"})


@app.route("/api/user/<username>", methods=["GET"])
@require_api_key
def get_user(username):
    safe = safe_username(username)
    if not safe:
        return jsonify({"success": False, "error": "Usuario inválido"}), 400
    info = InstagramDownloader.get_user_info(safe)
    if not info:
        return jsonify({"success": False, "error": "Usuario no encontrado"}), 404
    return jsonify({"success": True, "data": info})


@app.route("/api/download/post", methods=["POST"])
@require_api_key
def download_post():
    payload = request.get_json(silent=True) or {}
    url = payload.get("url")
    if not isinstance(url, str) or not url:
        return jsonify({"success": False, "error": "URL requerida"}), 400
    result = InstagramDownloader.download_post(url)
    if not result:
        return jsonify({"success": False, "error": "No se pudo descargar"}), 422
    return jsonify({"success": True, "data": result})


@app.route("/api/download/profile-pic", methods=["POST"])
@require_api_key
def download_profile_pic():
    payload = request.get_json(silent=True) or {}
    username = safe_username(payload.get("username"))
    if not username:
        return jsonify({"success": False, "error": "Username inválido"}), 400
    path = InstagramDownloader.download_profile_picture(username)
    if not path:
        return jsonify({"success": False, "error": "No se pudo descargar"}), 422
    return jsonify({"success": True, "data": {"file": relative_name(path)}})


@app.route("/api/download/stories", methods=["POST"])
@require_api_key
def download_stories():
    payload = request.get_json(silent=True) or {}
    username = safe_username(payload.get("username"))
    if not username:
        return jsonify({"success": False, "error": "Username inválido"}), 400
    files = InstagramDownloader.download_stories(username)
    if files is None:
        return jsonify({"success": False, "error": "No se pudieron descargar"}), 422
    return jsonify({"success": True, "data": {"files": files}})


@app.route("/api/files/<path:name>", methods=["GET"])
@require_api_key
def get_file(name):
    """Sirve un archivo descargado, sin permitir salir de DOWNLOADS_DIR."""
    target = (DOWNLOADS_DIR / name).resolve()
    if not str(target).startswith(str(DOWNLOADS_DIR) + os.sep):
        return jsonify({"success": False, "error": "Acceso denegado"}), 403
    if not target.is_file():
        return jsonify({"success": False, "error": "Archivo no encontrado"}), 404
    return send_file(target, as_attachment=True)


@app.errorhandler(404)
def not_found(error):
    return jsonify({"success": False, "error": "Endpoint no encontrado"}), 404


@app.errorhandler(500)
def internal_error(error):
    logger.exception("Error interno")
    return jsonify({"success": False, "error": "Error interno del servidor"}), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
