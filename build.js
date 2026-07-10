import { rm } from 'node:fs/promises';
import { build, context } from 'esbuild';
import { execa } from 'execa';

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
	await execa(
		'bun',
		[
			'run',
			'--bun',
			'tsgo',
			'--project',
			'tsconfig.json',
			'--outDir',
			'built',
			'--declaration',
			'true',
			'--emitDeclarationOnly',
			'true',
		],
		{
			stdout: process.stdout,
			stderr: process.stderr,
		},
	);
	await execa('bun', ['run', '--bun', 'api-extractor', 'run', '--local'], {
		stdout: process.stdout,
		stderr: process.stderr,
	});
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
