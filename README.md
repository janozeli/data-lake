# data-lake

A raw, append-only store for your conversations and other sources, running on
Cloudflare and reachable from Claude over MCP.

The lake keeps things exactly as they were saved and has no opinion about what
they contain. It does not parse, summarize, index or organize. Tools that do
those things can be built on top of it; the lake only stores and gives back.

- **Append-only.** Every save creates a new, immutable item. Nothing is ever
  updated or synchronized: saving the same thing twice records two items.
- **Soft delete.** Deleting moves an item to the trash. It can be restored for
  30 days, then it is purged automatically.
- **Private.** MCP clients sign in with GitHub, and only the accounts you list
  get in. Scripts use a separate API token.

## Operations

| Operation | MCP tool  | REST                            |
| --------- | --------- | ------------------------------- |
| Save      | `save`    | `POST /v1/items`                |
| List      | `list`    | `GET /v1/items`                 |
| Read      | `read`    | `GET /v1/items/:id`             |
| Delete    | `delete`  | `DELETE /v1/items/:id`          |
| Restore   | `restore` | `POST /v1/items/:id/restore`    |

Each item has an `id`, the `source` it came from (free text set by whoever
saved it), its `contentType`, `size`, `sha256` and `savedAt`. Items in the
trash also have `deletedAt`. Ids sort newest first, so lists start with the
latest items. Items can be up to 25 MiB.

## Connect

**Claude (web, desktop and mobile).** Add a custom connector with the URL
`https://<your-worker>/mcp`. Claude opens a consent page, then GitHub sign-in.

**Claude Code.**

```sh
claude mcp add --transport http data-lake https://<your-worker>/mcp
```

**Scripts and the browser extension.** Send the API token as a bearer token:

```sh
curl -X POST https://<your-worker>/v1/items \
  -H "Authorization: Bearer $LAKE_API_TOKEN" \
  -H "X-Lake-Source: claude.ai conversation" \
  -H "Content-Type: application/json" \
  --data-binary @conversation.json

curl https://<your-worker>/v1/items -H "Authorization: Bearer $LAKE_API_TOKEN"
```

The source can also be passed as `?source=`. Lists accept `?limit=` and
`?cursor=`. Add `?trash=true` to list or read the trash. Reading an item
returns its raw bytes, with its metadata in `X-Lake-*` headers.

## Deploy

Deploys run from GitHub Actions on every push to `main`. Pull requests from
this repository that are not drafts merge themselves once tests pass, and the
merge is deployed. The R2 bucket and the KV namespace used for sign-in are
created on the first deploy.

1. **Cloudflare.** Enable R2, then create an API token from the
   *Edit Cloudflare Workers* template with *Workers R2 Storage: Edit* added.
   Note your account ID.
2. **GitHub OAuth app.** In GitHub, *Settings → Developer settings → OAuth
   Apps → New OAuth App*. Use `https://<your-worker>` as the homepage URL and
   `https://<your-worker>/callback` as the callback URL. The worker URL is
   `https://data-lake.<your-subdomain>.workers.dev` unless you add a custom
   domain.
3. **Repository secrets.** In *Settings → Secrets and variables → Actions*:

   | Secret                   | Value                                          |
   | ------------------------ | ---------------------------------------------- |
   | `CLOUDFLARE_API_TOKEN`   | the API token from step 1                      |
   | `CLOUDFLARE_ACCOUNT_ID`  | your Cloudflare account ID                     |
   | `OAUTH_CLIENT_ID`        | the OAuth app's client ID                      |
   | `OAUTH_CLIENT_SECRET`    | the OAuth app's client secret                  |
   | `LAKE_API_TOKEN`         | a long random string, e.g. `openssl rand -hex 32` |

4. **Allowed accounts.** Set `ALLOWED_GITHUB_LOGINS` in `wrangler.jsonc` to the
   GitHub logins that may sign in, separated by commas.

## How it is stored

```
items/<id>   live items, content stored as is
trash/<id>   deleted items, purged 30 days after deletion
```

Metadata lives in each R2 object's HTTP and custom metadata, so the bucket is
readable on its own, without this worker.

## Develop

```sh
npm install
npm test           # runs in the Workers runtime with local R2 and KV
npm run typecheck
npm run dev        # local server on http://localhost:8787
```

Binding types are generated from `wrangler.jsonc` into
`worker-configuration.d.ts` by `npm run types` (`typecheck` does this first).

## License

[MIT](LICENSE)
