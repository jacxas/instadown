# InstaDown Pro v2.0 - Descargador Nativo de Instagram

## 🎯 Cambios Principales

### ✅ Versión 1.0 (Anterior)
- Redirección a FastDl.app (servicio externo)
- Sin funcionalidad nativa
- Dependencia de terceros

### ✅ Versión 2.0 (Nueva)
- **Descargador nativo** usando instagrapi
- **Backend Express.js** con API REST
- **Descargas directas** sin redirecciones
- **Base de datos** para usuarios y límites
- **Sistema Premium** integrado
- **Soporte para:**
  - Fotos
  - Videos
  - Reels
  - Historias
  - Destacados
  - Perfiles

## 📋 Requisitos

- Node.js 14+
- Python 3.8+
- npm o pnpm

## 🚀 Instalación

### 1. Instalar dependencias

```bash
# Instalar dependencias Node.js
npm install

# Instalar dependencias Python
pip3 install instagrapi
```

### 2. Configurar variables de entorno

Crear archivo `.env`:

```env
PORT=3000
NODE_ENV=development
```

### 3. Iniciar el servidor

```bash
# Desarrollo
npm run dev

# Producción
npm start
```

El servidor estará disponible en: `http://localhost:3000`

## 📡 API Endpoints

### Obtener información del usuario
```
GET /api/user/:username
```

Respuesta:
```json
{
  "success": true,
  "data": {
    "id": "123456",
    "username": "instagram",
    "full_name": "Instagram",
    "biography": "...",
    "follower_count": 500000000,
    "media_count": 5000
  }
}
```

### Descargar post
```
POST /api/download/post
```

Body:
```json
{
  "url": "https://www.instagram.com/p/ABC123/",
  "userId": "user_123"
}
```

### Descargar foto de perfil
```
POST /api/download/profile-pic
```

Body:
```json
{
  "username": "instagram",
  "userId": "user_123"
}
```

### Descargar historias
```
POST /api/download/stories
```

Body:
```json
{
  "username": "instagram",
  "userId": "user_123"
}
```

### Obtener estado del usuario
```
GET /api/user-status/:userId
```

### Activar Premium
```
POST /api/premium/activate
```

Body:
```json
{
  "userId": "user_123"
}
```

## 🎨 Frontend

El frontend se ha mejorado para usar la API nativa:

- **script_v2.js** - Nueva versión con API backend
- **index.html** - Interfaz actualizada
- **styles.css** - Estilos mejorados

### Cambios en el Frontend

1. Reemplazar `script.js` con `script_v2.js`
2. Actualizar `index.html` para usar la nueva versión:

```html
<script src="script_v2.js"></script>
```

## 🔐 Seguridad

- ✅ Validación de URLs
- ✅ Límite de descargas por usuario
- ✅ Sistema de autenticación básico
- ✅ CORS configurado
- ✅ Manejo de errores

## 📊 Límites de Descargas

### Plan Gratuito
- 2 descargas por día
- Calidad HD
- Sin marcas de agua

### Plan Premium ($0.25/mes)
- Descargas ilimitadas
- Descarga múltiple
- Máxima calidad
- Soporte prioritario

## 🐛 Troubleshooting

### Error: "instagrapi no encontrado"
```bash
sudo pip3 install instagrapi
```

### Error: "Puerto 3000 en uso"
```bash
# Usar otro puerto
PORT=3001 npm start
```

### Error: "No se puede conectar a Instagram"
- Verificar conexión a internet
- Instagram puede bloquear acceso desde ciertos IPs
- Considerar usar proxy

## 🔄 Migración desde v1.0

1. Hacer backup de archivos actuales
2. Reemplazar `script.js` con `script_v2.js`
3. Instalar dependencias: `npm install`
4. Instalar instagrapi: `pip3 install instagrapi`
5. Iniciar servidor: `npm start`

## 📝 Notas Importantes

- Las descargas se almacenan en `/tmp/instagram_downloads`
- Los datos de usuarios se guardan en memoria (usar base de datos en producción)
- Respetar los términos de servicio de Instagram
- No descargar contenido privado sin permiso

## 🚀 Próximas Mejoras

- [ ] Integración con base de datos (PostgreSQL/MongoDB)
- [ ] Sistema de pago real (Stripe)
- [ ] Autenticación de usuarios
- [ ] Descarga de álbumes completos
- [ ] Conversión de formatos
- [ ] Interfaz mejorada
- [ ] Soporte para múltiples idiomas

## 📧 Soporte

Para reportar problemas o sugerencias, contacta a: support@instadown.local

---

**InstaDown Pro v2.0** - Descargador de Instagram nativo y funcional ✨
