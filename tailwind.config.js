/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./frontend/**/*.{html,js}",
    "./frontend/*.html"
  ],
  theme: {
    extend: {
      colors: {
        primary: '#2563EB',
        secondary: '#7C3AED',
        accent: '#F59E0B',
        bg: '#F8FAFC',
        text: '#1E293B',
        surface: '#FFFFFF',
        error: '#EF4444',
        success: '#10B981',
      },
      fontFamily: {
        sans: ['Inter', 'Poppins', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
