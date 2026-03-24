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
        'foto': 'Inserta enlace de la publicación',
        'video': 'Inserta enlace del vídeo',
        'historias': 'Inserta nombre de usuario',
        'reels': 'Inserta enlace del reel',
        'dp': 'Inserta nombre de usuario',
        'destacados': 'Inserta nombre de usuario'
    };
    input.placeholder = placeholders[currentTab] || 'Inserta enlace o nombre de usuario';
}

// Download functionality
function handleDownload() {
    const input = document.getElementById('urlInput').value.trim();
    
    if (!input) {
        showNotification('Por favor, ingresa un enlace o nombre de usuario', 'error');
        return;
    }
    
    if (!isPremium && downloadsRemaining <= 0) {
        showNotification('Has alcanzado el límite de descargas gratuitas. ¡Obtén Premium por solo $0.25/mes!', 'warning');
        openModal('premium');
        return;
    }
    
    // Simulate download process
    showNotification('Procesando descarga...', 'info');
    
    setTimeout(() => {
        if (!isPremium) {
            downloadsRemaining--;
            updateDownloadCount();
        }
        
        // Show results
        showResults(input);
    }, 1500);
}

function updateDownloadCount() {
    const countElement = document.getElementById('downloadCount');
    countElement.textContent = `${downloadsRemaining}/2`;
    
    if (downloadsRemaining === 0) {
        countElement.style.color = '#ff4757';
    }
}

function showResults(query) {
    const resultsContent = document.getElementById('resultsContent');
    
    // Simulate results based on tab type
    const results = generateMockResults(query);
    
    resultsContent.innerHTML = results.map(result => `
        <div class="result-item">
            <img src="${result.thumbnail}" alt="${result.title}">
            <div class="result-info">
                <h4>${result.title}</h4>
                <p>${result.type} • ${result.size}</p>
            </div>
            <button class="btn btn-primary" onclick="downloadFile('${result.url}')">
                <i class="fas fa-download"></i>
            </button>
        </div>
    `).join('');
    
    openModal('results');
}

function generateMockResults(query) {
    const types = {
        'perfil': 'Publicación',
        'foto': 'Imagen',
        'video': 'Vídeo',
        'historias': 'Historia',
        'reels': 'Reel',
        'dp': 'Foto de perfil',
        'destacados': 'Destacado'
    };
    
    const count = currentTab === 'perfil' ? 3 : 1;
    const results = [];
    
    for (let i = 0; i < count; i++) {
        results.push({
            thumbnail: `https://picsum.photos/200/200?random=${Math.random()}`,
            title: `${types[currentTab]} ${i + 1} - @${query}`,
            type: types[currentTab],
            size: currentTab === 'video' || currentTab === 'reels' ? '15.2 MB' : '2.4 MB',
            url: '#'
        });
    }
    
    return results;
}

function downloadFile(url) {
    showNotification('¡Descarga iniciada!', 'success');
    // In a real implementation, this would trigger the actual download
}

// Modal functionality
function openModal(type) {
    const modal = document.getElementById(`${type}Modal`);
    if (modal) {
        modal.classList.add('active');
        document.body.style.overflow = 'hidden';
    }
}

function closeModal(type) {
    const modal = document.getElementById(`${type}Modal`);
    if (modal) {
        modal.classList.remove('active');
        document.body.style.overflow = '';
    }
}

function switchModal(from, to) {
    closeModal(from);
    setTimeout(() => openModal(to), 200);
}

// Close modal on outside click
document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.classList.remove('active');
            document.body.style.overflow = '';
        }
    });
});

// FAQ functionality
document.querySelectorAll('.faq-question').forEach(question => {
    question.addEventListener('click', () => {
        const item = question.parentElement;
        const isActive = item.classList.contains('active');
        
        // Close all other items
        document.querySelectorAll('.faq-item').forEach(i => i.classList.remove('active'));
        
        // Toggle current item
        if (!isActive) {
            item.classList.add('active');
        }
    });
});

// Notification system
function showNotification(message, type = 'info') {
    // Remove existing notifications
    const existing = document.querySelector('.notification');
    if (existing) existing.remove();
    
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.innerHTML = `
        <i class="fas ${getNotificationIcon(type)}"></i>
        <span>${message}</span>
    `;
    
    // Add styles
    notification.style.cssText = `
        position: fixed;
        top: 100px;
        right: 20px;
        padding: 15px 25px;
        background: ${getNotificationColor(type)};
        color: white;
        border-radius: 10px;
        display: flex;
        align-items: center;
        gap: 10px;
        z-index: 2000;
        animation: slideIn 0.3s ease;
        box-shadow: 0 10px 30px rgba(0,0,0,0.3);
    `;
    
    document.body.appendChild(notification);
    
    // Auto remove
    setTimeout(() => {
        notification.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

function getNotificationIcon(type) {
    const icons = {
        'success': 'fa-check-circle',
        'error': 'fa-times-circle',
        'warning': 'fa-exclamation-circle',
        'info': 'fa-info-circle'
    };
    return icons[type] || icons.info;
}

function getNotificationColor(type) {
    const colors = {
        'success': '#38ef7d',
        'error': '#ff4757',
        'warning': '#f5af19',
        'info': '#667eea'
    };
    return colors[type] || colors.info;
}

// Add notification animations
const style = document.createElement('style');
style.textContent = `
    @keyframes slideIn {
        from {
            opacity: 0;
            transform: translateX(100px);
        }
        to {
            opacity: 1;
            transform: translateX(0);
        }
    }
    @keyframes slideOut {
        from {
            opacity: 1;
            transform: translateX(0);
        }
        to {
            opacity: 0;
            transform: translateX(100px);
        }
    }
`;
document.head.appendChild(style);

// Form submissions
document.querySelectorAll('.auth-form').forEach(form => {
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        showNotification('¡Cuenta creada exitosamente!', 'success');
        closeModal('register');
        closeModal('login');
        
        // Simulate logged in state
        downloadsRemaining = 10;
        updateDownloadCount();
    });
});

document.querySelector('.payment-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    showNotification('¡Pago procesado! Ahora eres Premium', 'success');
    closeModal('premium');
    
    // Enable premium features
    isPremium = true;
    document.getElementById('multipleUrls').disabled = false;
    document.querySelector('.multiple-download .btn-premium').innerHTML = `
        <i class="fas fa-check"></i>
        <span>Descarga Múltiple Activada</span>
    `;
    document.querySelector('.multiple-download .btn-premium').classList.remove('btn-premium');
    document.querySelector('.multiple-download .btn-gold')?.classList.add('btn-primary');
    
    // Update download limit display
    document.querySelector('.download-limit').innerHTML = `
        <span><i class="fas fa-crown" style="color: #f5af19;"></i> <strong>Premium</strong> - Descargas ilimitadas</span>
    `;
});

// Enter key to download
document.getElementById('urlInput')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        handleDownload();
    }
});

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    updatePlaceholder();
    updateDownloadCount();
});
