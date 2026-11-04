// ==UserScript==
// @name         data-lake capture
// @namespace    https://github.com/janozeli/data-lake
// @version      0.1.0
// @description  Save the page you are on to your data-lake: full claude.ai conversations, or a raw snapshot of any other page.
// @author       janozeli
// @license      MIT
// @homepageURL  https://github.com/janozeli/data-lake#browser-capture
// @downloadURL  https://raw.githubusercontent.com/janozeli/data-lake/main/userscript/data-lake.user.js
// @updateURL    https://raw.githubusercontent.com/janozeli/data-lake/main/userscript/data-lake.user.js
// @match        *://*/*
// @noframes
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      *
// ==/UserScript==

/*
 * One gesture, one snapshot. Every save sends what the page is right now to
 * the lake's REST API (POST /v1/items) and the lake stores it as a new,
 * immutable item. Nothing is synchronized or updated afterwards.
 *
 *   claude.ai conversation   the full conversation as claude.ai's own API
 *                            returns it (all branches, thinking, tool calls,
 *                            attachments), saved as JSON, untouched
 *   any other page           the rendered page as HTML
 *
 * The item's source is the page URL. Save from the Violentmonkey menu, with
 * Alt+Shift+L, or with the button shown on claude.ai conversations.
 *
 * The lake URL and API token are kept in the script's own storage and are
 * asked for on first use. Change them from the Violentmonkey menu.
 * @connect is open because the lake URL is yours to choose; requests only go
 * to the URL you set.
 */

