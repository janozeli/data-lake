/**
 * data-lake Worker entry point.
 *
 *   /mcp            MCP endpoint (OAuth via GitHub, or the API token)
 *   /v1/...         REST API (same credentials), see http.ts
 *   /authorize,
 *   /callback       sign-in flow, see auth.ts
 *   /token,
 *   /register,
 *   /.well-known/*  OAuth protocol endpoints, served by the OAuth provider
 *
 * A daily cron purges items that have been in the trash for 30 days.
 */

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { allowedLogins, authHandler, type Props } from "./auth";
import { handleHttp } from "./http";
import { purge } from "./lake";
import { createMcpEndpoint } from "./mcp";

/** Props given to requests authenticated with LAKE_API_TOKEN instead of OAuth. */
const API_TOKEN_PROPS: Props = { login: "api-token" };

function timingSafeEqual(a: string, b: string): boolean {
	const encoder = new TextEncoder();
	const left = encoder.encode(a);
	const right = encoder.encode(b);
	if (left.byteLength !== right.byteLength) return false;
	return crypto.subtle.timingSafeEqual(left, right);
}

const apiHandler = {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const props = (ctx as ExecutionContext<Props>).props;
		const authorized =
			props?.login === API_TOKEN_PROPS.login || allowedLogins(env).has(props?.login?.toLowerCase() ?? "");
		if (!authorized) return Response.json({ error: "forbidden" }, { status: 403 });

		const { pathname } = new URL(request.url);
		if (pathname === "/mcp" || pathname.startsWith("/mcp/")) return createMcpEndpoint(env.LAKE).fetch(request);
		return handleHttp(request, env.LAKE);
	},
};

// The protected resource is the origin clients connect to (it covers both /mcp
// and /v1), so one provider is built per origin: workers.dev, a custom
// domain, or localhost.
const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(origin: string): OAuthProvider<Env> {
	let provider = providers.get(origin);
	if (!provider) {
		const resource = origin;
		provider = new OAuthProvider<Env>({
			apiRoute: ["/mcp", "/v1/"],
			apiHandler,
			defaultHandler: authHandler,
			authorizeEndpoint: "/authorize",
			tokenEndpoint: "/token",
			clientRegistrationEndpoint: "/register",
			resourceMetadata: { resource, resource_name: "data-lake" },
			async resolveExternalToken({ token, env }) {
				if (!env.LAKE_API_TOKEN || !timingSafeEqual(token, env.LAKE_API_TOKEN)) return null;
				return { props: API_TOKEN_PROPS, audience: resource };
			},
		});
		providers.set(origin, provider);
	}
	return provider;
}

export default {
	fetch(request, env, ctx) {
		return providerFor(new URL(request.url).origin).fetch(request, env, ctx);
	},
	async scheduled(_controller, env, ctx) {
		ctx.waitUntil(purge(env.LAKE).then((count) => console.log(`purged ${count} item(s) from the trash`)));
	},
} satisfies ExportedHandler<Env>;
