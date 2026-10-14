import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// test/reference/ は比較用の参照実装でテストではない
		include: ['test/*.ts'],
	},
});
