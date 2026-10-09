import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import {
  idPattern,
  noteInput,
  type IntegrationNoteSummary,
  type Note,
  type NoteInput,
} from '../shared/types.js';
import { EASYNOTE_VERSION } from '../shared/version.js';
import { EasyNoteClient } from './client.js';

const noteMetadataSchema = z.object({
  id: z.string(),
  title: z.string(),
  tags: z.array(z.string()),
  pinned: z.boolean(),
  quick: z.boolean(),
  archived: z.boolean(),
  folderId: z.string().nullable(),
  deletedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  revision: z.number(),
});

const noteResultSchema = z.object({
  note: noteMetadataSchema,
  operationId: z.string(),
});

const noteSearchMatchSchema = z.object({
  field: z.enum(['title', 'content']),
  line: z.number().int().positive().nullable(),
  heading: z.string().nullable(),
  startOffset: z.number().int().nonnegative().nullable(),
  endOffset: z.number().int().positive().nullable(),
  snippet: z.string(),
});

const recentNoteSchema = noteMetadataSchema.extend({
  excerpt: z.string(),
  uri: z.string(),
});

const readNoteSchema = z.object({
  note: noteMetadataSchema,
  content: z.string(),
  truncated: z.boolean(),
  nextOffset: z.number().int().nonnegative().nullable(),
});

const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

function noteMetadata(note: Note) {
  return {
    id: note.id,
    title: note.title,
    tags: note.tags,
    pinned: note.pinned,
    quick: note.quick,
    archived: note.archived,
    folderId: note.folderId,
    deletedAt: note.deletedAt,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    revision: note.revision,
  };
}

function noteResult(note: Note, operationId: string) {
  const result = {
    note: noteMetadata(note),
    operationId,
  };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
  };
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{
      type: 'text' as const,
      text: `${message}\nRead the note again before retrying. Never overwrite a newer revision.`,
    }],
  };
}

async function save(
  client: EasyNoteClient,
  id: string,
  input: NoteInput,
  revision: number,
    operationId = crypto.randomUUID(),
) {
  const result = await client.save(id, input, revision, operationId);
  return noteResult(result.note, operationId);
}

async function recentNotes(
  client: EasyNoteClient,
  view: 'all' | 'archive',
  limit = 50,
  tag = '',
): Promise<IntegrationNoteSummary[]> {
  const notes: IntegrationNoteSummary[] = [];
  let offset = 0;
  while (notes.length < limit) {
    const page = await client.search({
      view,
      tag,
      sort: 'updated',
      limit: Math.min(20, limit - notes.length),
      offset,
    });
    notes.push(...page.notes);
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  }
  return notes;
}

function recentNote(note: IntegrationNoteSummary) {
  return {
    id: note.id,
    title: note.title,
    tags: note.tags,
    pinned: note.pinned,
    quick: note.quick,
    archived: note.archived,
    folderId: note.folderId,
    deletedAt: note.deletedAt,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    revision: note.revision,
    excerpt: note.excerpt,
    uri: note.uri,
  };
}

function resourceMarkdown(note: Note): string {
  const title = note.title.replace(/\s+/g, ' ').trim() || 'Untitled note';
  return `# ${title}\n\n${note.content}`;
}

