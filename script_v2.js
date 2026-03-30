// InstaDown Pro - Frontend v2.0
// Usa API backend nativa para descargas

// Estado
let currentTab = 'perfil';
let downloadsRemaining = 2;
let isPremium = false;
let userId = localStorage.getItem('userId') || 'user_' + Math.random().toString(36).substr(2, 9);

// Configurar URL del backend
const API_BASE = (() => {
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return 'http://localhost:5000';
  }
  return 'https://instadown-backend.onrender.com';
})();

console.log('🔗 Backend URL:', API_BASE);

// Guardar userId
localStorage.setItem('userId', userId);

// Tab functionality
document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentTab = tab.dataset.tab;
        updatePlaceholder();
    });
});

function updatePlaceholder() {
    const input = document.getElementById('urlInput');
    const placeholders = {
        'perfil': 'Inserta nombre de usuario (ej: instagram)',
        'foto': 'Inserta enlace de la publicacion (ej: https://www.instagram.com/p/...)',
        'video': 'Inserta enlace del video (ej: https://www.instagram.com/p/...)',
        'historias': 'Inserta nombre de usuario',
        'reels': 'Inserta enlace del reel (ej: https://www.instagram.com/reel/...)',
        'dp': 'Inserta nombre de usuario',
        'destacados': 'Inserta nombre de usuario'
    };
    input.placeholder = placeholders[currentTab] || 'Inserta enlace o nombre de usuario';
}

