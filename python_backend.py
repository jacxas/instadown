"""
InstaDown Python Backend
Servidor Flask para procesar descargas de Instagram
Diseñado para ejecutarse en Railway, Render o Heroku
"""

from flask import Flask, request, jsonify, send_file
from flask_cors import CORS
import os
import json
import logging
from pathlib import Path
from typing import Optional, Dict
import tempfile
import shutil
from instagrapi import Client
from instagrapi.types import Media, User

# Configuración
app = Flask(__name__)
CORS(app)
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Directorio de descargas
DOWNLOADS_DIR = Path(tempfile.gettempdir()) / "instagram_downloads"
DOWNLOADS_DIR.mkdir(exist_ok=True)

# Cliente de Instagram
client = Client()

class InstagramDownloader:
    """Clase para manejar descargas de Instagram"""
    
    @staticmethod
    def get_user_info(username: str) -> Optional[Dict]:
        """Obtiene información del usuario"""
        try:
            user: User = client.user_info_by_username(username)
            return {
                "id": user.pk,
                "username": user.username,
                "full_name": user.full_name,
                "biography": user.biography,
                "follower_count": user.follower_count,
                "following_count": user.following_count,
                "media_count": user.media_count,
                "profile_pic_url": user.profile_pic_url,
                "is_private": user.is_private,
            }
        except Exception as e:
            logger.error(f"Error getting user info: {e}")
            return None
    
    @staticmethod
    def download_post(url: str) -> Optional[Dict]:
        """Descarga un post de Instagram"""
        try:
            # Extraer media_id
            media_id = InstagramDownloader._extract_media_id(url)
            if not media_id:
                return None
            
            # Obtener información del media
            media: Media = client.media_info(media_id)
            
            # Crear directorio para descarga
            download_path = DOWNLOADS_DIR / f"post_{media_id}"
            download_path.mkdir(exist_ok=True)
            
            result = {
                "type": "unknown",
                "files": [],
                "caption": media.caption_text,
                "likes": media.like_count,
                "comments": media.comment_count,
            }
            
            # Descargar según tipo
            if media.media_type == 1:  # Foto
                result["type"] = "photo"
                img_path = download_path / "photo.jpg"
                with open(img_path, "wb") as f:
                    f.write(client.photo_download_by_pk(media.pk))
                result["files"].append(str(img_path))
            
            elif media.media_type == 2:  # Video
                result["type"] = "video"
                video_path = download_path / "video.mp4"
                with open(video_path, "wb") as f:
                    f.write(client.video_download_by_pk(media.pk))
                result["files"].append(str(video_path))
            
            elif media.media_type == 8:  # Carrusel
                result["type"] = "carousel"
                for i, resource in enumerate(media.resources):
                    if resource.media_type == 1:
                        img_path = download_path / f"photo_{i}.jpg"
                        with open(img_path, "wb") as f:
                            f.write(client.photo_download_by_pk(resource.pk))
                        result["files"].append(str(img_path))
                    elif resource.media_type == 2:
                        video_path = download_path / f"video_{i}.mp4"
                        with open(video_path, "wb") as f:
                            f.write(client.video_download_by_pk(resource.pk))
                        result["files"].append(str(video_path))
            
            logger.info(f"Post descargado: {media_id}")
            return result
            
        except Exception as e:
            logger.error(f"Error downloading post: {e}")
            return None
    
    @staticmethod
    def download_profile_picture(username: str) -> Optional[str]:
        """Descarga la foto de perfil"""
        try:
            user: User = client.user_info_by_username(username)
            pic_path = DOWNLOADS_DIR / f"profile_{username}.jpg"
            
            with open(pic_path, "wb") as f:
                f.write(client.photo_download_by_url(user.profile_pic_url))
            
            logger.info(f"Profile pic descargada: {username}")
            return str(pic_path)
        except Exception as e:
            logger.error(f"Error downloading profile pic: {e}")
            return None
    
    @staticmethod
    def download_stories(username: str) -> Optional[list]:
        """Descarga las historias de un usuario"""
        try:
            user: User = client.user_info_by_username(username)
            stories = client.user_stories(user.pk)
            
            files = []
            stories_dir = DOWNLOADS_DIR / f"stories_{username}"
            stories_dir.mkdir(exist_ok=True)
            
            for i, story in enumerate(stories):
                if story.media_type == 1:
                    story_path = stories_dir / f"story_{i}.jpg"
                    with open(story_path, "wb") as f:
                        f.write(client.photo_download_by_pk(story.pk))
                    files.append(str(story_path))
                elif story.media_type == 2:
                    story_path = stories_dir / f"story_{i}.mp4"
                    with open(story_path, "wb") as f:
                        f.write(client.video_download_by_pk(story.pk))
                    files.append(str(story_path))
            
            logger.info(f"Historias descargadas: {len(files)}")
            return files
        except Exception as e:
            logger.error(f"Error downloading stories: {e}")
            return None
    
    @staticmethod
    def _extract_media_id(url: str) -> Optional[str]:
        """Extrae el media_id de una URL"""
        try:
            if "/p/" in url:
                code = url.split("/p/")[1].split("/")[0]
            elif "/reel/" in url:
                code = url.split("/reel/")[1].split("/")[0]
            elif "/tv/" in url:
                code = url.split("/tv/")[1].split("/")[0]
            else:
                return None
            
            from instagrapi.utils import decode_media_id
            media_id = decode_media_id(code)
            return media_id
        except Exception as e:
            logger.error(f"Error extracting media_id: {e}")
            return None


