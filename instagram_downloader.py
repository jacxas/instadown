"""
Instagram Downloader Backend
Descarga contenido de Instagram usando instagrapi
"""

import os
import json
import logging
from pathlib import Path
from typing import Optional, Dict, List
from instagrapi import Client
from instagrapi.types import Media, User
import tempfile
import shutil

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class InstagramDownloader:
    def __init__(self):
        self.client = Client()
        self.session_file = Path(tempfile.gettempdir()) / "instagram_session.json"
        self.downloads_dir = Path(tempfile.gettempdir()) / "instagram_downloads"
        self.downloads_dir.mkdir(exist_ok=True)
        
    def login(self, username: str, password: str) -> bool:
        """Inicia sesión en Instagram"""
        try:
            self.client.login(username, password)
            logger.info(f"✓ Sesión iniciada como {username}")
            return True
        except Exception as e:
            logger.error(f"✗ Error al iniciar sesión: {e}")
            return False
    
    def get_user_info(self, username: str) -> Optional[Dict]:
        """Obtiene información del usuario"""
        try:
            user: User = self.client.user_info_by_username(username)
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
            logger.error(f"✗ Error al obtener info del usuario: {e}")
            return None
    
    def download_post(self, url: str, media_type: str = "auto") -> Optional[Dict]:
        """Descarga una publicación de Instagram"""
        try:
            # Extraer media_id de la URL
            if "instagram.com" not in url:
                logger.error("URL inválida")
                return None
            
            # Obtener el media_id de la URL
            media_id = self._extract_media_id(url)
            if not media_id:
                logger.error("No se pudo extraer el media_id")
                return None
            
            # Obtener información del media
            media: Media = self.client.media_info(media_id)
            
            # Descargar el contenido
            download_path = self.downloads_dir / f"post_{media_id}"
            download_path.mkdir(exist_ok=True)
            
            result = {
                "type": "unknown",
                "files": [],
                "caption": media.caption_text,
                "likes": media.like_count,
                "comments": media.comment_count,
            }
            
            # Descargar fotos
            if media.media_type == 1:  # Foto
                result["type"] = "photo"
                img_path = download_path / "photo.jpg"
                with open(img_path, "wb") as f:
                    f.write(self.client.photo_download_by_pk(media.pk))
                result["files"].append(str(img_path))
            
            # Descargar videos/reels
            elif media.media_type == 2:  # Video
                result["type"] = "video"
                video_path = download_path / "video.mp4"
                with open(video_path, "wb") as f:
                    f.write(self.client.video_download_by_pk(media.pk))
                result["files"].append(str(video_path))
            
            # Descargar carrusel (múltiples fotos/videos)
            elif media.media_type == 8:  # Carrusel
                result["type"] = "carousel"
                for i, resource in enumerate(media.resources):
                    if resource.media_type == 1:  # Foto
                        img_path = download_path / f"photo_{i}.jpg"
                        with open(img_path, "wb") as f:
                            f.write(self.client.photo_download_by_pk(resource.pk))
                        result["files"].append(str(img_path))
                    elif resource.media_type == 2:  # Video
                        video_path = download_path / f"video_{i}.mp4"
                        with open(video_path, "wb") as f:
                            f.write(self.client.video_download_by_pk(resource.pk))
                        result["files"].append(str(video_path))
            
            logger.info(f"✓ Descarga completada: {media_type}")
            return result
            
        except Exception as e:
            logger.error(f"✗ Error al descargar: {e}")
            return None
    
    def download_profile_picture(self, username: str) -> Optional[str]:
        """Descarga la foto de perfil de un usuario"""
        try:
            user: User = self.client.user_info_by_username(username)
            pic_path = self.downloads_dir / f"profile_{username}.jpg"
            
            with open(pic_path, "wb") as f:
                f.write(self.client.photo_download_by_url(user.profile_pic_url))
            
            logger.info(f"✓ Foto de perfil descargada: {username}")
            return str(pic_path)
        except Exception as e:
            logger.error(f"✗ Error al descargar foto de perfil: {e}")
            return None
    
    def download_stories(self, username: str) -> Optional[List[str]]:
        """Descarga las historias de un usuario"""
        try:
            user: User = self.client.user_info_by_username(username)
            stories = self.client.user_stories(user.pk)
            
            files = []
            stories_dir = self.downloads_dir / f"stories_{username}"
            stories_dir.mkdir(exist_ok=True)
            
            for i, story in enumerate(stories):
                if story.media_type == 1:  # Foto
                    story_path = stories_dir / f"story_{i}.jpg"
                    with open(story_path, "wb") as f:
                        f.write(self.client.photo_download_by_pk(story.pk))
                    files.append(str(story_path))
                elif story.media_type == 2:  # Video
                    story_path = stories_dir / f"story_{i}.mp4"
                    with open(story_path, "wb") as f:
                        f.write(self.client.video_download_by_pk(story.pk))
                    files.append(str(story_path))
            
            logger.info(f"✓ {len(files)} historias descargadas")
            return files
        except Exception as e:
            logger.error(f"✗ Error al descargar historias: {e}")
            return None
    
    def download_highlights(self, username: str) -> Optional[Dict]:
        """Descarga los destacados de un usuario"""
        try:
            user: User = self.client.user_info_by_username(username)
            highlights = self.client.user_highlights(user.pk)
            
            result = {}
            highlights_dir = self.downloads_dir / f"highlights_{username}"
            highlights_dir.mkdir(exist_ok=True)
            
            for highlight in highlights:
                highlight_files = []
                highlight_dir = highlights_dir / highlight.title
                highlight_dir.mkdir(exist_ok=True)
                
                for i, item in enumerate(highlight.items):
                    if item.media_type == 1:  # Foto
                        item_path = highlight_dir / f"item_{i}.jpg"
                        with open(item_path, "wb") as f:
                            f.write(self.client.photo_download_by_pk(item.pk))
                        highlight_files.append(str(item_path))
                    elif item.media_type == 2:  # Video
                        item_path = highlight_dir / f"item_{i}.mp4"
                        with open(item_path, "wb") as f:
                            f.write(self.client.video_download_by_pk(item.pk))
                        highlight_files.append(str(item_path))
                
                result[highlight.title] = highlight_files
            
            logger.info(f"✓ Destacados descargados")
            return result
        except Exception as e:
            logger.error(f"✗ Error al descargar destacados: {e}")
            return None
    
    def _extract_media_id(self, url: str) -> Optional[str]:
        """Extrae el media_id de una URL de Instagram"""
        try:
            # Soporta URLs como:
            # https://www.instagram.com/p/CODE/
            # https://www.instagram.com/reel/CODE/
            # https://www.instagram.com/tv/CODE/
            
            if "/p/" in url:
                code = url.split("/p/")[1].split("/")[0]
            elif "/reel/" in url:
                code = url.split("/reel/")[1].split("/")[0]
            elif "/tv/" in url:
                code = url.split("/tv/")[1].split("/")[0]
            else:
                return None
            
            # Convertir código a media_id
            from instagrapi.utils import decode_media_id
            media_id = decode_media_id(code)
            return media_id
        except Exception as e:
            logger.error(f"✗ Error al extraer media_id: {e}")
            return None
    
    def cleanup(self):
        """Limpia los archivos descargados"""
        try:
            shutil.rmtree(self.downloads_dir)
            logger.info("✓ Archivos limpios")
        except Exception as e:
            logger.error(f"✗ Error al limpiar: {e}")


if __name__ == "__main__":
    # Ejemplo de uso
    downloader = InstagramDownloader()
    
    # Nota: Necesitas credenciales de Instagram válidas
    # downloader.login("tu_usuario", "tu_contraseña")
    
    # Descargar un post
    # result = downloader.download_post("https://www.instagram.com/p/...")
    # print(json.dumps(result, indent=2))
