/**
 * Sign-in for MCP clients: a consent page, then GitHub login.
 *
 *   GET  /authorize   show which client is asking and where tokens will go
 *   POST /authorize   approve or deny; on approve, redirect to GitHub
 *   GET  /callback    GitHub returns here; only allowed logins get a token
 *
 * The OAuth protocol endpoints (/token, /register, metadata) are served by
 * @cloudflare/workers-oauth-provider, which also injects OAUTH_PROVIDER.
 */

import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";

type AuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

export interface Props {
	login: string;
}

const GITHUB_AUTHORIZE = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN = "https://github.com/login/oauth/access_token";
const GITHUB_USER = "https://api.github.com/user";

export function allowedLogins(env: Env): Set<string> {
	return new Set(
		env.ALLOWED_GITHUB_LOGINS.split(",")
			.map((login) => login.trim().toLowerCase())
			.filter(Boolean),
	);
}

function escape(value: string): string {
	return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(title: string, body: string, headers: Headers = new Headers(), status = 200): Response {
	headers.set("Content-Type", "text/html; charset=utf-8");
	headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'");
	return new Response(
		`<!doctype html><html lang="en"><head><meta charset="utf-8">` +
			`<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title>` +
			`<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222}` +
			`code{background:#f3f3f3;padding:0 .25rem;border-radius:3px}.warn{color:#9a3412}` +
			`button{font:inherit;padding:.5rem 1rem;margin-right:.5rem;cursor:pointer}</style></head>` +
			`<body>${body}</body></html>`,
		{ status, headers },
	);
}

async function showConsent(request: Request, env: AuthEnv): Promise<Response> {
	const authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
	const consent = await env.OAUTH_PROVIDER.describeConsent(authRequest);
	const { handle, headers } = await env.OAUTH_PROVIDER.beginConsent(authRequest);
	const client = consent.clientDomain ? `${consent.clientName} (${consent.clientDomain})` : consent.clientName;
	return page(
		"Connect to data-lake",
		`<h1>Connect to data-lake</h1>` +
			`<p><strong>${escape(client)}</strong> wants to read and write your lake.</p>` +
			`<p>Access will be sent to <code>${escape(consent.redirectHost)}</code>.</p>` +
			(consent.redirectIsLoopback
				? `<p class="warn">That address is on this computer: any local program could receive the access.</p>`
				: "") +
			`<p>You will sign in with GitHub next.</p>` +
			`<form method="post" action="/authorize">` +
			`<input type="hidden" name="handle" value="${escape(handle)}">` +
			`<button name="decision" value="approve">Approve</button>` +
			`<button name="decision" value="deny">Deny</button></form>`,
		headers,
	);
}

async function submitConsent(request: Request, env: AuthEnv): Promise<Response> {
	const form = await request.formData();
	const handle = String(form.get("handle") ?? "");

	if (form.get("decision") !== "approve") {
		const { headers } = await env.OAUTH_PROVIDER.denyConsent(request, handle);
		return new Response(null, { status: 302, headers });
	}

	const approved = await env.OAUTH_PROVIDER.approveConsent(request, handle);
	const { state, headers } = await env.OAUTH_PROVIDER.beginUpstream(approved.request, { headers: approved.headers });
	const github = new URL(GITHUB_AUTHORIZE);
	github.searchParams.set("client_id", env.OAUTH_CLIENT_ID);
	github.searchParams.set("redirect_uri", new URL("/callback", request.url).href);
	github.searchParams.set("scope", "read:user");
	github.searchParams.set("state", state);
	headers.set("Location", github.href);
	return new Response(null, { status: 302, headers });
}

async function githubLogin(code: string, redirectUri: string, env: Env): Promise<string | null> {
	const tokenResponse = await fetch(GITHUB_TOKEN, {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: env.OAUTH_CLIENT_ID,
			client_secret: env.OAUTH_CLIENT_SECRET,
			code,
			redirect_uri: redirectUri,
		}),
	});
	if (!tokenResponse.ok) return null;
	const { access_token: accessToken } = (await tokenResponse.json()) as { access_token?: string };
	if (!accessToken) return null;

	const userResponse = await fetch(GITHUB_USER, {
		headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/vnd.github+json", "User-Agent": "data-lake" },
	});
	if (!userResponse.ok) return null;
	const { login } = (await userResponse.json()) as { login?: string };
	return login ?? null;
}

async function callback(request: Request, env: AuthEnv): Promise<Response> {
	const url = new URL(request.url);
	const resumed = await env.OAUTH_PROVIDER.finishUpstream(request);
	const authRequest: AuthRequest = resumed.request;

	const code = url.searchParams.get("code");
	const login = code ? await githubLogin(code, new URL("/callback", request.url).href, env) : null;
	if (!login) return page("Sign-in failed", "<h1>Sign-in failed</h1><p>GitHub did not confirm who you are.</p>", resumed.headers, 400);
	if (!allowedLogins(env).has(login.toLowerCase())) {
		return page("Not allowed", `<h1>Not allowed</h1><p><code>${escape(login)}</code> cannot use this lake.</p>`, resumed.headers, 403);
	}

	const props: Props = { login };
	const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
		request: authRequest,
		userId: login,
		metadata: { label: login },
		scope: authRequest.scope,
		props,
	});
	resumed.headers.set("Location", redirectTo);
	return new Response(null, { status: 302, headers: resumed.headers });
}

export const authHandler = {
	// The OAuth provider adds OAUTH_PROVIDER to the env it passes here.
	async fetch(request: Request, baseEnv: Env): Promise<Response> {
		const env = baseEnv as AuthEnv;
		const { pathname } = new URL(request.url);
		try {
			if (pathname === "/authorize" && request.method === "GET") return await showConsent(request, env);
			if (pathname === "/authorize" && request.method === "POST") return await submitConsent(request, env);
			if (pathname === "/callback" && request.method === "GET") return await callback(request, env);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			return page("Sign-in error", `<h1>Sign-in error</h1><p>${escape(message)}</p>`, new Headers(), 400);
		}
		if (pathname === "/") {
			return new Response("data-lake: connect an MCP client to /mcp.\n", { headers: { "Content-Type": "text/plain" } });
		}
		return new Response("Not found\n", { status: 404 });
	},
};
