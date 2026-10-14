import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build, context } from 'esbuild';

// 型定義は TypeScript 7 (ネイティブ版) の tsc で出力する。子プロセスが失敗したらビルドを止める。
// typescript の exports は bin/tsc を公開していないので、package.json の場所から辿る。
const tsc = fileURLToPath(new URL('bin/tsc', import.meta.resolve('typescript/package.json')));

async function spawnChecked(command) {
	const subprocess = Bun.spawn(command, { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });
	const exitCode = await subprocess.exited;
	if (exitCode !== 0) {
		throw new Error(`${command.join(' ')} exited with code ${exitCode}`);
	}
}

const watch = process.argv.includes('--watch');
const options = {
	entryPoints: ['./src/index.ts'],
	bundle: true,
	external: ['@misskey-dev/emoji-data'],
	format: 'esm',
	outfile: './built/index.js',
	platform: 'neutral',
	sourcemap: true,
	target: 'es2022',
};

async function buildTypes() {
	await spawnChecked([
		process.execPath,
		tsc,
		'--project',
		'tsconfig.json',
		'--outDir',
		'built',
		'--declaration',
		'true',
		'--emitDeclarationOnly',
		'true',
	]);
	await spawnChecked([process.execPath, 'run', '--bun', 'api-extractor', 'run', '--local']);
}

if (!watch) {
	await rm('./built', { recursive: true, force: true });
	await build(options);
	await buildTypes();
} else {
	const buildContext = await context({
		...options,
		plugins: [
			{
				name: 'generate-types',
				setup(build) {
					build.onEnd(async (result) => {
						if (result.errors.length === 0) {
							await buildTypes();
						}
					});
				},
			},
		],
	});

	await buildContext.watch();
}
