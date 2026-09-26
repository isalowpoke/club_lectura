const Header = `
<header class="bg-white shadow-sm sticky top-0 z-50">
  <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
    <div class="flex justify-between items-center h-16">
      <div class="flex items-center">
        <a href="index.html" class="flex items-center space-x-2">
          <span class="text-2xl">📚</span>
          <span class="text-xl font-bold text-primary">Club de Lectura</span>
        </a>
      </div>
      
      <nav class="hidden md:flex items-center space-x-8">
        <a href="index.html" class="text-text hover:text-primary font-medium transition-colors">Inicio</a>
        <a href="precios.html" class="text-text hover:text-primary font-medium transition-colors">Precios</a>
        <a href="proximas-sesiones.html" class="text-text hover:text-primary font-medium transition-colors">Próximas Sesiones</a>
        <a href="sobre-nosotros.html" class="text-text hover:text-primary font-medium transition-colors">Sobre Nosotros</a>
        <a href="contacto.html" class="text-text hover:text-primary font-medium transition-colors">Contacto</a>
      </nav>

      <div id="auth-desktop" class="hidden md:flex items-center space-x-4">
        <button id="btn-login" class="text-text hover:text-primary font-medium transition-colors">Iniciar Sesion</button>
        <a href="login.html" class="btn-primary text-sm py-2 px-4">Unete</a>
      </div>

      <button id="mobile-menu-btn" class="md:hidden p-2 rounded-lg hover:bg-gray-100 transition-colors" aria-label="Abrir menú">
        <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/>
        </svg>
      </button>
    </div>
  </div>

  <div id="mobile-menu" class="hidden md:hidden bg-white border-t">
    <div class="px-4 py-3 space-y-3">
      <a href="index.html" class="block text-text hover:text-primary font-medium">Inicio</a>
      <a href="precios.html" class="block text-text hover:text-primary font-medium">Precios</a>
      <a href="proximas-sesiones.html" class="block text-text hover:text-primary font-medium">Próximas Sesiones</a>
      <a href="sobre-nosotros.html" class="block text-text hover:text-primary font-medium">Sobre Nosotros</a>
      <a href="contacto.html" class="block text-text hover:text-primary font-medium">Contacto</a>
      <hr class="my-2">
      <div id="auth-mobile">
        <button id="btn-login-mobile" class="block w-full text-left text-text hover:text-primary font-medium">Iniciar Sesion</button>
        <a href="login.html" class="block btn-primary text-center text-sm py-2">Unete</a>
      </div>
    </div>
  </div>
</header>
`;

const Footer = `
<footer class="bg-text text-white mt-16">
  <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
    <div class="grid grid-cols-1 md:grid-cols-3 gap-8">
      <div>
        <div class="flex items-center space-x-2 mb-4">
          <span class="text-2xl">📚</span>
          <span class="text-xl font-bold">Club de Lectura</span>
        </div>
        <p class="text-gray-400">Una comunidad para lovers de la lectura. Únete y comparte tu pasión por los libros.</p>
      </div>
      
      <div>
        <h3 class="font-semibold text-lg mb-4">Enlaces</h3>
        <ul class="space-y-2 text-gray-400">
          <li><a href="index.html" class="hover:text-white transition-colors">Inicio</a></li>
          <li><a href="sobre-nosotros.html" class="hover:text-white transition-colors">Sobre Nosotros</a></li>
          <li><a href="contacto.html" class="hover:text-white transition-colors">Contacto</a></li>
        </ul>
      </div>
      
      <div>
        <h3 class="font-semibold text-lg mb-4">Soporte</h3>
        <ul class="space-y-2 text-gray-400">
          <li><a href="#" class="hover:text-white transition-colors">Preguntas Frecuentes</a></li>
          <li><a href="#" class="hover:text-white transition-colors">Términos y Condiciones</a></li>
          <li><a href="#" class="hover:text-white transition-colors">Política de Privacidad</a></li>
        </ul>
      </div>
    </div>
    
    <div class="border-t border-gray-700 mt-8 pt-8 text-center text-gray-400">
      <p>&copy; 2026 Club de Lectura. Todos los derechos reservados.</p>
    </div>
  </div>
</footer>
`;

