import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build, context } from 'esbuild';
import { spawnChecked } from '../../scripts/spawn-checked.mjs';

const tscNative = fileURLToPath(new URL('../../scripts/tsc-native.mjs', import.meta.url));

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
		'run',
		'--bun',
		tscNative,
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
						if (result.errors.length === 0) await buildTypes();
					});
				},
			},
		],
	});

	await buildContext.watch();
}
