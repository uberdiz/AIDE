import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['extensions/aide-core/test/unit/**/*.test.ts'],
		environment: 'node',
		testTimeout: 60000,
	},
});
