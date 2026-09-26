import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'

// Phones only allow camera access on https (or localhost). `npm run dev:https`
// serves a self-signed cert so the finish phone can be tested over Wi-Fi.
const https = process.env.HTTPS === '1'

export default defineConfig({
  plugins: [react(), ...(https ? [basicSsl()] : [])],
})
