import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { get, isId, LakeError, list, MAX_BYTES, newId, purge, remove, restore, RETENTION_DAYS, save } from "../src/lake";

const DAY = 24 * 60 * 60 * 1000;
const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
const text = async (body: ReadableStream) => new Response(body).text();

describe("ids", () => {
	it("sort newest first", () => {
		const older = newId(1_000_000);
		const newer = newId(2_000_000);
		expect(isId(older)).toBe(true);
		expect([older, newer].sort()).toEqual([newer, older]);
	});

	it("reject anything that is not an id", async () => {
		for (const bad of ["", "../items/x", "abc", "ZZZZZZZZZZZZ-00000000"]) {
			expect(isId(bad)).toBe(false);
			await expect(get(env.LAKE, bad)).rejects.toBeInstanceOf(LakeError);
		}
	});
});

describe("save", () => {
	it("stores the content unchanged with its metadata", async () => {
		const item = await save(env.LAKE, { body: bytes("hello lake"), source: "test", contentType: "text/plain" }, Date.UTC(2026, 10, 4));
		expect(item).toMatchObject({
			source: "test",
			contentType: "text/plain",
			size: 10,
			savedAt: "2026-11-04T00:00:00.000Z",
			sha256: "429a20b1cc698b0f5ed1781c69770901ca9191e03c5e80c83470957dda04fb9a",
		});
		const found = await get(env.LAKE, item.id);
		expect(found?.item).toEqual(item);
		expect(await text(found!.body)).toBe("hello lake");
	});

	it("never overwrites: saving twice creates two items", async () => {
		const a = await save(env.LAKE, { body: bytes("same"), source: "test" });
		const b = await save(env.LAKE, { body: bytes("same"), source: "test" });
		expect(a.id).not.toBe(b.id);
		expect(a.sha256).toBe(b.sha256);
		expect((await list(env.LAKE)).items).toHaveLength(2);
	});

	it("rejects empty content, missing source and oversized content", async () => {
		await expect(save(env.LAKE, { body: bytes(""), source: "test" })).rejects.toMatchObject({ status: 400 });
		await expect(save(env.LAKE, { body: bytes("x"), source: "  " })).rejects.toMatchObject({ status: 400 });
		await expect(save(env.LAKE, { body: new ArrayBuffer(MAX_BYTES + 1), source: "test" })).rejects.toMatchObject({ status: 413 });
	});
});

describe("list", () => {
	it("returns newest first and pages with a cursor", async () => {
		const saved = [];
		for (let i = 0; i < 3; i++) saved.push(await save(env.LAKE, { body: bytes(`item ${i}`), source: "test" }, 1_000 + i));
		const first = await list(env.LAKE, { limit: 2 });
		expect(first.items.map((item) => item.id)).toEqual([saved[2].id, saved[1].id]);
		expect(first.cursor).toBeDefined();
		const second = await list(env.LAKE, { limit: 2, cursor: first.cursor });
		expect(second.items.map((item) => item.id)).toEqual([saved[0].id]);
		expect(second.cursor).toBeUndefined();
	});
});

describe("delete and restore", () => {
	it("moves an item to the trash and back", async () => {
		const item = await save(env.LAKE, { body: bytes("oops"), source: "test", contentType: "text/plain" });
		const trashed = await remove(env.LAKE, item.id, Date.UTC(2026, 10, 4));

		expect(trashed.deletedAt).toBe("2026-11-04T00:00:00.000Z");
		expect(await get(env.LAKE, item.id)).toBeNull();
		expect((await list(env.LAKE)).items).toHaveLength(0);
		expect((await list(env.LAKE, { trash: true })).items.map((i) => i.id)).toEqual([item.id]);

		const restored = await restore(env.LAKE, item.id);
		expect(restored).toEqual(item);
		expect(await text((await get(env.LAKE, item.id))!.body)).toBe("oops");
		expect((await list(env.LAKE, { trash: true })).items).toHaveLength(0);
	});

	it("reports missing items as 404", async () => {
		const id = newId();
		await expect(remove(env.LAKE, id)).rejects.toMatchObject({ status: 404 });
		await expect(restore(env.LAKE, id)).rejects.toMatchObject({ status: 404 });
	});
});

describe("purge", () => {
	it(`permanently deletes items that have been in the trash for ${RETENTION_DAYS} days`, async () => {
		const deletedAt = Date.UTC(2026, 0, 1);
		const old = await save(env.LAKE, { body: bytes("old"), source: "test" });
		const recent = await save(env.LAKE, { body: bytes("recent"), source: "test" });
		const live = await save(env.LAKE, { body: bytes("live"), source: "test" });
		await remove(env.LAKE, old.id, deletedAt);
		await remove(env.LAKE, recent.id, deletedAt + 2 * DAY);

		expect(await purge(env.LAKE, deletedAt + RETENTION_DAYS * DAY)).toBe(1);
		expect((await list(env.LAKE, { trash: true })).items.map((i) => i.id)).toEqual([recent.id]);
		expect(await get(env.LAKE, live.id)).not.toBeNull();
	});
});
