/**
 * MCP server exposing the lake to Claude (chat, desktop, mobile, Claude Code).
 *
 * Tools map one to one to lake operations: save, list, read, delete, restore.
 * The server is stateless: a fresh instance serves each request.
 */

import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { get, LakeError, list, remove, restore, RETENTION_DAYS, save, type Item } from "./lake";

const TEXT_TYPES = /^(text\/|application\/(json|xml|x-ndjson|yaml|toml|javascript))|\+(json|xml)\b/;

function result(data: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function failure(message: string) {
	return { content: [{ type: "text" as const, text: message }], isError: true };
}

async function run(fn: () => Promise<ReturnType<typeof result>>) {
	try {
		return await fn();
	} catch (e) {
		if (e instanceof LakeError) return failure(e.message);
		throw e;
	}
}

function base64ToBytes(value: string): ArrayBuffer {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes.buffer;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}

const itemId = z.string().describe("Item id, as returned by save or list.");

export function createLakeServer(bucket: R2Bucket): McpServer {
	const server = new McpServer({ name: "data-lake", version: "0.1.0" });

	server.registerTool(
		"save",
		{
			title: "Save to the lake",
			description:
				"Save content as a new, immutable item in the lake. Saving never overwrites: " +
				"saving the same thing again creates another item. Returns the new item's metadata.\n\n" +
				"When saving a conversation, keep as much of it as you can, as it happened:\n" +
				"- Every visible message, from both sides, verbatim and in full.\n" +
				"- Every tool call in its own block: the tool name, its full input, and its output. " +
				"Keep small outputs whole; for large ones (web pages, search results, long documents), " +
				"keep the title, the URL and the parts actually used.\n" +
				"- Never include internal reasoning or thinking.\n" +
				"- End with a short note on what was left out or shortened, and why.\n" +
				"Only call the content verbatim if nothing was summarized. " +
				"To refer to another lake item, give its id.",
			inputSchema: z.object({
				content: z.string().min(1).describe("The content to store, exactly as it should be kept."),
				source: z
					.string()
					.min(1)
					.max(200)
					.describe('Where the content came from, e.g. "claude.ai conversation <url or title>".'),
				content_type: z.string().optional().describe('MIME type. Defaults to "text/plain; charset=utf-8".'),
				encoding: z
					.enum(["utf-8", "base64"])
					.optional()
					.describe('How `content` is encoded. Use "base64" for binary data. Defaults to "utf-8".'),
			}),
		},
		({ content, source, content_type, encoding }) =>
			run(async () => {
				const body =
					encoding === "base64" ? base64ToBytes(content) : (new TextEncoder().encode(content).buffer as ArrayBuffer);
				return result(
					await save(bucket, {
						body,
						source,
						contentType: content_type ?? (encoding === "base64" ? undefined : "text/plain; charset=utf-8"),
					}),
				);
			}),
	);

	server.registerTool(
		"list",
		{
			title: "List lake items",
			description:
				"List items in the lake, newest first, with their metadata (no content). " +
				"Ids are time-ordered, so sorting them as strings also puts the newest first. " +
				"Pass the returned cursor to get the next page.",
			inputSchema: z.object({
				trash: z.boolean().optional().describe("List the trash instead of live items."),
				limit: z.number().int().min(1).max(200).optional().describe("Items per page. Defaults to 50."),
				cursor: z.string().optional().describe("Cursor from a previous call."),
			}),
			annotations: { readOnlyHint: true },
		},
		({ trash, limit, cursor }) => run(async () => result(await list(bucket, { trash, limit, cursor }))),
	);

	server.registerTool(
		"read",
		{
			title: "Read a lake item",
			description:
				"Read one item's content and metadata. Text is returned as is; " +
				"binary content is returned base64-encoded.",
			inputSchema: z.object({
				id: itemId,
				trash: z.boolean().optional().describe("Read from the trash instead of live items."),
			}),
			annotations: { readOnlyHint: true },
		},
		({ id, trash }) =>
			run(async () => {
				const found = await get(bucket, id, { trash });
				if (!found) return failure(`no item ${id}${trash ? " in the trash" : ""}`);
				const bytes = new Uint8Array(await new Response(found.body).arrayBuffer());
				const isText = TEXT_TYPES.test(found.item.contentType);
				const metadata: Item & { encoding: string } = { ...found.item, encoding: isText ? "utf-8" : "base64" };
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify(metadata, null, 2) },
						{ type: "text" as const, text: isText ? new TextDecoder().decode(bytes) : bytesToBase64(bytes) },
					],
				};
			}),
	);

	server.registerTool(
		"delete",
		{
			title: "Delete a lake item",
			description:
				`Move an item to the trash. It disappears from list and read right away, ` +
				`can be brought back with restore, and is permanently deleted after ${RETENTION_DAYS} days.`,
			inputSchema: z.object({ id: itemId }),
			annotations: { destructiveHint: false, idempotentHint: false },
		},
		({ id }) => run(async () => result(await remove(bucket, id))),
	);

	server.registerTool(
		"restore",
		{
			title: "Restore a lake item",
			description: "Bring an item back from the trash.",
			inputSchema: z.object({ id: itemId }),
		},
		({ id }) => run(async () => result(await restore(bucket, id))),
	);

	return server;
}

export function createMcpEndpoint(bucket: R2Bucket) {
	return createMcpHandler(() => createLakeServer(bucket));
}

