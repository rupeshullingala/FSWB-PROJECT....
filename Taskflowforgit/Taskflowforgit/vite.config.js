import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // The Express-style server in /server serves the built app from "/".
  // Set VITE_BASE=/task-management/ only if you still deploy a static copy to GitHub Pages.
  base: process.env.VITE_BASE || '/',
  server: {
    proxy: { '/api': 'http://localhost:4000' },
  },
})
