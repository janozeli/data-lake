// ==UserScript==
// @name         data-lake capture
// @namespace    https://github.com/janozeli/data-lake
// @version      0.2.1
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
 * The item's source is the page URL. Save with the small button in the
 * bottom-right corner, with Alt+Shift+L, or from the Violentmonkey menu. The
 * button remembers when each page was last saved from this browser.
 *
 * The lake URL, API token and button preferences are kept in the script's own
 * storage and edited in its settings dialog (Violentmonkey menu → Settings),
 * which also opens on the first save.
 * @connect is open because the lake URL is yours to choose; requests only go
 * to the URL you set.
 */

(function () {
	"use strict";

	const SHORTCUT = { altKey: true, shiftKey: true, code: "KeyL" };
	const CLAUDE_HOST = "claude.ai";
	const UI_MARK = "data-lake-ui";
	const CONVERSATION_PATH = /^\/chat\/([0-9a-f-]{36})(?:[/?#]|$)/i;
	const HISTORY_LIMIT = 1000;

	// ---------------------------------------------------------------- settings

	/** Button modes: everywhere, only on claude.ai conversations, or never. */
	const BUTTON_MODES = { everywhere: "On every site", claude: "Only on claude.ai conversations", never: "Never" };

	const settings = {
		get url() {
			return GM_getValue("lakeUrl", "").replace(/\/+$/, "");
		},
		get token() {
			return GM_getValue("lakeToken", "");
		},
		get buttonMode() {
			return GM_getValue("buttonMode", "everywhere");
		},
		get hiddenSites() {
			return GM_getValue("hiddenSites", []);
		},
		save({ url, token, buttonMode }) {
			GM_setValue("lakeUrl", url.trim().replace(/\/+$/, ""));
			GM_setValue("lakeToken", token.trim());
			GM_setValue("buttonMode", buttonMode);
		},
		toggleSite(host) {
			const hidden = new Set(this.hiddenSites);
			hidden.has(host) ? hidden.delete(host) : hidden.add(host);
			GM_setValue("hiddenSites", [...hidden]);
		},
	};

	/** When each source was last saved from this browser, newest last. */
	const history = {
		get(source) {
			return GM_getValue("history", {})[source] ?? null;
		},
		add(source, savedAt) {
			const entries = GM_getValue("history", {});
			delete entries[source];
			entries[source] = savedAt;
			const keys = Object.keys(entries);
			for (const key of keys.slice(0, Math.max(0, keys.length - HISTORY_LIMIT))) delete entries[key];
			GM_setValue("history", entries);
		},
	};

	// ----------------------------------------------------------------- capture

	function claudeConversationId() {
		if (location.hostname !== CLAUDE_HOST) return null;
		return location.pathname.match(CONVERSATION_PATH)?.[1] ?? null;
	}

	function currentSource() {
		const id = claudeConversationId();
		return id ? `https://${CLAUDE_HOST}/chat/${id}` : location.href;
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

	function request(method, url, token, { body, contentType, source } = {}) {
		return new Promise((resolve, reject) => {
			const headers = { Authorization: `Bearer ${token}` };
			if (contentType) headers["Content-Type"] = contentType;
			if (source) headers["X-Lake-Source"] = source;
			GM_xmlhttpRequest({
				method,
				url,
				headers,
				data: body ? new Blob([body], { type: contentType }) : undefined,
				responseType: "json",
				timeout: 60_000,
				onload: (response) => resolve({ status: response.status, body: response.response ?? safeJson(response.responseText) }),
				onerror: () => reject(new Error(`could not reach ${new URL(url).host}`)),
				ontimeout: () => reject(new Error(`${new URL(url).host} did not answer in time`)),
			});
		});
	}

	async function post(url, token, snapshot) {
		const response = await request("POST", `${url}/v1/items`, token, snapshot);
		if (response.status !== 201) throw new Error(lakeError(response.status, response.body));
		return response.body;
	}

	/** Checks that the lake answers and accepts the token, without saving anything. */
	async function testConnection(url, token) {
		const response = await request("GET", `${url}/v1/items?limit=1`, token);
		if (response.status !== 200) throw new Error(lakeError(response.status, response.body));
	}

	function safeJson(text) {
		try {
			return JSON.parse(text);
		} catch {
			return null;
		}
	}

	function lakeError(status, result) {
		if (status === 401 || status === 403) return "the lake refused the token";
		return `the lake answered ${status}${result?.error ? `: ${result.error}` : ""}`;
	}

	// ---------------------------------------------------------------- helpers

	function formatSize(bytes) {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	}

	function formatAgo(iso) {
		const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
		if (seconds < 60) return "just now";
		const minutes = Math.floor(seconds / 60);
		if (minutes < 60) return `${minutes} min ago`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours} h ago`;
		const days = Math.floor(hours / 24);
		return days === 1 ? "yesterday" : `${days} days ago`;
	}

	function element(tag, attributes = {}, children = []) {
		const node = document.createElement(tag);
		for (const [key, value] of Object.entries(attributes)) {
			if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
			else if (value !== undefined && value !== false) node.setAttribute(key, value === true ? "" : value);
		}
		node.append(...children);
		return node;
	}

	// ---------------------------------------------------------------------- ui

	const CSS = `
		:host { all: initial; }
		* { box-sizing: border-box; font: 13px/1.4 system-ui, -apple-system, sans-serif; }
		.layer { --bg: #fff; --fg: #18181b; --muted: #71717a; --line: #d4d4d8; --accent: #2563eb;
			--ok: #15803d; --error: #b91c1c; color: var(--fg); }
		@media (prefers-color-scheme: dark) {
			.layer { --bg: #27272a; --fg: #f4f4f5; --muted: #a1a1aa; --line: #3f3f46; --accent: #60a5fa; }
		}
		.dock { position: fixed; right: 16px; bottom: 16px; z-index: 2147483646; display: flex; gap: 4px;
			opacity: .6; transition: opacity .15s; }
		.dock:hover, .dock:focus-within, .dock[data-state="busy"] { opacity: 1; }
		.dock button { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border: 1px solid var(--line);
			border-radius: 999px; background: var(--bg); color: var(--fg); box-shadow: 0 2px 8px rgba(0,0,0,.15);
			cursor: pointer; }
		.dock .gear { padding: 6px 8px; }
		.gear svg { width: 14px; height: 14px; display: block; }
		.dock[data-state="saved"] .dot { background: var(--ok); }
		.save:disabled { cursor: progress; }
		.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: none; }
		.toast { position: fixed; right: 16px; bottom: 60px; z-index: 2147483647; max-width: 360px; padding: 8px 12px;
			border-radius: 8px; color: #fff; box-shadow: 0 2px 8px rgba(0,0,0,.2); }
		.toast.ok { background: var(--ok); } .toast.error { background: var(--error); }
		.backdrop { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center;
			background: rgba(0,0,0,.4); }
		form { width: min(420px, calc(100vw - 32px)); padding: 20px; border-radius: 12px; background: var(--bg);
			color: var(--fg); box-shadow: 0 8px 32px rgba(0,0,0,.3); display: grid; gap: 14px; }
		h2 { margin: 0; font-size: 16px; font-weight: 600; }
		label { display: grid; gap: 4px; color: var(--muted); }
		input, select { width: 100%; padding: 7px 9px; border: 1px solid var(--line); border-radius: 6px;
			background: transparent; color: var(--fg); }
		input:focus, select:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
		.row { display: flex; gap: 6px; } .row input { flex: 1; }
		.status { min-height: 18px; color: var(--muted); } .status.ok { color: var(--ok); } .status.error { color: var(--error); }
		.actions { display: flex; justify-content: flex-end; gap: 8px; }
		button.plain, button.primary { padding: 7px 12px; border-radius: 6px; border: 1px solid var(--line);
			background: transparent; color: var(--fg); cursor: pointer; }
		button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
		.actions .plain:first-child { margin-right: auto; }
	`;

	/** Events the page must not see while the user types in this script's UI. */
	const GUARDED_EVENTS = ["keydown", "keyup", "keypress", "beforeinput", "input", "paste", "copy", "cut",
		"compositionstart", "compositionupdate", "compositionend", "focusin", "focusout"];

	let layer;
	let closeDialog = null;

	/**
	 * All UI lives in one shadow root, so the page's styles can't reach it and
	 * captures can skip it. Pages such as claude.ai listen for typing and
	 * pasting anywhere and pull them into their own text box, so keyboard and
	 * clipboard events inside the UI are stopped at the window, before any
	 * listener of the page runs. Default actions (typing, pasting) still happen.
	 */
	function ui() {
		if (!layer) {
			const host = element("div", { [UI_MARK]: true });
			const shadow = host.attachShadow({ mode: "closed" });
			shadow.append(element("style", {}, [CSS]));
			layer = element("div", { class: "layer" });
			shadow.append(layer);
			document.documentElement.append(host);

			for (const type of GUARDED_EVENTS) {
				window.addEventListener(type, (event) => {
					if (!event.composedPath().includes(host)) return;
					event.stopImmediatePropagation();
					if (type === "keydown" && event.key === "Escape") closeDialog?.();
				}, true);
			}
		}
		return layer;
	}

	function toast(message, kind) {
		const node = element("div", { class: `toast ${kind}`, role: "status" }, [message]);
		ui().append(node);
		setTimeout(() => node.remove(), kind === "error" ? 8000 : 4000);
	}

	// ---- settings dialog

	function openSettings({ reason } = {}) {
		return new Promise((resolve) => {
			if (ui().querySelector(".backdrop")) return resolve(false);

			const url = element("input", { type: "url", required: true, placeholder: "https://data-lake.<you>.workers.dev", value: settings.url });
			const token = element("input", { type: "password", required: true, autocomplete: "off", value: settings.token });
			const reveal = element("button", { type: "button", class: "plain", onclick: () => {
				token.type = token.type === "password" ? "text" : "password";
				reveal.textContent = token.type === "password" ? "Show" : "Hide";
			} }, ["Show"]);
			const mode = element("select", {}, Object.entries(BUTTON_MODES).map(([value, label]) =>
				element("option", { value, selected: value === settings.buttonMode }, [label])));
			const status = element("div", { class: "status", role: "status" }, [reason ?? ""]);

			const close = (saved) => {
				backdrop.remove();
				closeDialog = null;
				resolve(saved);
			};

			const test = async () => {
				status.className = "status";
				status.textContent = "Testing…";
				try {
					await testConnection(url.value.trim().replace(/\/+$/, ""), token.value.trim());
					status.className = "status ok";
					status.textContent = "Connected: the lake accepts this token.";
				} catch (error) {
					status.className = "status error";
					status.textContent = `Not connected: ${error.message}.`;
				}
			};

			const form = element("form", { onsubmit: (event) => {
				event.preventDefault();
				settings.save({ url: url.value, token: token.value, buttonMode: mode.value });
				syncButton();
				close(true);
			} }, [
				element("h2", {}, ["data-lake settings"]),
				element("label", {}, ["Lake URL", url]),
				element("label", {}, ["API token (LAKE_API_TOKEN)", element("div", { class: "row" }, [token, reveal])]),
				element("label", {}, ["Show the save button", mode]),
				status,
				element("div", { class: "actions" }, [
					element("button", { type: "button", class: "plain", onclick: test }, ["Test connection"]),
					element("button", { type: "button", class: "plain", onclick: () => close(false) }, ["Cancel"]),
					element("button", { type: "submit", class: "primary" }, ["Save"]),
				]),
			]);
			const backdrop = element("div", { class: "backdrop", onclick: (event) => event.target === backdrop && close(false) }, [form]);

			ui().append(backdrop);
			closeDialog = () => close(false);
			(settings.url ? token : url).focus();
		});
	}

	// ---- save button

	const GEAR = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
		stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33
		1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65
		1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0
		0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65
		1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2
		2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;

	let dock;
	let busy = false;

	function buttonWanted() {
		if (settings.hiddenSites.includes(location.hostname)) return false;
		const mode = settings.buttonMode;
		return mode === "everywhere" || (mode === "claude" && claudeConversationId() !== null);
	}

	function syncButton() {
		if (!buttonWanted()) {
			dock?.remove();
			dock = null;
			return;
		}
		if (!dock) {
			const gear = element("button", { type: "button", class: "gear", title: "data-lake settings",
				"aria-label": "data-lake settings", onclick: () => openSettings() });
			gear.innerHTML = GEAR;
			dock = element("div", { class: "dock" }, [
				element("button", { type: "button", class: "save", onclick: saveToLake }, [
					element("span", { class: "dot" }),
					element("span", { class: "label" }),
				]),
				gear,
			]);
			ui().append(dock);
		}
		const button = dock.querySelector(".save");
		const savedAt = history.get(currentSource());
		const what = claudeConversationId() ? "this conversation" : "this page";
		const label = busy ? "Saving…" : savedAt ? `Saved ${formatAgo(savedAt)}` : "Save to lake";
		button.querySelector(".label").textContent = label;
		dock.dataset.state = busy ? "busy" : savedAt ? "saved" : "idle";
		button.disabled = busy;
		button.title = savedAt
			? `Saved ${new Date(savedAt).toLocaleString()}. Click to save ${what} again (Alt+Shift+L).`
			: `Save ${what} to the lake (Alt+Shift+L).`;
	}

	// ---- saving

	async function saveToLake() {
		if (busy) return;
		if (!settings.url || !settings.token) {
			const saved = await openSettings({ reason: "Set the lake URL and token to save." });
			if (!saved) return;
		}

		busy = true;
		syncButton();
		try {
			const snapshot = await capture();
			const item = await post(settings.url, settings.token, snapshot);
			history.add(snapshot.source, item.savedAt ?? new Date().toISOString());
			toast(`Saved to the lake · ${formatSize(item.size)}`, "ok");
		} catch (error) {
			toast(`Not saved: ${error.message}.`, "error");
			if (/refused the token/.test(error.message)) openSettings({ reason: "The lake refused the token." });
		} finally {
			busy = false;
			syncButton();
		}
	}

	// ------------------------------------------------------------------ wiring

	GM_registerMenuCommand("Save this page to the lake", saveToLake);
	GM_registerMenuCommand("Settings…", () => openSettings());
	GM_registerMenuCommand(`Show or hide the button on ${location.hostname}`, () => {
		settings.toggleSite(location.hostname);
		syncButton();
	});

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

	// Single-page apps change URL without reloading, and "saved 3 min ago" ages.
	syncButton();
	setInterval(syncButton, 5000);
	let lastHref = location.href;
	setInterval(() => {
		if (location.href !== lastHref) {
			lastHref = location.href;
			syncButton();
		}
	}, 500);
})();
