=============================================================
AGENTS.md - Club de Lectura Pago
=============================================================

Reglas y convenciones obligatorias. Consultar PLAN_PROYECTO.txt
para contexto completo del proyecto.

=============================================================
1. STACK
=============================================================

Frontend: HTML5 + CSS3 (Tailwind CDN) + JS vanilla + Supabase SDK + Mercado Pago SDK
Backend:  Node.js v18+ + Express.js + Supabase SDK + Mercado Pago SDK + dotenv
DB:       PostgreSQL via Supabase
Hosting:  Frontend=Netlify | Backend=Railway/Render | DB=Supabase Cloud

=============================================================
2. ESTRUCTURA
=============================================================

  frontend/   -> HTML, CSS, JS del navegador (NUNCA backend)
  backend/    -> API Node.js/Express (NUNCA archivos del frontend)

  frontend/ (HTML, CSS, JS, img/)
  backend/  (server.js, routes/, middleware/, services/, .env NO en git)

=============================================================
3. CONVENCIONES DE CODIGO
=============================================================

HTML: semantico (header/main/section/footer), alt en imagenes, lang="es", viewport obligatorio
CSS:  Tailwind primero, custom despues, kebab-case, mobile-first, variables CSS en :root
JS:   const/let (NUNCA var), camelCase, UPPER_SNAKE_CASE para constantes,
      async/await, try/catch siempre, sin console.log en produccion
Backend: archivos kebab-case.js, rutas en plural (/api/sesiones),
         respuestas JSON { success: true/false }, HTTP status codes correctos
DB:   tablas plural, columnas snake_case, UUID ids, timestamps created_at/updated_at

=============================================================
4. PROHIBICIONES - SEGURIDAD
=============================================================

- NUNCA subir .env a Git
- NUNCA hardcodear API keys, tokens o passwords
- NUNCA guardar datos de tarjeta de credito
- NUNCA exponer SUPABASE_SERVICE_KEY al frontend
- NUNCA usar HTTP en produccion
- NUNCA console.log datos sensibles
- NUNCA confiar en datos del cliente sin validar

=============================================================
5. PROHIBICIONES - CODIGO Y ARQUITECTURA
=============================================================

- NUNCA usar var, frameworks JS (React/Vue), jQuery, CSS inline style=""
- NUNCA meter logica de negocio en frontend
- NUNCA consultar BD directamente desde frontend
- NUNCA crear endpoints privados sin middleware de autenticacion
- NUNCA usar GET para modificar datos (usar POST/PUT/DELETE)
- NUNCA ignorar responsive (mobile-first)
- NUNCA duplicar codigo

=============================================================
6. PATRONES DE ARQUITECTURA
=============================================================

Backend MVC ligero:
  Routes (controladores) | Services (logica externa) | Middleware (verificacion)

Auth:
  Google OAuth -> Supabase Auth -> JWT -> Frontend guarda en localStorage
  -> Backend verifica JWT en cada ruta protegida via middleware

Pagos:
  Frontend redirige a MP checkout -> MP procesa -> MP envia webhook
  -> Backend valida webhook -> actualiza BD en Supabase
  NUNCA procesar pagos en frontend | NUNCA guardar datos de tarjeta

Proteccion de rutas:
  router.get('/', verificar, async (req, res) => { ... })

Comunicacion Frontend-Backend:
  fetch('/api/...', { headers: { Authorization: `Bearer ${token}` } })

=============================================================
7. SEGURIDAD ESPECIFICA
=============================================================

Frontend: solo SUPABASE_ANON_KEY, sanitizar inputs, RLS habilitado
Backend:  verificar JWT, validar datos, helmet.js, CORS solo dominio frontend, rate limiting
MP:       verificar firma webhook, usar SDK oficial, manejar duplicados, nunca confiar solo en el usuario
Supabase: RLS en TODAS las tablas (usuarios=read own, sesiones=read all auth, suscripciones=read own)

=============================================================
8. GIT Y COMMITS
=============================================================

Ramas: main (produccion) | develop (integracion) | feature/* | fix/* | hotfix/*
Workflow: branch desde develop -> cambios -> commit -> PR a develop -> merge -> periodicamente a main

Formato commit: <tipo>(<scope>): <descripcion corta>
  feat | fix | style | refactor | docs | test | chore | remove
  Max 50 chars, un commit = un cambio logico, sin WIP en develop

PRs: siempre hacia develop, PRs pequenos (~300 lineas max), descripcion clara,
     checklist: funciona local, sin errores, responsive, sin .env en commit

=============================================================
9. VARIABLES DE ENTORNO (.env en backend/)
=============================================================

  SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY
  MERCADOPAGO_ACCESS_TOKEN, MERCADOPAGO_PUBLIC_KEY
  PORT=3000, FRONTEND_URL

=============================================================
10. ORDEN DE DESARROLLO
=============================================================

1. Estructura proyecto -> 2. Frontend estatico -> 3. JS frontend
-> 4. Backend basico -> 5. Integracion pagos -> 6. Deploy
NO pagos antes de auth | NO deploy antes de probar localmente

=============================================================
11. PALETA DE COLORES
=============================================================

Primary=#2563EB | Secondary=#7C3AED | Accent=#F59E0B
Bg=#F8FAFC | Text=#1E293B | Surface=#FFFFFF
Error=#EF4444 | Success=#10B981
Fuentes: Inter/Poppins | Base: 16px | Breakpoints Tailwind (sm/md/lg/xl)

=============================================================
12. DEPENDENCIAS BACKEND
=============================================================

express, cors, dotenv, @supabase/supabase-js, mercadopago, helmet, express-rate-limit
Dev: nodemon

=============================================================
13. COMANDOS
=============================================================

  cd backend && npm run dev     # Backend en desarrollo
  cd frontend && npx serve .    # Frontend local
  git push origin main          # Deploy automatico

Docs: supabase.com/docs | mercadopago.com.ar/developers | expressjs.com | tailwindcss.com
