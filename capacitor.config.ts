import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'dev.jarvis.app',
  appName: 'JARVIS',
  webDir: 'dist',
  server: { hostname: 'jarvis.app', androidScheme: 'https' },
  android: { backgroundColor: '#01060c' },
}

export default config
