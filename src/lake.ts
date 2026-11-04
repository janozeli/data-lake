/**
 * The lake: an append-only store of raw items on R2.
 *
 * Every save creates a new, immutable item. Nothing is ever updated: saving
 * the same thing twice records two items. Deleting moves an item to the
 * trash, where it can be restored until it is purged after RETENTION_DAYS.
 *
 * Layout in the bucket:
 *   items/<id>   live items
 *   trash/<id>   deleted items, purged RETENTION_DAYS after deletion
 *
 * Ids sort newest first, so listing a prefix returns the latest items first.
 */

export const RETENTION_DAYS = 30;
export const MAX_BYTES = 25 * 1024 * 1024;
export const MAX_SOURCE_LENGTH = 200;
export const DEFAULT_CONTENT_TYPE = "application/octet-stream";

const LIVE = "items/";
const TRASH = "trash/";
const ID_PATTERN = /^[0-9a-f]{12}-[0-9a-f]{8}$/;
// Largest millisecond timestamp that fits in 12 hex digits (year ~10889).
const MAX_TIME = 0xffffffffffff;

export interface Item {
	id: string;
	/** Free text naming where the item came from, chosen by whoever saved it. */
	source: string;
	contentType: string;
	size: number;
	sha256: string;
	savedAt: string;
	/** Set only for items in the trash. */
	deletedAt?: string;
}

export interface ListOptions {
	trash?: boolean;
	limit?: number;
	cursor?: string;
}

export interface ListResult {
	items: Item[];
	cursor?: string;
}

export class LakeError extends Error {
	constructor(
		readonly status: 400 | 404 | 413,
		message: string,
	) {
		super(message);
	}
}

export function newId(now: number = Date.now()): string {
	const time = (MAX_TIME - now).toString(16).padStart(12, "0");
	const random = crypto.getRandomValues(new Uint8Array(4));
	return `${time}-${[...random].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function isId(value: string): boolean {
	return ID_PATTERN.test(value);
}

async function sha256(data: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", data);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function key(id: string, trash: boolean): string {
	if (!isId(id)) throw new LakeError(400, `invalid id: ${id}`);
	return (trash ? TRASH : LIVE) + id;
}

function toItem(object: R2Object, trash: boolean): Item {
	const meta = object.customMetadata ?? {};
	const item: Item = {
		id: object.key.slice((trash ? TRASH : LIVE).length),
		source: meta.source ?? "",
		contentType: object.httpMetadata?.contentType ?? DEFAULT_CONTENT_TYPE,
		size: object.size,
		sha256: meta.sha256 ?? "",
		savedAt: meta.savedAt ?? object.uploaded.toISOString(),
	};
	if (trash && meta.deletedAt) item.deletedAt = meta.deletedAt;
	return item;
}

export interface SaveInput {
	body: ArrayBuffer;
	source: string;
	contentType?: string;
}

export async function save(bucket: R2Bucket, input: SaveInput, now: number = Date.now()): Promise<Item> {
	const source = input.source.trim();
	if (!source) throw new LakeError(400, "source is required");
	if (source.length > MAX_SOURCE_LENGTH) {
		throw new LakeError(400, `source is longer than ${MAX_SOURCE_LENGTH} characters`);
	}
	if (input.body.byteLength === 0) throw new LakeError(400, "content is empty");
	if (input.body.byteLength > MAX_BYTES) {
		throw new LakeError(413, `content is larger than ${MAX_BYTES} bytes`);
	}

	const id = newId(now);
	const object = await bucket.put(key(id, false), input.body, {
		httpMetadata: { contentType: input.contentType || DEFAULT_CONTENT_TYPE },
		customMetadata: {
			source,
			savedAt: new Date(now).toISOString(),
			sha256: await sha256(input.body),
		},
	});
	return toItem(object, false);
}

export async function list(bucket: R2Bucket, options: ListOptions = {}): Promise<ListResult> {
	const trash = options.trash ?? false;
	const limit = Math.min(Math.max(options.limit ?? 50, 1), 1000);
	const page = await bucket.list({
		prefix: trash ? TRASH : LIVE,
		limit,
		cursor: options.cursor,
		include: ["httpMetadata", "customMetadata"],
	});
	return {
		items: page.objects.map((object) => toItem(object, trash)),
		cursor: page.truncated ? page.cursor : undefined,
	};
}

export async function get(
	bucket: R2Bucket,
	id: string,
	options: { trash?: boolean } = {},
): Promise<{ item: Item; body: ReadableStream } | null> {
	const trash = options.trash ?? false;
	const object = await bucket.get(key(id, trash));
	if (!object) return null;
	return { item: toItem(object, trash), body: object.body };
}

async function move(bucket: R2Bucket, id: string, toTrash: boolean, now: number): Promise<Item> {
	const from = key(id, !toTrash);
	const object = await bucket.get(from);
	if (!object) throw new LakeError(404, toTrash ? `no item ${id}` : `no item ${id} in the trash`);

	const customMetadata = { ...object.customMetadata };
	if (toTrash) customMetadata.deletedAt = new Date(now).toISOString();
	else delete customMetadata.deletedAt;

	const moved = await bucket.put(key(id, toTrash), await object.arrayBuffer(), {
		httpMetadata: object.httpMetadata,
		customMetadata,
	});
	await bucket.delete(from);
	return toItem(moved, toTrash);
}

/** Move an item to the trash. It stays restorable until purged. */
export function remove(bucket: R2Bucket, id: string, now: number = Date.now()): Promise<Item> {
	return move(bucket, id, true, now);
}

/** Bring an item back from the trash. */
export function restore(bucket: R2Bucket, id: string, now: number = Date.now()): Promise<Item> {
	return move(bucket, id, false, now);
}

/** Permanently delete items that have been in the trash for RETENTION_DAYS. Returns how many. */
export async function purge(bucket: R2Bucket, now: number = Date.now()): Promise<number> {
	const cutoff = now - RETENTION_DAYS * 24 * 60 * 60 * 1000;
	let purged = 0;
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix: TRASH, cursor, include: ["customMetadata"] });
		const expired = page.objects
			.filter((object) => {
				const deletedAt = Date.parse(object.customMetadata?.deletedAt ?? "");
				return Number.isFinite(deletedAt) ? deletedAt <= cutoff : object.uploaded.getTime() <= cutoff;
			})
			.map((object) => object.key);
		if (expired.length > 0) {
			await bucket.delete(expired);
			purged += expired.length;
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return purged;
}