function initMobileMenu() {
  const btn = document.getElementById('mobile-menu-btn');
  const menu = document.getElementById('mobile-menu');
  
  if (btn && menu) {
    btn.addEventListener('click', () => {
      menu.classList.toggle('hidden');
    });
  }
}

function actualizarHeaderAuth() {
  const usuario = Auth?.obtenerUsuario();
  const authDesktop = document.getElementById('auth-desktop');
  const authMobile = document.getElementById('auth-mobile');
  
  if (!authDesktop) return;
  
  if (usuario) {
    const nombre = Auth.sanitizarHTML(usuario.user_metadata?.full_name || usuario.email?.split('@')[0] || 'Mi cuenta');
    const avatar = usuario.user_metadata?.avatar_url;
    
    authDesktop.innerHTML = `
      <div class="flex items-center space-x-3">
        <div class="flex items-center space-x-2">
          ${avatar ? `<a href="dashboard.html"><img src="${avatar}" alt="" class="w-8 h-8 rounded-full"></a>` : `<div class="w-8 h-8 rounded-full bg-primary text-white flex items-center justify-center text-sm font-bold">${nombre.charAt(0).toUpperCase()}</div>`}
          <span class="text-sm font-medium text-text">${nombre}</span>
        </div>
        <button id="btn-logout" class="text-sm text-gray-500 hover:text-error font-medium transition-colors">Salir</button>
      </div>
    `;
    
    if (authMobile) {
      authMobile.innerHTML = `
        <div class="flex items-center space-x-2 mb-2">
          ${avatar ? `<a href="dashboard.html"><img src="${avatar}" alt="" class="w-8 h-8 rounded-full"></a>` : `<div class="w-8 h-8 rounded-full bg-primary text-white flex items-center justify-center text-sm font-bold">${nombre.charAt(0).toUpperCase()}</div>`}
          <span class="text-sm font-medium text-text">${nombre}</span>
        </div>
        <button id="btn-logout-mobile" class="block w-full text-left text-red-500 hover:text-red-700 font-medium">Cerrar Sesion</button>
      `;
    }
    
    document.getElementById('btn-logout')?.addEventListener('click', (e) => {
      e.preventDefault();
      Auth.cerrarSesion();
    });
    document.getElementById('btn-logout-mobile')?.addEventListener('click', (e) => {
      e.preventDefault();
      Auth.cerrarSesion();
    });
  } else {
    authDesktop.innerHTML = `
      <button id="btn-login" class="text-text hover:text-primary font-medium transition-colors">Iniciar Sesion</button>
      <a href="login.html" class="btn-primary text-sm py-2 px-4">Unete</a>
    `;
    
    if (authMobile) {
      authMobile.innerHTML = `
        <button id="btn-login-mobile" class="block w-full text-left text-text hover:text-primary font-medium">Iniciar Sesion</button>
        <a href="login.html" class="block btn-primary text-center text-sm py-2">Unete</a>
      `;
    }
    
    document.getElementById('btn-login')?.addEventListener('click', (e) => {
      e.preventDefault();
      Auth.iniciarSesionGoogle();
    });
    document.getElementById('btn-login-mobile')?.addEventListener('click', (e) => {
      e.preventDefault();
      Auth.iniciarSesionGoogle();
    });
  }
}

function renderComponents() {
  const headerEl = document.getElementById('header');
  const footerEl = document.getElementById('footer');
  
  if (headerEl) headerEl.innerHTML = Header;
  if (footerEl) footerEl.innerHTML = Footer;
  
  initMobileMenu();
}

document.addEventListener('DOMContentLoaded', renderComponents);