// Descargar contenido - NUEVA VERSIÓN CON API NATIVA
async function handleDownload() {
    const input = document.getElementById('urlInput').value.trim();
    
    if (!input) {
        showNotification('Por favor, ingresa un enlace o nombre de usuario', 'error');
        return;
    }
    
    if (!isPremium && downloadsRemaining <= 0) {
        showNotification('Has alcanzado el límite de descargas gratuitas. Obtén Premium por solo $0.25/mes!', 'warning');
        openModal('premium');
        return;
    }
    
    showNotification('Procesando descarga...', 'info');
    
    try {
        let endpoint = '';
        let payload = { userId };
        
        switch(currentTab) {
            case 'perfil':
                endpoint = '/api/user/' + input.replace('@', '');
                const userResponse = await fetch(`${API_BASE}${endpoint}`);
                const userData = await userResponse.json();
                
                if (userData.success) {
                    showDownloadResult('profile', userData.data);
                    decrementDownloads();
                } else {
                    showNotification('Error: ' + userData.error, 'error');
                }
                break;
                
            case 'foto':
            case 'video':
            case 'reels':
                endpoint = '/api/download/post';
                payload.url = input;
                
                const postResponse = await fetch(`${API_BASE}${endpoint}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                
                const postData = await postResponse.json();
                
                if (postData.success) {
                    showDownloadResult('post', postData.data);
                    downloadsRemaining = postData.remainingDownloads;
                    updateDownloadsCounter();
                    showNotification('✓ Descarga completada!', 'success');
                } else if (postData.requiresPremium) {
                    showNotification(postData.error, 'warning');
                    openModal('premium');
                } else {
                    showNotification('Error: ' + postData.error, 'error');
                }
                break;
                
            case 'historias':
                endpoint = '/api/download/stories';
                payload.username = input.replace('@', '');
                
                const storiesResponse = await fetch(`${API_BASE}${endpoint}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                
                const storiesData = await storiesResponse.json();
                
                if (storiesData.success) {
                    showDownloadResult('stories', storiesData.data);
                    downloadsRemaining = storiesData.remainingDownloads;
                    updateDownloadsCounter();
                    showNotification('✓ Historias descargadas!', 'success');
                } else if (storiesData.requiresPremium) {
                    showNotification(storiesData.error, 'warning');
                    openModal('premium');
                } else {
                    showNotification('Error: ' + storiesData.error, 'error');
                }
                break;
                
            case 'dp':
                endpoint = '/api/download/profile-pic';
                payload.username = input.replace('@', '');
                
                const dpResponse = await fetch(`${API_BASE}${endpoint}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                
                const dpData = await dpResponse.json();
                
                if (dpData.success) {
                    showDownloadResult('profile-pic', dpData.data);
                    decrementDownloads();
                    showNotification('✓ Foto de perfil descargada!', 'success');
                } else if (dpData.requiresPremium) {
                    showNotification(dpData.error, 'warning');
                    openModal('premium');
                } else {
                    showNotification('Error: ' + dpData.error, 'error');
                }
                break;
        }
        
    } catch (error) {
        console.error('Error:', error);
        showNotification('Error de conexión: ' + error.message, 'error');
    }
}

function decrementDownloads() {
    if (!isPremium) {
        downloadsRemaining--;
        updateDownloadsCounter();
    }
}

function showDownloadResult(type, data) {
    const resultsArea = document.getElementById('resultsArea') || createResultsArea();
    
    let html = '<div class="download-result">';
    html += '<h3>✓ Descarga Completada</h3>';
    
    if (type === 'profile') {
        html += `
            <div class="profile-info">
                <img src="${data.profile_pic_url}" alt="Profile" class="profile-pic">
                <div class="profile-details">
                    <h4>${data.full_name}</h4>
                    <p class="username">@${data.username}</p>
                    <p class="bio">${data.biography}</p>
                    <div class="stats">
                        <div class="stat">
                            <span class="label">Seguidores</span>
                            <span class="value">${data.follower_count}</span>
                        </div>
                        <div class="stat">
                            <span class="label">Siguiendo</span>
                            <span class="value">${data.following_count}</span>
                        </div>
                        <div class="stat">
                            <span class="label">Posts</span>
                            <span class="value">${data.media_count}</span>
                        </div>
                    </div>
                </div>
            </div>
        `;
    } else if (type === 'post') {
        html += `
            <div class="post-info">
                <p class="caption">${data.caption}</p>
                <div class="post-stats">
                    <span>❤️ ${data.likes} likes</span>
                    <span>💬 ${data.comments} comentarios</span>
                </div>
                <p class="download-note">Tu ${data.type} está listo para descargar</p>
            </div>
        `;
    } else if (type === 'stories') {
        html += `
            <div class="stories-info">
                <p>${data.files.length} historias descargadas</p>
                <p class="download-note">Tus historias están listas</p>
            </div>
        `;
    } else if (type === 'profile-pic') {
        html += `
            <div class="pic-info">
                <img src="${data.file}" alt="Profile Picture" class="downloaded-pic">
                <p class="download-note">Foto de perfil descargada</p>
            </div>
        `;
    }
    
    html += '</div>';
    resultsArea.innerHTML = html;
    resultsArea.style.display = 'block';
}

function createResultsArea() {
    const area = document.createElement('div');
    area.id = 'resultsArea';
    area.className = 'results-area';
    document.querySelector('.downloader').appendChild(area);
    return area;
}

function updateDownloadsCounter() {
    const counter = document.getElementById('downloadCount');
    if (counter) {
        if (isPremium) {
            counter.textContent = '∞/∞';
        } else {
            counter.textContent = `${downloadsRemaining}/2`;
        }
    }
}

// Notification system
function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.innerHTML = `
        <span>${message}</span>
        <button onclick="this.parentElement.remove()">X</button>
    `;
    
    const container = document.getElementById('notificationContainer') || document.body;
    container.appendChild(notification);
    
    setTimeout(() => {
        notification.classList.add('fade-out');
        setTimeout(() => notification.remove(), 300);
    }, 4000);
}

// Modal functionality
function openModal(type) {
    const modal = document.getElementById('modal');
    const modalContent = document.getElementById('modalContent');
    
    if (type === 'premium') {
        modalContent.innerHTML = `
            <div class="premium-modal">
                <h2>InstaDown Premium</h2>
                <div class="price-highlight">
                    <span class="price">$0.25</span>
                    <span class="period">/mes</span>
                </div>
                <ul class="premium-features">
                    <li>✓ Descargas ilimitadas</li>
                    <li>✓ Descarga múltiple</li>
                    <li>✓ Sin anuncios</li>
                    <li>✓ Máxima calidad</li>
                    <li>✓ Soporte prioritario</li>
                    <li>✓ Descarga de historias</li>
                    <li>✓ Descarga de destacados</li>
                </ul>
                <button class="premium-btn" onclick="subscribePremium()">Obtener Premium - $0.25/mes</button>
                <p class="guarantee">Garantía de 7 días</p>
            </div>
        `;
    }
    
    modal.style.display = 'flex';
}

function closeModal() {
    document.getElementById('modal').style.display = 'none';
}

// Premium subscription
function subscribePremium() {
    showNotification('Activando Premium...', 'info');
    
    fetch(`${API_BASE}/api/premium/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId })
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            isPremium = true;
            downloadsRemaining = Infinity;
            closeModal();
            showNotification('¡Bienvenido a Premium! Ahora tienes descargas ilimitadas', 'success');
            updateDownloadsCounter();
        }
    })
    .catch(err => showNotification('Error: ' + err.message, 'error'));
}

// Close modal when clicking outside
window.onclick = function(event) {
    const modal = document.getElementById('modal');
    if (event.target === modal) {
        closeModal();
    }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    updatePlaceholder();
    updateDownloadsCounter();
    
    // Add notification container
    if (!document.getElementById('notificationContainer')) {
        const container = document.createElement('div');
        container.id = 'notificationContainer';
        document.body.appendChild(container);
    }
    
    // Load user status
    fetch(`${API_BASE}/api/user-status/${userId}`)
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                isPremium = data.data.premium;
                downloadsRemaining = data.data.remainingDownloads;
                updateDownloadsCounter();
            }
        })
        .catch(err => console.error('Error loading user status:', err));
});