export async function createMcpServer(client: EasyNoteClient): Promise<McpServer> {
  const status = await client.status();
  const server = new McpServer({ name: 'easynote-mcp-server', version: EASYNOTE_VERSION });

  server.registerTool('easynote_search_notes', {
    title: 'Search EasyNote Notes',
    description: 'Search active, archived, or all EasyNote notes by exact substring with full-text relevance ranking, optionally filtering by one exact tag. Content matches include character offsets for focused follow-up reads.',
    inputSchema: z.object({
      query: z.string().max(200).default('').describe('Text matched against title and Markdown body. Chinese substring search is supported.'),
      tag: z.string().max(40).default('').describe('Optional exact tag filter.'),
      view: z.enum(['all', 'archive', 'any']).default('any').describe('any searches active and archived notes; all means active notes only; archive means archived notes only.'),
      limit: z.number().int().min(1).max(20).default(20),
      offset: z.number().int().min(0).default(0),
    }).strict(),
    outputSchema: z.object({
      notes: z.array(noteMetadataSchema.extend({
        excerpt: z.string(),
        matches: z.array(noteSearchMatchSchema).max(3),
        uri: z.string(),
      })),
      count: z.number(),
      offset: z.number(),
      hasMore: z.boolean(),
      nextOffset: z.number().nullable(),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, async ({ query, tag, view, limit, offset }) => {
    try {
      const page = await client.search({ q: query, tag, view, limit, offset });
      const result = {
        notes: page.notes,
        count: page.notes.length,
        offset,
        hasMore: page.nextOffset !== null,
        nextOffset: page.nextOffset,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool('easynote_list_recent', {
    title: 'List Recent EasyNote Notes',
    description: 'List recently updated active or archived EasyNote notes as metadata, short excerpts and Resource URIs, optionally filtered by one exact tag.',
    inputSchema: z.object({
      limit: z.number().int().min(1).max(50).default(20),
      view: z.enum(['all', 'archive']).default('all').describe('all means active, non-archived notes; archive means archived notes.'),
      tag: z.string().max(40).default('').describe('Optional exact tag filter.'),
    }).strict(),
    outputSchema: z.object({
      notes: z.array(recentNoteSchema),
      count: z.number(),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, async ({ limit, view, tag }) => {
    try {
      const notes = (await recentNotes(client, view, limit, tag)).map(recentNote);
      const result = { notes, count: notes.length };
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool('easynote_read_note', {
    title: 'Read EasyNote Note',
    description: 'Read one EasyNote note by ID. Large Markdown bodies are returned in bounded character ranges; continue with nextOffset when truncated.',
    inputSchema: z.object({
      id: z.uuid().describe('Stable note ID returned by easynote_search_notes.'),
      offset: z.number().int().min(0).default(0).describe('Character offset in the Markdown body.'),
      limit: z.number().int().min(1).max(50_000).default(25_000).describe('Maximum Markdown characters to return.'),
    }).strict(),
    outputSchema: readNoteSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, async ({ id, offset, limit }) => {
    try {
      const note = (await client.note(id)).note;
      const content = note.content.slice(offset, offset + limit);
      const truncated = offset + content.length < note.content.length;
      const result = {
        note: noteMetadata(note),
        content,
        truncated,
        nextOffset: truncated ? offset + content.length : null,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool('easynote_read_notes', {
    title: 'Read Multiple EasyNote Notes',
    description: 'Read up to 20 EasyNote notes in one request, preserving the requested ID order. Each Markdown body is independently bounded; use easynote_read_note with nextOffset to continue a truncated note.',
    inputSchema: z.object({
      ids: z.array(z.uuid()).min(1).max(20).describe('Stable note IDs returned by easynote_search_notes.'),
      max_chars_per_note: z.number().int().min(1).max(25_000).default(12_000),
    }).strict(),
    outputSchema: z.object({
      notes: z.array(readNoteSchema),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, async ({ ids, max_chars_per_note }) => {
    try {
      const notes = (await client.notes(ids)).notes;
      const result = {
        notes: notes.map((note) => {
          const content = note.content.slice(0, max_chars_per_note);
          const truncated = content.length < note.content.length;
          return {
            note: noteMetadata(note),
            content,
            truncated,
            nextOffset: truncated ? content.length : null,
          };
        }),
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool('easynote_connection_status', {
    title: 'Get EasyNote Connection Status',
    description: 'Verify the configured EasyNote integration token and return its account, display name and access level.',
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({
      account: z.string(),
      integration: z.string(),
      access: z.enum(['read', 'read-write']),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, async () => {
    try {
      const result = await client.status();
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool('easynote_note_stats', {
    title: 'Count EasyNote Notes',
    description: 'Return exact database counts for active, archived, trashed, and total notes. Use active plus archived for the knowledge-base count; do not infer totals from paginated search results or Resources.',
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({
      active: z.number().int().nonnegative(),
      archived: z.number().int().nonnegative(),
      trash: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, async () => {
    try {
      const result = await client.stats();
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    } catch (error) {
      return toolError(error);
    }
  });

  const noteTemplate = new ResourceTemplate('easynote://notes/{id}.md', {
    list: async () => {
      const notes = (await Promise.all([
        recentNotes(client, 'all'),
        recentNotes(client, 'archive'),
      ])).flat().sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)).slice(0, 100);
      return {
        resources: notes.map((note) => ({
          uri: `easynote://notes/${note.id}.md`,
          name: note.title || 'Untitled note',
          description: `Revision ${note.revision}${note.tags.length ? `; tags: ${note.tags.join(', ')}` : ''}`,
          mimeType: 'text/markdown',
        })),
      };
    },
  });
  server.registerResource('easynote_note', noteTemplate, {
    title: 'EasyNote Note',
    description: 'A live EasyNote note represented as Markdown.',
    mimeType: 'text/markdown',
  }, async (uri, variables) => {
    const id = variables.id;
    if (typeof id !== 'string' || !idPattern.test(id)) throw new Error('The EasyNote resource URI has an invalid note ID.');
    const note = (await client.note(id)).note;
    return {
      contents: [{
        uri: uri.href,
        mimeType: 'text/markdown',
        text: resourceMarkdown(note),
      }],
    };
  });

  server.registerTool('easynote_list_folders', {
    title: 'List EasyNote Folders',
    description: 'List the complete EasyNote folder hierarchy with stable IDs, parent IDs and direct note counts.',
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({ folders: z.array(z.object({
      id: z.string(), name: z.string(), parentId: z.string().nullable(),
      createdAt: z.number(), updatedAt: z.number(), noteCount: z.number(),
    })) }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async () => {
    try {
      const result = await client.folders();
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
    } catch (error) { return toolError(error); }
  });

  if (status.access !== 'read-write') return server;

  server.registerTool('easynote_create_note', {
    title: 'Create EasyNote Note',
    description: 'Create one EasyNote note. This changes cloud data and may create a duplicate if called twice.',
    inputSchema: z.object({
      title: z.string().max(256).describe('Plain note title without a Markdown heading marker.'),
      content: z.string().describe('Markdown body. Use ## for top-level body sections.'),
      tags: z.array(z.string().min(1).max(40)).max(20).default([]),
      pinned: z.boolean().default(false),
      archived: z.boolean().default(false),
      folderId: z.uuid().nullable().default(null).describe('Optional destination folder ID from easynote_list_folders.'),
    }).strict(),
    outputSchema: noteResultSchema,
    annotations: writeAnnotations,
  }, async ({ title, content, tags, pinned, archived, folderId }) => {
    try {
      return await save(client, crypto.randomUUID(), {
        title,
        content,
        tags: [...new Set(tags)],
        pinned,
        quick: false,
        archived,
        folderId,
        deletedAt: null,
      }, 0);
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool('easynote_update_note', {
    title: 'Update EasyNote Note',
    description: 'Update selected fields of an existing active or archived note. expected_revision must match the latest read result; a stale revision returns a conflict instead of overwriting user changes.',
    inputSchema: z.object({
      id: z.uuid().describe('Stable note ID returned by easynote_search_notes or easynote_read_note.'),
      expected_revision: z.number().int().positive().describe('Current revision returned by easynote_read_note.'),
      title: z.string().max(256).optional(),
      content: z.string().optional(),
      tags: z.array(z.string().min(1).max(40)).max(20).optional(),
      pinned: z.boolean().optional(),
      archived: z.boolean().optional(),
      folderId: z.uuid().nullable().optional().describe('Move the note to this folder, or null for the root.'),
    }).strict().refine(({ title, content, tags, pinned, archived, folderId }) =>
      title !== undefined || content !== undefined || tags !== undefined || pinned !== undefined || archived !== undefined || folderId !== undefined,
    { message: 'At least one field must be supplied.' }),
    outputSchema: noteResultSchema,
    annotations: writeAnnotations,
  }, async ({ id, expected_revision, ...patch }) => {
    try {
      const current = (await client.note(id)).note;
      if (current.deletedAt !== null) throw new Error('The note is in trash. Restore it in EasyNote before editing.');
      const input = { ...noteInput(current), ...patch };
      if (patch.tags) input.tags = [...new Set(patch.tags)];
      return await save(client, id, input, expected_revision);
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool('easynote_create_folder', {
    title: 'Create EasyNote Folder',
    description: 'Create a folder at the root or inside another folder.',
    inputSchema: z.object({ name: z.string().min(1).max(120), parentId: z.uuid().nullable().default(null) }).strict(),
    annotations: writeAnnotations,
  }, async ({ name, parentId }) => {
    try {
      const result = await client.createFolder(name, parentId);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) { return toolError(error); }
  });

  server.registerTool('easynote_update_folder', {
    title: 'Rename or Move EasyNote Folder',
    description: 'Rename a folder or move it to another parent. Cycles and sibling name collisions are rejected.',
    inputSchema: z.object({ id: z.uuid(), name: z.string().min(1).max(120).optional(), parentId: z.uuid().nullable().optional() })
      .strict().refine(({ name, parentId }) => name !== undefined || parentId !== undefined, { message: 'Supply a name or parentId.' }),
    annotations: writeAnnotations,
  }, async ({ id, ...patch }) => {
    try {
      const result = await client.updateFolder(id, patch);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) { return toolError(error); }
  });

  server.registerTool('easynote_delete_folder', {
    title: 'Delete EasyNote Folder',
    description: 'Delete a folder tree. Notes inside it are preserved and moved to the root; completely blank notes move to trash.',
    inputSchema: z.object({ id: z.uuid() }).strict(),
    annotations: { ...writeAnnotations, destructiveHint: true },
  }, async ({ id }) => {
    try {
      const result = await client.deleteFolder(id);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) { return toolError(error); }
  });

  server.registerTool('easynote_archive_note', {
    title: 'Archive or Restore EasyNote Note',
    description: 'Move an active note into the archive or restore an archived note. expected_revision must match the latest read result.',
    inputSchema: z.object({
      id: z.uuid().describe('Stable note ID returned by easynote_search_notes or easynote_read_note.'),
      expected_revision: z.number().int().positive().describe('Current revision returned by easynote_read_note.'),
      archived: z.boolean().describe('True archives the note; false restores it to all notes.'),
    }).strict(),
    outputSchema: noteResultSchema,
    annotations: writeAnnotations,
  }, async ({ id, expected_revision, archived }) => {
    try {
      const current = (await client.note(id)).note;
      if (current.deletedAt !== null) throw new Error('The note is in trash and cannot be archived.');
      return await save(client, id, { ...noteInput(current), archived }, expected_revision);
    } catch (error) {
      return toolError(error);
    }
  });

  server.registerTool('easynote_trash_note', {
    title: 'Move EasyNote Note to Trash',
    description: 'Move one note to EasyNote trash. This never permanently deletes data. expected_revision must match the latest read result.',
    inputSchema: z.object({
      id: z.uuid().describe('Stable note ID returned by easynote_search_notes or easynote_read_note.'),
      expected_revision: z.number().int().positive().describe('Current revision returned by easynote_read_note.'),
    }).strict(),
    outputSchema: noteResultSchema,
    annotations: {
      ...writeAnnotations,
      destructiveHint: true,
    },
  }, async ({ id, expected_revision }) => {
    try {
      const current = (await client.note(id)).note;
      if (current.deletedAt !== null) throw new Error('The note is already in trash.');
      return await save(client, id, {
        ...noteInput(current),
        archived: false,
        deletedAt: Date.now(),
      }, expected_revision);
    } catch (error) {
      return toolError(error);
    }
  });

  return server;
}
