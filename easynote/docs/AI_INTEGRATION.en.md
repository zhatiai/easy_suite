# EasyNote AI Integration

[简体中文](AI_INTEGRATION.md) | [English](AI_INTEGRATION.en.md)

EasyNote exposes a remote Streamable HTTP MCP server at `/mcp` after deployment. Users do not need to download source code, install Node.js, or run a local bridge:

```text
AI Client → https://EasyNote-Domain/mcp → D1 / R2
```

## Creating a Token

Log in to EasyNote, open "Settings", and create a token under "AI Integration":

- Name: Displayed in the token list and version history, e.g. "My Codex".
- Permissions: Select "Read & Write" if AI needs to modify notes; select "Read-Only" for search and retrieval only.
- Expiration: 30, 90, 365 days, or permanent.

Copy the `enai_...` token immediately after creation. Plaintext tokens are displayed only once.

## Connecting Codex

After generating a token, click "Copy Codex Configuration" and add the snippet to `~/.codex/config.toml`:

```toml
[mcp_servers.easynote]
url = "https://your-easynote-domain/mcp"
http_headers = { Authorization = "Bearer enai_..." }
```

Restart Codex and verify the connection with `/mcp`. On Codex Desktop, you can also add the same Streamable HTTP URL under "Settings → MCP servers".

To avoid storing tokens directly in configuration files, set an environment variable first:

```bash
export EASYNOTE_TOKEN='enai_...'
```

Then replace `http_headers` with:

```toml
bearer_token_env_var = "EASYNOTE_TOKEN"
```

`bearer_token_env_var` must be the name of the environment variable, not the `enai_...` token itself. Direct configuration stores plaintext tokens in `config.toml`; do not share or commit this file.

## MCP Tools

| Tool | Permission | Purpose |
| --- | --- | --- |
| `easynote_search_notes` | Read-only | Searches both active and archived notes by default, returning matched context, character offsets, and pagination |
| `easynote_list_recent` | Read-only | Lists recently updated notes |
| `easynote_read_note` | Read-only | Reads a complete note in segments |
| `easynote_read_notes` | Read-only | Batch reads up to 20 notes |
| `easynote_get_note_links` | Read-only | Lists paginated incoming or outgoing references, summaries, WikiLinks, Resource URIs, and unavailable targets |
| `easynote_connection_status` | Read-only | Verifies account, token name, and permissions |
| `easynote_note_stats` | Read-only | Provides exact counts for active, archived, trash, and total notes |
| `easynote_list_folders` | Read-only | Lists the complete folder tree and direct note counts |
| `easynote_list_whiteboards` | Read-only | Lists standard Excalidraw files, folders, and revisions |
| `easynote_read_whiteboard` | Read-only | Reads a complete `.excalidraw` JSON file |
| `easynote_create_note` | Read-write | Creates a note and links up to 20 existing notes using `linked_note_ids` |
| `easynote_link_notes` | Read-write | Appends deduplicated links to an existing note with revision checks |
| `easynote_update_note` | Read-write | Updates a note or moves it with `folderId` |
| `easynote_create_folder` | Read-write | Creates a root folder or nested folder |
| `easynote_update_folder` | Read-write | Renames or moves a folder |
| `easynote_create_whiteboard` | Read-write | Creates a standard `.excalidraw` whiteboard file |
| `easynote_update_whiteboard` | Read-write | Updates, renames, or moves a whiteboard with revision checks |
| `easynote_delete_folder` | Read-write | Deletes a folder tree; notes move to the root and completely blank notes move to trash |
| `easynote_archive_note` | Read-write | Archives or unarchives a note |
| `easynote_trash_note` | Read-write | Moves a note to trash |

Read-only tokens do not expose mutating tools. Permanent deletion, account management, token management, and file uploads remain exclusively in the EasyNote web application.

## MCP Resources

Each note can be read as `text/markdown` via `easynote://notes/{id}.md`. Each whiteboard can be read as `application/vnd.excalidraw+json` via `easynote://whiteboards/{id}.excalidraw`. The note Resource list is intended for browsing the most recently updated active and archived notes (up to 100); searches still span the entire knowledge base.

## Best Practices

