import type {
  Folder,
  FolderShare,
  ImageRecord,
  IntegrationToken,
  ManagedFolderShare,
  ManagedNoteShare,
  Note,
  NoteInput,
  NoteShare,
  NoteSummary,
  NoteTask,
  Session,
  SharedFolder,
  SharedNote,
  StoredFile,
  StorageStats,
  SyncChange,
  UserAccount,
  Version,
} from '../shared/types';

const API_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const clientId = crypto.randomUUID();
let csrf: string | null = null;
let unauthorizedHandler: (() => void) | null = null;
export function setSession(session: Session) { csrf = session.csrf; }
export function setUnauthorizedHandler(handler: (() => void) | null) { unauthorizedHandler = handler; }
export function noteEventsUrl(): string {
  const url = new URL('/api/events', window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('client', clientId);
  return url.href;
}

function handleUnauthorized(status: number, requestCsrf: string | null): void {
  if (status !== 401 || !requestCsrf || csrf !== requestCsrf) return;
  csrf = null;
  unauthorizedHandler?.();
}

async function timedFetch(
  path: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ response: Response; raw: string }> {
  const controller = init.signal ? null : new AbortController();
  let timedOut = false;
  const timer = controller ? setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs) : null;
  const method = init.method ?? 'GET';
  try {
    const response = await fetch(path, { ...init, signal: init.signal ?? controller!.signal });
    return { response, raw: await response.text() };
  } catch (error) {
    if (timedOut) throw new Error(`${method} ${path}\nRequest timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    if (init.signal?.aborted) throw error;
    throw new Error(`${method} ${path}\n${String(error)}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class ApiError extends Error {
  constructor(public status: number, public body: { error?: { message?: string; current?: Note } }, method: string, path: string) {
    super(`${method} ${path} [${status}]\n${JSON.stringify(body, null, 2)}`);
  }
}

export async function request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const requestCsrf = csrf;
  const { response, raw } = await timedFetch(path, {
    method, credentials: 'same-origin', signal,
    headers: {
      'X-EasyNote-Client': clientId,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(requestCsrf ? { 'X-CSRF-Token': requestCsrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, API_TIMEOUT_MS);
  handleUnauthorized(response.status, requestCsrf);
  let result;
  try { result = JSON.parse(raw); } catch { throw new Error(`${method} ${path} [${response.status}]\n${raw}`); }
  if (!response.ok) throw new ApiError(response.status, result, method, path);
  return result as T;
}

export const api = {
  session: () => request<Session>('/api/session'),
  login: (username: string, password: string) => request<Session>('/api/login', 'POST', { username, password }),
  register: (username: string, password: string) =>
    request<{ ok: true; pendingApproval: true; recoveryCode: string }>('/api/register', 'POST', { username, password }),
  resetPassword: (username: string, recoveryCode: string, newPassword: string) =>
    request<{ ok: true }>('/api/account/reset-password', 'POST', { username, recoveryCode, newPassword }),
  logout: () => request('/api/logout', 'POST', {}),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true; otherSessionsRevoked: true }>('/api/account/password', 'POST', { currentPassword, newPassword }),
  logoutAll: (currentPassword: string) =>
    request<{ ok: true }>('/api/account/logout-all', 'POST', { currentPassword }),
  createRecoveryCode: (currentPassword: string) =>
    request<{ recoveryCode: string }>('/api/account/recovery-code', 'POST', { currentPassword }),
  deleteAccount: (username: string, currentPassword: string) =>
    request<{ ok: true }>('/api/account', 'DELETE', { username, currentPassword }),
  users: () => request<{ users: UserAccount[] }>('/api/admin/users'),
  createUser: (username: string, password: string, role: UserAccount['role']) =>
    request<{ user: UserAccount }>('/api/admin/users', 'POST', { username, password, role }),
  updateUser: (id: string, patch: Partial<Pick<UserAccount, 'username' | 'role' | 'enabled'>> & { password?: string }) =>
    request<{ user: UserAccount; signedOut: boolean }>(`/api/admin/users/${id}`, 'PATCH', patch),
  deleteUser: (id: string) => request<{ ok: true }>(`/api/admin/users/${id}`, 'DELETE', {}),
  setRegistration: (enabled: boolean) =>
    request<{ registrationEnabled: boolean }>('/api/admin/settings/registration', 'PATCH', { enabled }),
  list: (query: { q?: string; view?: string; tag?: string; folderId?: string; offset?: number } = {}, signal?: AbortSignal) =>
    request<{ notes: NoteSummary[]; nextOffset: number | null }>(`/api/notes?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))}`, 'GET', undefined, signal),
  tags: (view: string, signal?: AbortSignal) =>
    request<{ tags: string[]; counts: Record<string, number> }>(`/api/tags?${new URLSearchParams({ view })}`, 'GET', undefined, signal),
  blank: (folderId: string | null = null) => request<{ note: Note | null }>(`/api/notes/blank?folderId=${folderId ?? 'root'}`),
  folders: (signal?: AbortSignal) => request<{ folders: Folder[] }>('/api/folders', 'GET', undefined, signal),
  createFolder: (name: string, parentId: string | null) =>
    request<{ folder: Folder }>('/api/folders', 'POST', { id: crypto.randomUUID(), name, parentId }),
  updateFolder: (id: string, patch: { name?: string; parentId?: string | null }) =>
    request<{ folder: Folder }>(`/api/folders/${id}`, 'PATCH', patch),
  mergeFolder: (id: string, targetId: string) =>
    request<{ ok: true; movedNotes: number; movedFolders: number }>(`/api/folders/${id}/merge`, 'POST', { targetId }),
  deleteFolder: (id: string) => request<{ ok: true; movedNotes: number }>(`/api/folders/${id}`, 'DELETE', {}),
  duplicates: (fingerprints: string[]) =>
    request<{ matches: Array<{ fingerprint: string; noteId: string }> }>('/api/notes/duplicates', 'POST', { fingerprints }),
  note: (id: string, signal?: AbortSignal) => request<{ note: Note }>(`/api/notes/${id}`, 'GET', undefined, signal),
  save: (id: string, input: NoteInput, revision: number, operationId: string, createVersion = false) =>
    request<{ note: Note; unchanged?: boolean }>(`/api/notes/${id}`, revision === 0 ? 'POST' : 'PUT', {
      ...input, revision, operationId, createVersion,
    }),
  purge: (note: Note) => request(`/api/notes/${note.id}`, 'DELETE', { revision: note.revision }),
  purgeTrash: () => request<{ deleted: number }>('/api/notes/trash', 'DELETE', {}),
  versions: (id: string) => request<{ versions: Version[] }>(`/api/notes/${id}/versions`),
  backlinks: (id: string) => request<{ notes: NoteSummary[] }>(`/api/notes/${id}/backlinks`),
  tasks: () => request<{ tasks: NoteTask[] }>('/api/tasks'),
  shares: () => request<{ shares: ManagedNoteShare[]; folderShares: ManagedFolderShare[] }>('/api/shares'),
  noteShares: () => request<{ shares: ManagedNoteShare[]; folderShares: ManagedFolderShare[] }>('/api/shares'),
  noteShare: (id: string) => request<{ share: NoteShare | null }>(`/api/notes/${id}/share`),
  createNoteShare: (id: string, expiresInHours: number | null) =>
    request<{ share: NoteShare; url: string }>(`/api/notes/${id}/share`, 'POST', { expiresInHours }),
  extendNoteShare: (id: string, expiresInHours: number | null) =>
    request<{ share: NoteShare }>(`/api/notes/${id}/share`, 'PATCH', { expiresInHours }),
  revokeNoteShare: (id: string) => request<{ ok: true }>(`/api/notes/${id}/share`, 'DELETE', {}),
  folderShare: (id: string) => request<{ share: FolderShare | null }>(`/api/folders/${id}/share`),
  createFolderShare: (id: string, expiresInHours: number | null) =>
    request<{ share: FolderShare; url: string }>(`/api/folders/${id}/share`, 'POST', { expiresInHours }),
  extendFolderShare: (id: string, expiresInHours: number | null) =>
    request<{ share: FolderShare }>(`/api/folders/${id}/share`, 'PATCH', { expiresInHours }),
  revokeFolderShare: (id: string) => request<{ ok: true }>(`/api/folders/${id}/share`, 'DELETE', {}),
  sharedNote: (shareToken: string) =>
    request<{ note: SharedNote }>(`/api/public/shares/${shareToken}`),
  sharedItem: (shareToken: string) =>
    request<{ note?: SharedNote; folder?: SharedFolder }>(`/api/public/shares/${shareToken}`),
  sync: (after: number, signal?: AbortSignal) =>
    request<{ changes: SyncChange[]; cursor: number; hasMore: boolean }>(`/api/sync?after=${after}&limit=200`, 'GET', undefined, signal),
  syncHead: (signal?: AbortSignal) =>
    request<{ cursor: number }>('/api/sync/cursor', 'GET', undefined, signal),
  integrationTokens: () => request<{ tokens: IntegrationToken[] }>('/api/integrations/tokens'),
  createIntegrationToken: (name: string, access: IntegrationToken['access'], expiresInDays: number | null) =>
    request<{ token: IntegrationToken; secret: string }>('/api/integrations/tokens', 'POST', { name, access, expiresInDays }),
  revokeIntegrationToken: (id: string) => request(`/api/integrations/tokens/${encodeURIComponent(id)}`, 'DELETE', {}),
  storage: () => request<StorageStats>('/api/storage'),
};

async function uploadStoredFile<T extends 'image' | 'file'>(
  file: File,
  route: T,
  maxBytes: number,
  onProgress?: (loaded: number, total: number) => void,
): Promise<T extends 'image' ? ImageRecord : StoredFile> {
  if (file.size > maxBytes) throw new Error(`文件不能超过 ${Math.round(maxBytes / 1024 ** 2)} MiB。`);
  const path = `/api/${route === 'image' ? 'images' : 'files'}/${crypto.randomUUID()}`;
  const requestCsrf = csrf;

  if (typeof XMLHttpRequest !== 'undefined') {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', path);
      xhr.timeout = UPLOAD_TIMEOUT_MS;
      xhr.withCredentials = true;
      xhr.setRequestHeader('Content-Type', file.type);
      xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
      xhr.setRequestHeader('X-CSRF-Token', requestCsrf ?? '');
      xhr.setRequestHeader('X-EasyNote-Client', clientId);

      if (xhr.upload && onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(e.loaded, e.total);
        };
      }

      xhr.onload = () => {
        handleUnauthorized(xhr.status, requestCsrf);
        let body: any;
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          return reject(new Error(`PUT ${path} [${xhr.status}]\n${xhr.responseText}`));
        }
        if (xhr.status < 200 || xhr.status >= 300) {
          return reject(new ApiError(xhr.status, body, 'PUT', path));
        }
        resolve(body[route] as T extends 'image' ? ImageRecord : StoredFile);
      };

      xhr.onerror = () => reject(new Error('Network error during file upload'));
      xhr.ontimeout = () => reject(new Error('Upload request timed out'));
      xhr.send(file);
    });
  }

  const { response, raw } = await timedFetch(path, {
    method: 'PUT', credentials: 'same-origin',
    headers: {
      'Content-Type': file.type,
      'X-Filename': encodeURIComponent(file.name),
      'X-CSRF-Token': requestCsrf ?? '',
      'X-EasyNote-Client': clientId,
    },
    body: file,
  }, UPLOAD_TIMEOUT_MS);
  handleUnauthorized(response.status, requestCsrf);
  let body;
  try { body = JSON.parse(raw); } catch { throw new Error(`PUT ${path} [${response.status}]\n${raw}`); }
  if (!response.ok) throw new ApiError(response.status, body, 'PUT', path);
  return body[route] as T extends 'image' ? ImageRecord : StoredFile;
}

export async function uploadImage(file: File, maxBytes: number, maxPixels: number, onProgress?: (loaded: number, total: number) => void): Promise<ImageRecord> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('仅支持 JPEG、PNG、WebP 图片。');
  if (file.size > maxBytes) throw new Error(`图片不能超过 ${Math.round(maxBytes / 1024 ** 2)} MiB。`);
  const bitmap = await createImageBitmap(file);
  const pixels = bitmap.width * bitmap.height;
  bitmap.close();
  if (pixels > maxPixels) throw new Error('图片尺寸超过限制。');
  return uploadStoredFile(file, 'image', maxBytes, onProgress);
}

export async function uploadAttachment(file: File, maxBytes: number, onProgress?: (loaded: number, total: number) => void): Promise<StoredFile> {
  const allowed = new Set(['application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/json']);
  const extension = file.name.toLocaleLowerCase().split('.').pop() ?? '';
  const inferred = ({ pdf: 'application/pdf', md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', json: 'application/json' } as Record<string, string>)[extension];
  const mime = allowed.has(file.type) ? file.type : inferred;
  if (!mime) throw new Error('仅支持 PDF、Markdown、TXT、CSV 和 JSON 附件。');
  const normalized = file.type === mime ? file : new File([file], file.name, { type: mime });
  if (normalized.size > maxBytes) throw new Error(`附件不能超过 ${Math.round(maxBytes / 1024 ** 2)} MiB。`);
  return uploadStoredFile(normalized, 'file', maxBytes, onProgress);
}
