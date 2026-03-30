const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Almacenamiento en memoria (en producción usar base de datos)
const users = new Map();
const downloadLimits = new Map();

// Inicializar límites
function initializeUser(userId) {
    if (!downloadLimits.has(userId)) {
        downloadLimits.set(userId, {
            free: 2,
            premium: false,
            downloads: []
        });
    }
}

// API: Obtener información del usuario
app.get('/api/user/:username', (req, res) => {
    const { username } = req.params;
    
    // Ejecutar script Python
    const python = spawn('python3', [
        path.join(__dirname, 'instagram_downloader.py'),
        'get_user_info',
        username
    ]);
    
    let output = '';
    python.stdout.on('data', (data) => {
        output += data.toString();
    });
    
    python.on('close', (code) => {
        if (code === 0) {
            try {
                const userInfo = JSON.parse(output);
                res.json({ success: true, data: userInfo });
            } catch (e) {
                res.status(500).json({ success: false, error: 'Error parsing response' });
            }
        } else {
            res.status(500).json({ success: false, error: 'Failed to fetch user info' });
        }
    });
});

// API: Descargar post
app.post('/api/download/post', (req, res) => {
    const { url, userId } = req.body;
    
    if (!url) {
        return res.status(400).json({ success: false, error: 'URL requerida' });
    }
    
    // Inicializar usuario
    initializeUser(userId || 'anonymous');
    const userLimits = downloadLimits.get(userId || 'anonymous');
    
    // Verificar límite de descargas gratuitas
    if (!userLimits.premium && userLimits.free <= 0) {
        return res.status(403).json({ 
            success: false, 
            error: 'Límite de descargas gratuitas alcanzado. Obtén Premium por $0.25/mes',
            requiresPremium: true
        });
    }
    
    // Ejecutar descarga
    const python = spawn('python3', [
        path.join(__dirname, 'instagram_downloader.py'),
        'download_post',
        url
    ]);
    
    let output = '';
    python.stdout.on('data', (data) => {
        output += data.toString();
    });
    
    python.on('close', (code) => {
        if (code === 0) {
            try {
                const result = JSON.parse(output);
                
                // Decrementar descargas gratuitas
                if (!userLimits.premium) {
                    userLimits.free--;
                }
                
                // Registrar descarga
                userLimits.downloads.push({
                    url,
                    timestamp: new Date(),
                    type: result.type
                });
                
                res.json({ 
                    success: true, 
                    data: result,
                    remainingDownloads: userLimits.free
                });
            } catch (e) {
                res.status(500).json({ success: false, error: 'Error procesando descarga' });
            }
        } else {
            res.status(500).json({ success: false, error: 'Error al descargar contenido' });
        }
    });
});

// API: Descargar foto de perfil
app.post('/api/download/profile-pic', (req, res) => {
    const { username, userId } = req.body;
    
    if (!username) {
        return res.status(400).json({ success: false, error: 'Username requerido' });
    }
    
    initializeUser(userId || 'anonymous');
    const userLimits = downloadLimits.get(userId || 'anonymous');
    
    if (!userLimits.premium && userLimits.free <= 0) {
        return res.status(403).json({ 
            success: false, 
            error: 'Límite alcanzado',
            requiresPremium: true
        });
    }
    
    const python = spawn('python3', [
        path.join(__dirname, 'instagram_downloader.py'),
        'download_profile_pic',
        username
    ]);
    
    let output = '';
    python.stdout.on('data', (data) => {
        output += data.toString();
    });
    
    python.on('close', (code) => {
        if (code === 0) {
            if (!userLimits.premium) {
                userLimits.free--;
            }
            
            res.json({ 
                success: true, 
                data: { file: output.trim() },
                remainingDownloads: userLimits.free
            });
        } else {
            res.status(500).json({ success: false, error: 'Error al descargar foto de perfil' });
        }
    });
});

// API: Descargar historias
app.post('/api/download/stories', (req, res) => {
    const { username, userId } = req.body;
    
    if (!username) {
        return res.status(400).json({ success: false, error: 'Username requerido' });
    }
    
    initializeUser(userId || 'anonymous');
    const userLimits = downloadLimits.get(userId || 'anonymous');
    
    if (!userLimits.premium && userLimits.free <= 0) {
        return res.status(403).json({ 
            success: false, 
            error: 'Límite alcanzado',
            requiresPremium: true
        });
    }
    
    const python = spawn('python3', [
        path.join(__dirname, 'instagram_downloader.py'),
        'download_stories',
        username
    ]);
    
    let output = '';
    python.stdout.on('data', (data) => {
        output += data.toString();
    });
    
    python.on('close', (code) => {
        if (code === 0) {
            if (!userLimits.premium) {
                userLimits.free--;
            }
            
            try {
                const files = JSON.parse(output);
                res.json({ 
                    success: true, 
                    data: { files },
                    remainingDownloads: userLimits.free
                });
            } catch (e) {
                res.status(500).json({ success: false, error: 'Error procesando historias' });
            }
        } else {
            res.status(500).json({ success: false, error: 'Error al descargar historias' });
        }
    });
});

// API: Obtener estado del usuario
app.get('/api/user-status/:userId', (req, res) => {
    const { userId } = req.params;
    initializeUser(userId);
    
    const limits = downloadLimits.get(userId);
    res.json({
        success: true,
        data: {
            premium: limits.premium,
            remainingDownloads: limits.free,
            totalDownloads: limits.downloads.length
        }
    });
});

// API: Activar Premium (demo)
app.post('/api/premium/activate', (req, res) => {
    const { userId } = req.body;
    initializeUser(userId);
    
    const limits = downloadLimits.get(userId);
    limits.premium = true;
    limits.free = Infinity;
    
    res.json({
        success: true,
        message: 'Premium activado!',
        data: limits
    });
});

// Servir archivos descargados
app.get('/download/:filename', (req, res) => {
    const { filename } = req.params;
    const filepath = path.join(__dirname, 'downloads', filename);
    
    // Seguridad: verificar que el archivo está en el directorio correcto
    if (!filepath.startsWith(path.join(__dirname, 'downloads'))) {
        return res.status(403).json({ error: 'Acceso denegado' });
    }
    
    if (fs.existsSync(filepath)) {
        res.download(filepath);
    } else {
        res.status(404).json({ error: 'Archivo no encontrado' });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', message: 'InstaDown API is running' });
});

// Error handling
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ 
        success: false, 
        error: 'Error interno del servidor',
        message: err.message 
    });
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n✓ InstaDown API running on port ${PORT}`);
    console.log(`✓ Frontend: http://localhost:${PORT}`);
    console.log(`✓ API Health: http://localhost:${PORT}/health\n`);
});