(function () {
	"use strict";

	const SHORTCUT = { altKey: true, shiftKey: true, code: "KeyL" };
	const CLAUDE_HOST = "claude.ai";
	const UI_MARK = "data-lake-ui";
	const CONVERSATION_PATH = /^\/chat\/([0-9a-f-]{36})(?:[/?#]|$)/i;

	// ---------------------------------------------------------------- settings

	function setting(name, question, { ask = false } = {}) {
		let value = GM_getValue(name, "");
		if (!value || ask) {
			const answer = window.prompt(question, ask ? value : "");
			if (answer === null) return value || null;
			value = answer.trim();
			GM_setValue(name, value);
		}
		return value || null;
	}

	const lakeUrl = (ask) =>
		setting("lakeUrl", "data-lake URL (for example https://data-lake.<you>.workers.dev):", { ask })?.replace(/\/+$/, "") ??
		null;
	const lakeToken = (ask) => setting("lakeToken", "data-lake API token (LAKE_API_TOKEN):", { ask });

	// ----------------------------------------------------------------- capture

	function claudeConversationId() {
		if (location.hostname !== CLAUDE_HOST) return null;
		return location.pathname.match(CONVERSATION_PATH)?.[1] ?? null;
	}

	function cookie(name) {
		const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
		return match ? decodeURIComponent(match[1]) : null;
	}

	async function claudeApi(path) {
		const response = await fetch(path, { credentials: "include", headers: { Accept: "application/json" } });
		if (!response.ok) throw new Error(`claude.ai answered ${response.status} for ${path.split("?")[0]}`);
		return response;
	}

	async function claudeOrganizations() {
		const active = cookie("lastActiveOrg");
		if (active) return [active];
		const organizations = await (await claudeApi("/api/organizations")).json();
		return organizations.map((organization) => organization.uuid);
	}

	/** The conversation exactly as claude.ai returns it, as bytes. */
	async function captureClaudeConversation(id) {
		const query = "tree=True&rendering_mode=messages&render_all_tools=true";
		let lastError;
		for (const organization of await claudeOrganizations()) {
			try {
				const response = await claudeApi(`/api/organizations/${organization}/chat_conversations/${id}?${query}`);
				return {
					body: await response.arrayBuffer(),
					contentType: "application/json",
					source: `https://${CLAUDE_HOST}/chat/${id}`,
				};
			} catch (error) {
				lastError = error;
			}
		}
		throw lastError ?? new Error("no claude.ai organization found");
	}

	/** The page as it is rendered right now, without this script's own UI. */
	function capturePage() {
		const doctype = document.doctype ? new XMLSerializer().serializeToString(document.doctype) + "\n" : "";
		const root = document.documentElement.cloneNode(true);
		for (const element of root.querySelectorAll(`[${UI_MARK}]`)) element.remove();
		return {
			body: new TextEncoder().encode(doctype + root.outerHTML),
			contentType: "text/html; charset=utf-8",
			source: location.href,
		};
	}

	function capture() {
		const id = claudeConversationId();
		return id ? captureClaudeConversation(id) : Promise.resolve(capturePage());
	}

	// -------------------------------------------------------------------- lake

	function post(url, token, snapshot) {
		return new Promise((resolve, reject) => {
			GM_xmlhttpRequest({
				method: "POST",
				url: `${url}/v1/items`,
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": snapshot.contentType,
					"X-Lake-Source": snapshot.source,
				},
				data: new Blob([snapshot.body], { type: snapshot.contentType }),
				responseType: "json",
				timeout: 60_000,
				onload: (response) => {
					const result = response.response ?? safeJson(response.responseText);
					if (response.status === 201) resolve(result);
					else reject(new Error(lakeError(response.status, result)));
				},
				onerror: () => reject(new Error(`could not reach ${url}`)),
				ontimeout: () => reject(new Error(`${url} did not answer in time`)),
			});
		});
	}

	function safeJson(text) {
		try {
			return JSON.parse(text);
		} catch {
			return null;
		}
	}

	function lakeError(status, result) {
		if (status === 401 || status === 403) return "the lake refused the token: set it again from the menu";
		return `the lake answered ${status}${result?.error ? `: ${result.error}` : ""}`;
	}

	// ---------------------------------------------------------------------- ui

	let busy = false;

	async function saveToLake() {
		if (busy) return;
		const url = lakeUrl();
		const token = url && lakeToken();
		if (!url || !token) return toast("Not saved: set the lake URL and token first.", "error");

		busy = true;
		setButton("Saving…");
		try {
			const snapshot = await capture();
			const item = await post(url, token, snapshot);
			toast(`Saved to the lake · ${formatSize(item.size)} · ${item.id}`, "ok");
		} catch (error) {
			toast(`Not saved: ${error.message}`, "error");
		} finally {
			busy = false;
			setButton();
		}
	}

	function formatSize(bytes) {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	}

	const STYLE = {
		position: "fixed",
		right: "16px",
		zIndex: "2147483647",
		font: "13px/1.4 system-ui, sans-serif",
		borderRadius: "8px",
		boxShadow: "0 2px 8px rgba(0, 0, 0, 0.2)",
	};

	function toast(message, kind) {
		const element = document.createElement("div");
		element.setAttribute(UI_MARK, "");
		element.setAttribute("role", "status");
		element.textContent = message;
		Object.assign(element.style, STYLE, {
			bottom: "64px",
			maxWidth: "360px",
			padding: "8px 12px",
			color: "#fff",
			background: kind === "error" ? "#b91c1c" : "#15803d",
		});
		document.body.append(element);
		setTimeout(() => element.remove(), kind === "error" ? 8000 : 4000);
	}

	let button;

	function setButton(label = "Save to lake") {
		if (!button) return;
		button.textContent = label;
		button.disabled = busy;
	}

	/** claude.ai is a single-page app, so the button follows navigation. */
	function syncButton() {
		const show = claudeConversationId() !== null;
		if (show && !button) {
			button = document.createElement("button");
			button.setAttribute(UI_MARK, "");
			button.type = "button";
			button.title = "Save this conversation to the lake (Alt+Shift+L)";
			Object.assign(button.style, STYLE, {
				bottom: "16px",
				padding: "6px 12px",
				border: "1px solid rgba(0, 0, 0, 0.15)",
				background: "#fff",
				color: "#111",
				cursor: "pointer",
			});
			button.addEventListener("click", saveToLake);
			document.body.append(button);
			setButton();
		} else if (!show && button) {
			button.remove();
			button = null;
		}
	}

	GM_registerMenuCommand("Save this page to the lake", saveToLake);
	GM_registerMenuCommand("Set lake URL", () => lakeUrl(true));
	GM_registerMenuCommand("Set lake token", () => lakeToken(true));

	document.addEventListener(
		"keydown",
		(event) => {
			if (Object.entries(SHORTCUT).every(([key, value]) => event[key] === value) && !event.ctrlKey && !event.metaKey) {
				event.preventDefault();
				saveToLake();
			}
		},
		true,
	);

	if (location.hostname === CLAUDE_HOST) {
		syncButton();
		setInterval(syncButton, 1000);
	}
})();
