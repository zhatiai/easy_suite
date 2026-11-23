import type { Folder, IntegrationNoteSummary, Note, NoteInput, NoteLinkDirection, NoteLinkPage, WhiteboardFile } from '../shared/types.js';

export interface BridgeConfig {
  url: string;
  token: string;
}

export interface IntegrationStatus {
  account: string;
  integration: string;
  access: 'read' | 'read-write';
}

export interface NoteStats {
  active: number;
  archived: number;
  trash: number;
  total: number;
}

export interface SearchPage {
  notes: IntegrationNoteSummary[];
  nextOffset: number | null;
}

export class BridgeApiError extends Error {
  constructor(
    public status: number,
    public method: string,
    public path: string,
    public responseBody: string,
  ) {
    super(`${method} ${path} [${status}]\n${responseBody}`);
  }
}

export function validateServerUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('EasyNote URL must be an absolute URL.');
  }
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !local) throw new Error('EasyNote URL must use HTTPS, except for a loopback development server.');
  if (url.username || url.password || url.search || url.hash) throw new Error('EasyNote URL must not include credentials, query parameters, or a fragment.');
  return url.href.replace(/\/+$/, '');
}

export class EasyNoteClient {
  readonly baseUrl: string;

  constructor(private config: BridgeConfig, private request: typeof fetch = fetch) {
    this.baseUrl = validateServerUrl(config.url);
    if (!/^enai_[a-f0-9]{64}$/.test(config.token)) throw new Error('The integration token has an invalid format.');
  }

  private async fetch(path: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const method = init.method ?? 'GET';
    try {
      const response = await this.request(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.config.token}`,
          ...init.headers,
        },
      });
      if (!response.ok) throw new BridgeApiError(response.status, method, path, await response.text());
      return response;
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`${method} ${path}\nRequest timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async json<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await this.fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new Error(`${method} ${path} [${response.status}]\n${raw}`);
    }
  }

  status(): Promise<IntegrationStatus> {
    return this.json('/api/integrations/status');
  }

  stats(): Promise<NoteStats> {
    return this.json('/api/integrations/stats');
  }

  search(query: {
    q?: string;
    view?: 'all' | 'archive' | 'any';
    tag?: string;
    sort?: 'default' | 'updated';
    offset?: number;
    limit?: number;
    folderId?: string;
  }): Promise<SearchPage> {
    const parameters = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') parameters.set(key, String(value));
    }
    return this.json(`/api/integrations/notes?${parameters}`);
  }

  note(id: string): Promise<{ note: Note }> {
    return this.json(`/api/integrations/notes/${encodeURIComponent(id)}`);
  }

  notes(ids: string[]): Promise<{ notes: Note[] }> {
    const parameters = new URLSearchParams({ ids: ids.join(',') });
    return this.json(`/api/integrations/notes/batch?${parameters}`);
  }

  links(id: string, direction: NoteLinkDirection, offset: number, limit: number): Promise<NoteLinkPage> {
    return this.json(`/api/integrations/notes/${encodeURIComponent(id)}/links?${new URLSearchParams({ direction, offset: String(offset), limit: String(limit) })}`);
  }

  save(id: string, input: NoteInput, revision: number, operationId: string, linkedNoteIds: string[] = []): Promise<{ note: Note; unchanged?: boolean }> {
    return this.json(`/api/integrations/notes/${encodeURIComponent(id)}`, revision === 0 ? 'POST' : 'PUT', {
      ...input,
      revision,
      operationId,
      createVersion: true,
      ...(linkedNoteIds.length ? { linkedNoteIds } : {}),
    });
  }

  folders(): Promise<{ folders: Folder[] }> {
    return this.json('/api/integrations/folders');
  }

  createFolder(name: string, parentId: string | null, description = ''): Promise<{ folder: Folder }> {
    return this.json('/api/integrations/folders', 'POST', { id: crypto.randomUUID(), name, parentId, description });
  }

  updateFolder(id: string, patch: { name?: string; parentId?: string | null; description?: string }): Promise<{ folder: Folder }> {
    return this.json(`/api/integrations/folders/${encodeURIComponent(id)}`, 'PATCH', patch);
  }

  deleteFolder(id: string): Promise<{ ok: true; movedNotes: number }> {
    return this.json(`/api/integrations/folders/${encodeURIComponent(id)}`, 'DELETE', {});
  }

  whiteboards(): Promise<{ boards: WhiteboardFile[] }> {
    return this.json('/api/integrations/whiteboards');
  }

  async whiteboard(id: string): Promise<{ board: WhiteboardFile; scene: unknown }> {
    const response = await this.fetch(`/api/integrations/whiteboards/${encodeURIComponent(id)}`);
    const name = decodeURIComponent(response.headers.get('X-Whiteboard-Name') ?? '');
    const revision = Number(response.headers.get('X-Whiteboard-Revision'));
    if (!name || !Number.isSafeInteger(revision) || revision < 1) throw new Error('Invalid whiteboard response.');
    return {
      board: { id, name, revision, folderId: response.headers.get('X-Whiteboard-Folder') || null },
      scene: await response.json(),
    };
  }

  saveWhiteboard(board: WhiteboardFile, scene: unknown): Promise<WhiteboardFile> {
    const { id, ...metadata } = board;
    return this.json(`/api/integrations/whiteboards/${encodeURIComponent(id)}`, 'PUT', { ...metadata, scene });
  }

}
