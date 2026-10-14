import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: ['./src/index.ts'],
	format: 'esm',
	platform: 'neutral',
	target: 'es2022',
	outDir: 'built',
	// package.json の exports が指す built/index.js と built/index.d.ts の名前で出す
	fixedExtension: false,
	sourcemap: true,
	// 型定義も 1 ファイルにまとめる。git の依存として入れると src/ も届くので、型定義の source map で元のソースへ移動できる
	dts: { sourcemap: true },
});
