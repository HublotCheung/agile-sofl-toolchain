import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
const server = await createServer({ configFile: false, root: process.cwd(), plugins: [vue()], server: { host: '127.0.0.1', port: 41739, strictPort: true } })
await server.listen(); server.printUrls()
