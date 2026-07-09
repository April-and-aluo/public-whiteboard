// 打包 Yjs + y-websocket + y-webrtc 为浏览器可用的单文件
import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/lib.js'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile: 'src/yjs-bundle.js',
  minify: false,
  sourcemap: false,
  define: {
    'process.env.NODE_ENV': '"production"',
    'global': 'globalThis',
  },
});

console.log('Bundle created: src/yjs-bundle.js');
