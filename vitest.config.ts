import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: { setupFiles: ["./test/setup.ts"] },
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: {
					LAKE_API_TOKEN: "test-api-token",
					OAUTH_CLIENT_ID: "test-client-id",
					OAUTH_CLIENT_SECRET: "test-client-secret",
				},
			},
		}),
	],
});
