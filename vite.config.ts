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
      filename: 'esmRemoteEntry.js',
      varFilename: 'remoteEntry.js',
      dts: false,
      exposes: {
        './AppPanel': './src/AppPanel.tsx'
      },
      shared: sharedDependencies as never
    })
  ],
  build: {
    outDir: 'public',
    emptyOutDir: true,
    target: 'esnext',
    minify: false
  }
});
