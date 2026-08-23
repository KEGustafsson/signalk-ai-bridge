import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { federation } from '@module-federation/vite';

interface PackageJson {
  name: string;
}

const packageJson = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8')
) as PackageJson;
const safePackageName = packageJson.name.replace(/[-@/]/g, '_');
const sharedDependencies = {
  react: {
    singleton: true,
    requiredVersion: false
  },
  'react-dom': {
    singleton: true,
    requiredVersion: false
  }
} as const;

export default defineConfig({
  base: './',
  publicDir: false,
  plugins: [
    federation({
      name: safePackageName,
      // package.json declares "type": "module", so signalk-server emits
      // <script type="module" src="/signalk-ai-bridge/remoteEntry.js">. That
      // URL must therefore serve the ESM container, not the `var` IIFE: a
      // module-scope `var` creates no global for the admin UI to find, and
      // `document.currentScript` is null in a module script. Naming the ESM
      // output esmRemoteEntry.js left remoteEntry.js as the IIFE and the panel
      // failed to mount with "Module ... is not available".
      filename: 'remoteEntry.js',
      dts: false,
      exposes: {
        './AppPanel': './src/AppPanel.tsx'
      },
      shared: sharedDependencies as never
    })
  ],
  server: {
    // Lets `npm run dev` render the panel against a real backend: either a
    // Signal K server running the plugin, or scripts/preview-host.mjs.
    proxy: {
      '/plugins/signalk-ai-bridge': {
        target: process.env.SIGNALK_AI_BRIDGE_DEV_TARGET ?? 'http://localhost:3000',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'public',
    emptyOutDir: true,
    target: 'esnext',
    minify: false
  }
});
