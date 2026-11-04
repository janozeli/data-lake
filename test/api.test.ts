import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

const BASE = "https://lake.example";
const AUTH = { Authorization: "Bearer test-api-token" };

function call(path: string, init: RequestInit = {}) {
	return SELF.fetch(`${BASE}${path}`, init);
}

function api(path: string, init: RequestInit = {}) {
	return call(path, { ...init, headers: { ...AUTH, ...init.headers } });
}

let rpcId = 0;
async function mcp(method: string, params: unknown = {}) {
	const response = await api("/mcp", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"MCP-Protocol-Version": "2025-06-18",
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
	});
	expect(response.status).toBe(200);
	const body = await response.text();
	// Responses may come as plain JSON or as a single SSE event.
	const payload = body.startsWith("{") ? body : body.split("\n").find((line) => line.startsWith("data:"))!.slice(5);
	return JSON.parse(payload) as { result?: any; error?: any };
}

describe("authentication", () => {
	it("rejects requests without a valid token", async () => {
		expect((await call("/v1/items")).status).toBe(401);
		expect((await call("/v1/items", { headers: { Authorization: "Bearer nope" } })).status).toBe(401);
		expect((await call("/mcp", { method: "POST" })).status).toBe(401);
	});

	it("publishes OAuth metadata for MCP clients", async () => {
		const response = await call("/.well-known/oauth-protected-resource");
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ resource: BASE });
	});
});

describe("REST API", () => {
	it("saves, lists, reads, deletes and restores", async () => {
		const saved = await api("/v1/items", {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Lake-Source": "claude.ai conversation" },
			body: '{"hello":"lake"}',
		});
		expect(saved.status).toBe(201);
		const item = (await saved.json()) as { id: string; source: string };
		expect(item.source).toBe("claude.ai conversation");

		const listed = (await (await api("/v1/items")).json()) as { items: { id: string }[] };
		expect(listed.items.map((i) => i.id)).toEqual([item.id]);

		const read = await api(`/v1/items/${item.id}`);
		expect(read.headers.get("Content-Type")).toBe("application/json");
		expect(read.headers.get("X-Lake-Source")).toBe(encodeURIComponent("claude.ai conversation"));
		expect(await read.text()).toBe('{"hello":"lake"}');

		expect((await api(`/v1/items/${item.id}`, { method: "DELETE" })).status).toBe(200);
		expect((await api(`/v1/items/${item.id}`)).status).toBe(404);
		expect((await api(`/v1/items/${item.id}?trash=true`)).status).toBe(200);

		expect((await api(`/v1/items/${item.id}/restore`, { method: "POST" })).status).toBe(200);
		expect(await (await api(`/v1/items/${item.id}`)).text()).toBe('{"hello":"lake"}');
	});

	it("returns clear errors", async () => {
		const noSource = await api("/v1/items", { method: "POST", body: "x" });
		expect(noSource.status).toBe(400);
		expect(await noSource.json()).toEqual({ error: "source is required" });
		expect((await api("/v1/items/not-an-id")).status).toBe(400);
		expect((await api("/v1/items", { method: "PUT" })).status).toBe(405);
	});
});

describe("MCP", () => {
	it("lists the lake tools", async () => {
		const { result } = await mcp("tools/list");
		expect(result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(["delete", "list", "read", "restore", "save"]);
	});

	it("saves and reads back through tools", async () => {
		const saved = await mcp("tools/call", {
			name: "save",
			arguments: { content: "# A conversation\n\nHello.", source: "test", content_type: "text/markdown" },
		});
		const item = JSON.parse(saved.result.content[0].text);
		expect(item).toMatchObject({ source: "test", contentType: "text/markdown" });

		const read = await mcp("tools/call", { name: "read", arguments: { id: item.id } });
		expect(read.result.content[1].text).toBe("# A conversation\n\nHello.");

		const deleted = await mcp("tools/call", { name: "delete", arguments: { id: item.id } });
		expect(JSON.parse(deleted.result.content[0].text).deletedAt).toBeDefined();

		const missing = await mcp("tools/call", { name: "read", arguments: { id: item.id } });
		expect(missing.result.isError).toBe(true);
	});
});

/** Walk the consent page and return the GitHub redirect plus the browser's cookies. */
async function startSignIn() {
	const registered = await call("/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ client_name: "Test Client", redirect_uris: ["https://client.example/callback"] }),
	});
	expect(registered.status).toBe(201);
	const { client_id: clientId } = (await registered.json()) as { client_id: string };

	const authorize = new URL(`${BASE}/authorize`);
	authorize.search = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: "https://client.example/callback",
		state: "client-state",
		code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
		code_challenge_method: "S256",
		resource: BASE,
	}).toString();
	const consent = await SELF.fetch(authorize);
	expect(consent.status).toBe(200);
	const html = await consent.text();
	const jar = new Map<string, string>();
	const keep = (response: Response) => {
		for (const header of response.headers.getSetCookie()) {
			const [pair] = header.split(";");
			const [name, value] = pair.split("=");
			jar.set(name, value);
		}
	};
	const cookies = () => [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
	keep(consent);

	const handle = html.match(/name="handle" value="([^"]+)"/)![1];
	const approved = await call("/authorize", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookies() },
		body: new URLSearchParams({ handle, decision: "approve" }).toString(),
		redirect: "manual",
	});
	expect(approved.status).toBe(302);
	keep(approved);
	return { html, github: new URL(approved.headers.get("Location")!), cookies };
}

function fakeGitHub(login: string) {
	const realFetch = globalThis.fetch;
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "gh-token" });
		if (url === "https://api.github.com/user") return Response.json({ login });
		return realFetch(input, init);
	});
}

describe("sign-in", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("shows a consent page, then sends the browser to GitHub", async () => {
		const { html, github } = await startSignIn();
		expect(html).toContain("Test Client");
		expect(html).toContain("client.example");
		expect(github.origin + github.pathname).toBe("https://github.com/login/oauth/authorize");
		expect(github.searchParams.get("client_id")).toBe("test-client-id");
		expect(github.searchParams.get("redirect_uri")).toBe(`${BASE}/callback`);
		expect(github.searchParams.get("state")).toBeTruthy();
	});

	it("gives an allowed GitHub account a code for the client", async () => {
		const { github, cookies } = await startSignIn();
		fakeGitHub("JanoZeli");
		const back = await call(`/callback?code=gh-code&state=${github.searchParams.get("state")}`, {
			headers: { Cookie: cookies() },
			redirect: "manual",
		});
		expect(back.status).toBe(302);
		const redirect = new URL(back.headers.get("Location")!);
		expect(redirect.origin + redirect.pathname).toBe("https://client.example/callback");
		expect(redirect.searchParams.get("code")).toBeTruthy();
		expect(redirect.searchParams.get("state")).toBe("client-state");
	});

	it("refuses GitHub accounts that are not allowed", async () => {
		const { github, cookies } = await startSignIn();
		fakeGitHub("someone-else");
		const back = await call(`/callback?code=gh-code&state=${github.searchParams.get("state")}`, {
			headers: { Cookie: cookies() },
			redirect: "manual",
		});
		expect(back.status).toBe(403);
	});
});
