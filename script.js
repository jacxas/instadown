// State
let currentTab = 'perfil';
let downloadsRemaining = 2;
let isPremium = false;

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

// Download functionality - Redirects to FastDl.app
function handleDownload() {
    const input = document.getElementById('urlInput').value.trim();
    
    if (!input) {
        showNotification('Por favor, ingresa un enlace o nombre de usuario', 'error');
        return;
    }
    
    if (!isPremium && downloadsRemaining <= 0) {
        showNotification('Has alcanzado el limite de descargas gratuitas. Obten Premium por solo $0.25/mes!', 'warning');
        openModal('premium');
        return;
    }
    
    // Show processing message
    showNotification('Procesando... Redirigiendo al servicio de descarga', 'info');
    
    // Determine the URL to use
    let instagramUrl = input;
    
    // If it's just a username, construct the profile URL
    if (!input.includes('instagram.com') && !input.includes('http')) {
        // It's a username
        if (currentTab === 'perfil' || currentTab === 'historias' || currentTab === 'dp' || currentTab === 'destacados') {
            instagramUrl = 'https://www.instagram.com/' + input.replace('@', '');
        }
    }
    
    // Decrease remaining downloads for free users
    if (!isPremium) {
        downloadsRemaining--;
        updateDownloadsCounter();
    }
    
    // Redirect to FastDl.app with the URL
    setTimeout(() => {
        // Open FastDl in a new tab with the Instagram URL
        const fastdlUrl = 'https://fastdl.app/en2';
        
        // Copy the URL to clipboard for easy pasting
        navigator.clipboard.writeText(instagramUrl).then(() => {
            showNotification('Enlace copiado! Pegalo en FastDl para descargar', 'success');
        }).catch(() => {
            // Clipboard failed, just redirect
        });
        
        // Open FastDl in new tab
        window.open(fastdlUrl, '_blank');
        
        // Also show the result area with instructions
        showDownloadInstructions(instagramUrl);
    }, 500);
}

function showDownloadInstructions(url) {
    const resultsArea = document.getElementById('resultsArea');
    resultsArea.innerHTML = `
        <div class="download-instructions">
            <h3>Instrucciones de Descarga</h3>
            <p>Se ha abierto <strong>FastDl.app</strong> en una nueva pestana.</p>
            <ol>
                <li>Pega este enlace en FastDl: <code>${url}</code></li>
                <li>Haz clic en "Download"</li>
                <li>Descarga tu contenido!</li>
            </ol>
            <div class="copy-url-box">
                <input type="text" value="${url}" readonly id="copyUrlInput">
                <button onclick="copyUrl()" class="copy-btn">Copiar</button>
            </div>
            <p class="tip"><strong>Tip:</strong> El enlace ya fue copiado a tu portapapeles</p>
        </div>
    `;
    resultsArea.style.display = 'block';
}

function copyUrl() {
    const input = document.getElementById('copyUrlInput');
    input.select();
    document.execCommand('copy');
    navigator.clipboard.writeText(input.value);
    showNotification('Enlace copiado!', 'success');
}

function updateDownloadsCounter() {
    const counter = document.getElementById('downloadsCounter');
    if (counter) {
        counter.textContent = `Descargas restantes: ${downloadsRemaining}`;
    }
}

