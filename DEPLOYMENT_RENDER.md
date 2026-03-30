# Guía de Despliegue en Render - InstaDown Pro v2.0

## 🏗️ Arquitectura

```
┌──────────────────────────────────────────────────┐
│         Frontend (Vercel)                         │
│  - index.html, styles.css, script_v2.js          │
└────────────────┬─────────────────────────────────┘
                 │
                 │ API Calls
                 │
        ┌────────▼──────────────────────┐
        │  Python Backend (Render)      │
        │  - python_backend.py          │
        │  - Flask + instagrapi         │
        │  - Docker Container           │
        └───────────────────────────────┘
```

## 📋 Requisitos

- ✅ Cuenta en GitHub (ya tienes)
- ✅ Cuenta en Vercel (ya tienes)
- 🆕 Cuenta en Render (crear en https://render.com)

## 🚀 Paso 1: Crear Cuenta en Render

1. Ir a https://render.com
2. Hacer clic en "Get Started"
3. Conectar con GitHub
4. Autorizar acceso a tus repositorios

## 🚀 Paso 2: Desplegar Backend en Render

### Opción A: Desde Dashboard de Render (Recomendado)

1. Ir a https://dashboard.render.com
2. Hacer clic en "New +" → "Web Service"
3. Seleccionar repositorio: `instadown`
4. Configurar:
   - **Name:** `instadown-backend`
   - **Environment:** `Python 3`
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `python python_backend.py`
   - **Plan:** Free
5. Hacer clic en "Create Web Service"

### Opción B: Desde GitHub (Automático)

Render detectará automáticamente `render.yaml` y desplegará según esa configuración.

## 🚀 Paso 3: Obtener URL del Backend

Una vez desplegado (puede tomar 2-5 minutos):

1. Ir a https://dashboard.render.com
2. Hacer clic en tu servicio `instadown-backend`
3. Copiar la URL (ej: `https://instadown-backend.onrender.com`)

## 🔗 Paso 4: Conectar Frontend con Backend

### Actualizar script_v2.js

En `/tmp/instadown/script_v2.js`, buscar:

```javascript
const API_BASE = window.location.origin;
```

Reemplazar con:

```javascript
const API_BASE = 'https://instadown-backend.onrender.com';
```

### Hacer Commit y Push

```bash
cd /tmp/instadown
git add script_v2.js
git commit -m "chore: Configurar URL del backend de Render"
git push origin main
```

Vercel se actualizará automáticamente.

## ✅ Verificar Despliegue

### Frontend (Vercel)
```bash
curl https://instadown-coral.vercel.app
# Debe retornar HTML
```

### Backend (Render)
```bash
curl https://instadown-backend.onrender.com/health
# Debe retornar: {"status": "ok", "service": "InstaDown Python Backend"}
```

## 🧪 Probar Funcionalidad

### 1. Obtener información de usuario

```bash
curl -X GET "https://instadown-backend.onrender.com/api/user/instagram"
```

Respuesta esperada:
```json
{
  "success": true,
  "data": {
    "username": "instagram",
    "full_name": "Instagram",
    "follower_count": 500000000,
    ...
  }
}
```

### 2. Descargar un post

```bash
curl -X POST "https://instadown-backend.onrender.com/api/download/post" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.instagram.com/p/ABC123/"}'
```

## 📊 Monitoreo

### Logs en Render

1. Ir a https://dashboard.render.com
2. Hacer clic en tu servicio
3. Ir a "Logs" para ver eventos en tiempo real

### Métricas

- **CPU:** Mostrado en dashboard
- **Memoria:** Mostrado en dashboard
- **Solicitudes:** Mostrado en Logs

## 🔐 Variables de Entorno

Si necesitas agregar variables en Render:

1. Ir a tu servicio en dashboard
2. Hacer clic en "Environment"
3. Agregar variables (ej: API keys, tokens)

## 🐛 Troubleshooting

### Error: "Service failed to deploy"

```bash
# Verificar que requirements.txt existe
ls -la requirements.txt

# Verificar que python_backend.py es válido
python3 -m py_compile python_backend.py
```

### Error: "Connection refused"

```bash
# Esperar a que Render termine el despliegue (2-5 minutos)
# Verificar que la URL es correcta
# Verificar que el backend está corriendo: curl https://instadown-backend.onrender.com/health
```

### Error: "CORS bloqueado"

El backend ya tiene CORS habilitado. Si persiste:

1. Ir a Render dashboard
2. Verificar que el servicio está "Live"
3. Reiniciar el servicio: "Manual Deploy"

### Servicio se detiene después de 15 minutos

Render pone en pausa servicios gratuitos inactivos. Esto es normal. Se reinician automáticamente al recibir una solicitud.

## 🚀 Actualizar Código

```bash
# Hacer cambios
git add .
git commit -m "feat: Descripción"
git push origin main

# Render se actualiza automáticamente (si está conectado a GitHub)
# O hacer deploy manual desde dashboard
```

## 📝 Notas Importantes

### Plan Gratuito de Render

- ✅ 750 horas/mes (suficiente para 1 servicio 24/7)
- ✅ 0.5 GB RAM
- ✅ Reinicio automático después de 15 min de inactividad
- ✅ Builds ilimitados
- ❌ Sin SSL personalizado
- ❌ Sin soporte prioritario

### Limitaciones de Instagram

- Instagram puede bloquear IPs que hacen muchas solicitudes
- Considerar usar proxy si es necesario
- Respetar rate limits

## 🎯 URLs Finales

| Componente | URL |
|-----------|-----|
| Frontend | https://instadown-coral.vercel.app |
| Backend | https://instadown-backend.onrender.com |
| GitHub | https://github.com/jacxas/instadown |
| Render Dashboard | https://dashboard.render.com |
| Vercel Dashboard | https://vercel.com/dashboard |

## 📋 Checklist de Despliegue

- [ ] Crear cuenta en Render
- [ ] Conectar GitHub a Render
- [ ] Desplegar backend en Render
- [ ] Obtener URL del backend
- [ ] Actualizar script_v2.js con URL
- [ ] Hacer push a GitHub
- [ ] Verificar que Vercel se actualiza
- [ ] Probar frontend en Vercel
- [ ] Probar backend en Render
- [ ] Probar integración completa

## 🎉 ¡Listo!

Tu InstaDown Pro v2.0 está completamente desplegado:
- **Frontend:** Vercel (Node.js)
- **Backend:** Render (Python)
- **Repositorio:** GitHub

---

**InstaDown Pro v2.0** - Desplegado en Vercel + Render ✨
