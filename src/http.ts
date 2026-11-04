/**
 * REST API over the lake, for scripts and the browser extension.
 *
 *   POST   /v1/items                 save the request body as a new item
 *   GET    /v1/items                 list items (?trash=true, ?limit=, ?cursor=)
 *   GET    /v1/items/:id             read an item's raw content (?trash=true)
 *   DELETE /v1/items/:id             move an item to the trash
 *   POST   /v1/items/:id/restore     bring an item back from the trash
 *
 * The source of a saved item comes from the `X-Lake-Source` header or the
 * `source` query parameter. Authentication happens before this handler runs.
 */

import { get, LakeError, list, MAX_BYTES, remove, restore, save, type Item } from "./lake";

function json(data: unknown, status = 200): Response {
	return Response.json(data, { status });
}

function error(status: number, message: string): Response {
	return json({ error: message }, status);
}

function itemHeaders(item: Item): Headers {
	const headers = new Headers({
		"Content-Type": item.contentType,
		"Content-Length": String(item.size),
		"X-Lake-Id": item.id,
		"X-Lake-Source": encodeURIComponent(item.source),
		"X-Lake-Saved-At": item.savedAt,
		"X-Lake-Sha256": item.sha256,
	});
	if (item.deletedAt) headers.set("X-Lake-Deleted-At", item.deletedAt);
	return headers;
}

export async function handleHttp(request: Request, bucket: R2Bucket): Promise<Response> {
	const url = new URL(request.url);
	const parts = url.pathname.split("/").filter(Boolean); // ["v1", "items", id?, action?]
	const trash = url.searchParams.get("trash") === "true";

	if (parts[0] !== "v1" || parts[1] !== "items" || parts.length > 4) return error(404, "not found");
	const [, , id, action] = parts;

	try {
		if (!id && request.method === "POST") {
			const declared = Number(request.headers.get("Content-Length") ?? 0);
			if (declared > MAX_BYTES) return error(413, `content is larger than ${MAX_BYTES} bytes`);
			const item = await save(bucket, {
				body: await request.arrayBuffer(),
				source: request.headers.get("X-Lake-Source") ?? url.searchParams.get("source") ?? "",
				contentType: request.headers.get("Content-Type") ?? undefined,
			});
			return json(item, 201);
		}

		if (!id && request.method === "GET") {
			const limit = url.searchParams.get("limit");
			return json(
				await list(bucket, {
					trash,
					limit: limit ? Number(limit) : undefined,
					cursor: url.searchParams.get("cursor") ?? undefined,
				}),
			);
		}

		if (id && !action && request.method === "GET") {
			const found = await get(bucket, id, { trash });
			if (!found) return error(404, `no item ${id}`);
			return new Response(found.body, { headers: itemHeaders(found.item) });
		}

		if (id && !action && request.method === "DELETE") return json(await remove(bucket, id));

		if (id && action === "restore" && request.method === "POST") return json(await restore(bucket, id));

		return error(405, "method not allowed");
	} catch (e) {
		if (e instanceof LakeError) return error(e.status, e.message);
		throw e;
	}
}