// Multiple download functionality (Premium only)
function handleMultipleDownload() {
    if (!isPremium) {
        showNotification('La descarga multiple es una funcion Premium. Solo $0.25/mes!', 'warning');
        openModal('premium');
        return;
    }
    
    const urls = document.getElementById('multipleUrls').value.trim().split('\n').filter(url => url.trim());
    
    if (urls.length === 0) {
        showNotification('Por favor, ingresa al menos un enlace', 'error');
        return;
    }
    
    showNotification(`Procesando ${urls.length} enlaces...`, 'info');
    
    // Copy all URLs to clipboard
    const allUrls = urls.join('\n');
    navigator.clipboard.writeText(allUrls).then(() => {
        showNotification('Enlaces copiados! Pegalos uno por uno en FastDl', 'success');
    });
    
    // Open FastDl
    window.open('https://fastdl.app/en2', '_blank');
    
    // Show instructions
    const resultsArea = document.getElementById('resultsArea');
    resultsArea.innerHTML = `
        <div class="download-instructions">
            <h3>Descarga Multiple Premium</h3>
            <p>Se ha abierto <strong>FastDl.app</strong>. Pega cada enlace para descargar:</p>
            <ul>
                ${urls.map((url, i) => `<li>${i + 1}. <code>${url}</code></li>`).join('')}
            </ul>
            <p class="tip">Los enlaces han sido copiados a tu portapapeles</p>
        </div>
    `;
    resultsArea.style.display = 'block';
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
                    <li>Descargas ilimitadas</li>
                    <li>Descarga multiple</li>
                    <li>Sin anuncios</li>
                    <li>Maxima calidad</li>
                    <li>Soporte prioritario</li>
                    <li>Descarga de historias</li>
                    <li>Descarga de destacados</li>
                </ul>
                <button class="premium-btn" onclick="subscribePremium()">Obtener Premium - $0.25/mes</button>
                <p class="guarantee">Garantia de 7 dias</p>
            </div>
        `;
    } else if (type === 'login') {
        modalContent.innerHTML = `
            <div class="login-modal">
                <h2>Iniciar Sesion</h2>
                <form onsubmit="handleLogin(event)">
                    <input type="email" placeholder="Email" required>
                    <input type="password" placeholder="Contrasena" required>
                    <button type="submit">Entrar</button>
                </form>
                <p>No tienes cuenta? <a href="#" onclick="openModal('register')">Registrate</a></p>
            </div>
        `;
    } else if (type === 'register') {
        modalContent.innerHTML = `
            <div class="register-modal">
                <h2>Crear Cuenta</h2>
                <form onsubmit="handleRegister(event)">
                    <input type="text" placeholder="Nombre" required>
                    <input type="email" placeholder="Email" required>
                    <input type="password" placeholder="Contrasena" required>
                    <button type="submit">Registrarse</button>
                </form>
                <p>Ya tienes cuenta? <a href="#" onclick="openModal('login')">Inicia sesion</a></p>
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
    showNotification('Redirigiendo al sistema de pago...', 'info');
    
    // Simulate payment process
    setTimeout(() => {
        // In a real app, this would redirect to a payment gateway
        const confirmed = confirm('Confirmar suscripcion Premium por $0.25/mes?\n\n(Esta es una demostracion)');
        
        if (confirmed) {
            isPremium = true;
            downloadsRemaining = Infinity;
            closeModal();
            showNotification('Bienvenido a Premium! Ahora tienes descargas ilimitadas', 'success');
            updatePremiumUI();
        }
    }, 500);
}

function updatePremiumUI() {
    // Update UI to show premium status
    const premiumBtns = document.querySelectorAll('.premium-cta');
    premiumBtns.forEach(btn => {
        btn.innerHTML = 'Premium Activo';
        btn.style.background = 'linear-gradient(135deg, #ffd700, #ffaa00)';
    });
    
    // Enable multiple download
    const multipleSection = document.querySelector('.multiple-download');
    if (multipleSection) {
        multipleSection.classList.add('premium-active');
    }
}

// Auth handlers (demo)
function handleLogin(e) {
    e.preventDefault();
    showNotification('Iniciando sesion...', 'info');
    setTimeout(() => {
        closeModal();
        showNotification('Bienvenido de vuelta!', 'success');
    }, 1000);
}

function handleRegister(e) {
    e.preventDefault();
    showNotification('Creando cuenta...', 'info');
    setTimeout(() => {
        closeModal();
        showNotification('Cuenta creada! Ya puedes iniciar sesion', 'success');
    }, 1000);
}

// Paste from clipboard
function pasteFromClipboard() {
    navigator.clipboard.readText().then(text => {
        document.getElementById('urlInput').value = text;
        showNotification('Enlace pegado!', 'success');
    }).catch(() => {
        showNotification('No se pudo acceder al portapapeles', 'error');
    });
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
    
    // Add notification container
    if (!document.getElementById('notificationContainer')) {
        const container = document.createElement('div');
        container.id = 'notificationContainer';
        document.body.appendChild(container);
    }
});