```text
Call easynote_search_notes first when retrieving knowledge; default view=any ensures archived notes are included.
Call easynote_note_stats for note counts; never extrapolate from paginated search results or Resource counts.
Search hits provide startOffset and endOffset; pass startOffset to easynote_read_note to read only the relevant section.
Prefer easynote_read_notes when fetching multiple note bodies.
Pass linked_note_ids to easynote_create_note to upload the body and associations in one call.
Generate id and operation_id before creation, and reuse both with identical input when retrying a timeout.
Write results include a reusable link and uri.
Use easynote_link_notes to append associations without uploading the complete source body from the caller.
Use easynote_get_note_links with direction=incoming for backlinks or outgoing for referenced notes.
Follow nextOffset until null, including empty candidate pages. missingIds are outgoing targets unavailable to the account.
Use the revision returned by the latest read or write as expected_revision. Read again when the revision is unknown or a conflict occurs.
Stop and re-read the note if a 409 Conflict occurs.
Omit '#' from titles; start top-level sections in the body with '##'.
Use easynote_trash_note for deletion; permanent removal is confirmed by users in the web app.
```

### Linked writes and retries

Targets in `linked_note_ids` must belong to the current account and be outside trash. The server resolves titles in one batch and appends stable WikiLinks, using a Markdown list for multiple new links. Existing references are deduplicated. Target bodies and revisions retain their values. Saving preserves history, operation idempotency, attachment references, and incremental synchronization.

`easynote_link_notes` accepts `id`, `expected_revision`, and `linked_note_ids`. Remove a reference by editing its Markdown through `easynote_update_note`. Backlinks are derived automatically from source content.

Creation retries must reuse `id`, `operation_id`, and the original input. A renamed target does not turn a successful creation retry into another write. Reusing an operation ID with different input returns a conflict.

## Connecting ChatGPT on the Web

ChatGPT on the web authenticates with OAuth and cannot use a static token. In ChatGPT's MCP app settings, add:

- Server URL: `https://your-easynote-domain/mcp`
- Authentication: OAuth (automatic client registration, PKCE)

ChatGPT opens EasyNote's consent page. Sign in and choose read-only or read-write access. Each authorization creates one "ChatGPT" token, listed under "Settings → AI Integration", and it can be revoked at any time. Access tokens last 1 hour, refresh tokens last 30 days and rotate on every refresh. Reusing an old refresh token revokes that authorization.

OAuth endpoints: `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/authorize`, `/oauth/token`. HTTPS only.


## Security Boundaries

- `/mcp` strictly requires HTTPS (except loopback addresses during local development).
- Every MCP request verifies an independent Bearer token, expiration, revocation status, account status, and permissions.
- AI modifications enter standard version history, tagged as `AI: <token_name>`.
- Cross-origin browser requests are rejected.
- Each account holds at most 10 active tokens; tokens can be revoked at any time in Settings.

## Troubleshooting

- `401`: Token is invalid, expired, or revoked.
- `403`: Read-only token attempted a write, or request is not HTTPS.
- `409`: Note revision changed; re-read and retry.
- `405`: Incorrect MCP URL or client did not send Streamable HTTP POST.
- Missing tools: Ensure the URL ends with `/mcp` and restart Codex.

`npm run test:ai` tests search, read, write, Resources, permission isolation, and revision conflicts using a real Streamable HTTP MCP client.

## Built-in note chat

Open **Settings → LLM configuration**, enter your OpenAI-compatible API base URL (for example `https://api.openai.com/v1`), model name, and API key, then save. Configuration is stored per account in this browser, without server sync or backup. **Clear configuration** removes it. Application scripts in this browser can read the key; use a key with limited permissions and spending limits.

The browser calls the provider directly through the OpenAI SDK's Chat Completions API. The provider must support CORS and streaming text responses with `stream: true`. URLs may use HTTPS, or HTTP on loopback addresses. Enter the base URL rather than the full `/chat/completions` endpoint. This configuration is separate from MCP tokens used by external tools to access EasyNote.

Choose **AI chat** in the note toolbar (under **More note actions** on mobile) to open the right pane without sending anything. Only submitting a question sends the current note and conversation. In reading mode, select text and choose **Ask AI** above the selection to scroll the selection toward the top of the reading pane and open a dialog below it. On desktop the centered dialog initially uses 80% of the note body width, with AI messages on the left and user messages on the right. Drag any edge or corner to resize, or focus a resize handle and use arrow keys. The dialog stays below the selection and within the reading pane. The underlying note is locked against scrolling while the dialog is open. Scroll inside for conversation history, or press Escape to close and restore the original reading position. Collapse or expand the input area while preserving your draft. This sends nothing until you submit a question. By default, requests include only the selected text and conversation. **Send selection context** adds the complete selected paragraphs and the following paragraph, stopping at the next section heading. The model is instructed to answer in Markdown. Headings, lists, tables, code and math render as text arrives; Mermaid diagrams render after generation ends. Stop keeps received text; retry uses the original question and context. Ctrl/⌘ + Enter sends, while Enter inserts a new line. You can draft your next question during generation. Scrolling up pauses automatic scrolling to the latest text. Conversations live only in page memory, end when closed or when switching notes, and do not modify note content.