# Rutas API

@app.route('/health', methods=['GET'])
def health():
    """Health check"""
    return jsonify({
        "status": "ok",
        "service": "InstaDown Python Backend",
        "version": "2.0.0"
    })


@app.route('/api/user/<username>', methods=['GET'])
def get_user(username):
    """Obtener información del usuario"""
    try:
        user_info = InstagramDownloader.get_user_info(username)
        if user_info:
            return jsonify({"success": True, "data": user_info})
        else:
            return jsonify({"success": False, "error": "Usuario no encontrado"}), 404
    except Exception as e:
        logger.error(f"Error: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/download/post', methods=['POST'])
def download_post():
    """Descargar un post"""
    try:
        data = request.json
        url = data.get('url')
        
        if not url:
            return jsonify({"success": False, "error": "URL requerida"}), 400
        
        result = InstagramDownloader.download_post(url)
        if result:
            return jsonify({"success": True, "data": result})
        else:
            return jsonify({"success": False, "error": "Error al descargar"}), 500
    except Exception as e:
        logger.error(f"Error: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/download/profile-pic', methods=['POST'])
def download_profile_pic():
    """Descargar foto de perfil"""
    try:
        data = request.json
        username = data.get('username')
        
        if not username:
            return jsonify({"success": False, "error": "Username requerido"}), 400
        
        file_path = InstagramDownloader.download_profile_picture(username)
        if file_path:
            return jsonify({"success": True, "data": {"file": file_path}})
        else:
            return jsonify({"success": False, "error": "Error al descargar"}), 500
    except Exception as e:
        logger.error(f"Error: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/api/download/stories', methods=['POST'])
def download_stories():
    """Descargar historias"""
    try:
        data = request.json
        username = data.get('username')
        
        if not username:
            return jsonify({"success": False, "error": "Username requerido"}), 400
        
        files = InstagramDownloader.download_stories(username)
        if files is not None:
            return jsonify({"success": True, "data": {"files": files}})
        else:
            return jsonify({"success": False, "error": "Error al descargar"}), 500
    except Exception as e:
        logger.error(f"Error: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.errorhandler(404)
def not_found(error):
    return jsonify({"success": False, "error": "Endpoint no encontrado"}), 404


@app.errorhandler(500)
def internal_error(error):
    return jsonify({"success": False, "error": "Error interno del servidor"}), 500


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False)
