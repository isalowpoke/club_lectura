// src/main.js - Navegación mobile responsive y scroll suave
function actualizarLinkActivo() {
  const pathname = window.location.pathname;
  const navLinks = document.querySelectorAll('.nav-link, .mobile-nav-link');
  
  navLinks.forEach(link => {
    link.classList.remove('active');
    
    const href = link.getAttribute('href');
    if (href && (pathname === href || pathname === href + '.html')) {
      link.classList.add('active');
    }
  });
}

function configurarMenuResponsive() {
  const mobileBtn = document.getElementById('mobile-menu-btn');
  const mobileMenu = document.getElementById('mobile-menu');
  
  if (mobileBtn && mobileMenu) {
    mobileBtn.addEventListener('click', () => {
      mobileMenu.classList.toggle('hidden');
    });
    
    mobileMenu.addEventListener('click', (e) => {
      if (e.target.classList.contains('mobile-nav-link')) {
        mobileMenu.classList.add('hidden');
      }
    });
  }
}

function configurarScrollSuave() {
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
      e.preventDefault();
      const target = document.querySelector(this.getAttribute('href'));
      if (target) {
        target.scrollIntoView({
          behavior: 'smooth',
          block: 'start'
        });
      }
    });
  });
}

function inicializarUI() {
  actualizarLinkActivo();
  configurarMenuResponsive();
  configurarScrollSuave();
}

function configurarEventosAuth() {
  const btnLogin = document.getElementById('btn-login');
  const btnLoginMobile = document.getElementById('btn-login-mobile');
  
  if (btnLogin) {
    btnLogin.addEventListener('click', (e) => {
      window.location.href = 'login.html';
    });
  }
  
  if (btnLoginMobile) {
    btnLoginMobile.addEventListener('click', (e) => {
      window.location.href = 'login.html';
    });
  }
}

function inicializarMain() {
  document.addEventListener('DOMContentLoaded', () => {
    inicializarUI();
    configurarEventosAuth();
  });
}

window.Main = {
  inicializarMain
};