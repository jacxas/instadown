# Guía de Despliegue - InstaDown Pro v2.0

## 🏗️ Arquitectura

```
┌─────────────────────────────────────────────────┐
│         Frontend (Vercel)                        │
│  - index.html                                    │
│  - styles.css                                    │
│  - script_v2.js                                  │
└────────────────┬────────────────────────────────┘
                 │
                 ├─────────────────────────────────┐
                 │                                 │
        ┌────────▼──────────┐          ┌──────────▼────────┐
        │  Node.js API      │          │  Python Backend   │
        │  (Vercel)         │          │  (Railway)        │
        │  - server.js      │          │  - python_backend │
        │  - script_v2.js   │          │  - instagrapi     │
        └───────────────────┘          └───────────────────┘
```

## 📋 Requisitos

- Cuenta en Vercel (para Node.js)
- Cuenta en Railway (para Python)
- GitHub conectado

## 🚀 Despliegue en Vercel (Frontend + Node.js)

### 1. Conectar GitHub a Vercel

```bash
# Ya está hecho - el repositorio está en GitHub
# Vercel detectará automáticamente el push
```

### 2. Configurar en Vercel

1. Ir a https://vercel.com/dashboard
2. Importar repositorio `instadown`
3. Configurar variables de entorno:
   - `PYTHON_BACKEND_URL` = URL del backend de Railway
   - `NODE_ENV` = production

### 3. Desplegar

```bash
# El despliegue es automático al hacer push a main
git push origin main
```

## 🚀 Despliegue en Railway (Python Backend)

### 1. Crear proyecto en Railway

```bash
# Opción A: Desde CLI
railway init
railway up

# Opción B: Desde web
# Ir a https://railway.app/dashboard
# Crear nuevo proyecto
# Conectar GitHub
```

### 2. Configurar Railway

1. Ir a https://railway.app/dashboard
2. Crear nuevo proyecto
3. Conectar repositorio GitHub: `jacxas/instadown`
4. Configurar:
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `python python_backend.py`
   - **Port:** 5000

### 3. Obtener URL del Backend

Una vez desplegado, Railway te dará una URL como:
```
https://instadown-prod-xxxx.railway.app
```

## 🔗 Conectar Frontend con Backend

### 1. Actualizar script_v2.js

En `script_v2.js`, reemplazar:

```javascript
const API_BASE = window.location.origin;
```

Con:

```javascript
const API_BASE = process.env.REACT_APP_PYTHON_BACKEND_URL || 'https://instadown-prod-xxxx.railway.app';
```

### 2. Configurar variable en Vercel

En Vercel Dashboard:
1. Ir a Settings → Environment Variables
2. Agregar:
   - **Name:** `REACT_APP_PYTHON_BACKEND_URL`
   - **Value:** `https://instadown-prod-xxxx.railway.app`

### 3. Hacer push

```bash
git add .
git commit -m "chore: Configurar URL del backend de Railway"
git push origin main
```

## ✅ Verificar Despliegue

### Frontend (Vercel)
```bash
curl https://instadown-coral.vercel.app
# Debe retornar el HTML
```

### Backend (Railway)
```bash
curl https://instadown-prod-xxxx.railway.app/health
# Debe retornar: {"status": "ok", "service": "InstaDown Python Backend"}
```

## 🔐 Variables de Entorno

### Vercel
```
PYTHON_BACKEND_URL=https://instadown-prod-xxxx.railway.app
NODE_ENV=production
PORT=3000
```

### Railway
```
PORT=5000
FLASK_ENV=production
```

## 📊 Monitoreo

### Vercel
- Dashboard: https://vercel.com/dashboard
- Logs: Settings → Deployments → Logs

### Railway
- Dashboard: https://railway.app/dashboard
- Logs: Project → Deployments → Logs

## 🐛 Troubleshooting

### Error: "Backend no responde"
```bash
# Verificar que Railway está corriendo
curl https://instadown-prod-xxxx.railway.app/health

# Verificar logs en Railway
railway logs
```

### Error: "CORS bloqueado"
```javascript
// El backend ya tiene CORS habilitado
// Si persiste, verificar que las URLs coincidan
```

### Error: "instagrapi no encontrado"
```bash
# Verificar que requirements.txt está en Railway
# Ir a Railway → Settings → Build & Deploy
# Verificar que pip install se ejecuta
```

## 🚀 Actualizar Código

```bash
# Hacer cambios
git add .
git commit -m "feat: Descripción de cambios"
git push origin main

# Vercel se actualiza automáticamente
# Railway se actualiza si está conectado a GitHub
```

## 📝 Notas Importantes

1. **Límites de Railway:**
   - Plan gratuito: 5GB/mes
   - Reinicio automático si excede límites
   - Máximo 3 proyectos

2. **Límites de Vercel:**
   - Plan gratuito: 100GB/mes
   - Máximo 12 deployments/día

3. **Instagram API:**
   - Puede bloquear IPs que hacen muchas solicitudes
   - Considerar usar proxy si es necesario

## 🎯 URLs Finales

- **Frontend:** https://instadown-coral.vercel.app
- **Backend:** https://instadown-prod-xxxx.railway.app
- **GitHub:** https://github.com/jacxas/instadown

---

**InstaDown Pro v2.0** - Desplegado en Vercel + Railway ✨
