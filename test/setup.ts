import { reset } from "cloudflare:test";
import { beforeEach } from "vitest";

// Start every test with empty storage.
beforeEach(() => reset());
