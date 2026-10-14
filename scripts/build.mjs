import { build } from 'esbuild';

await build({ entryPoints: ['src/browser.ts'], outfile: 'dist/bicho.min.js', bundle: true, format: 'iife', globalName: 'Bicho', platform: 'browser', target: ['es2020'], minify: true, legalComments: 'none' });
