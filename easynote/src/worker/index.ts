import { ApiError, json, localHttp, type Env } from './core';

export { NoteEvents } from './events';
export { ServerTransfer } from './serverTransfer';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const dynamic = url.pathname.startsWith('/api/') || url.pathname === '/mcp' ||
      url.pathname.startsWith('/oauth/') || url.pathname.startsWith('/.well-known/');
    if (!dynamic) return env.ASSETS.fetch(request);
    if (url.protocol !== 'https:' && request.headers.get('x-forwarded-proto') !== 'https' && !localHttp(request, env)) {
      return json({ error: { message: 'HTTPS is required.' } }, 403);
    }
    try {
      return await env.SERVER_TRANSFER.getByName('instance').fetch(request);
    } catch (error) {
      if (error instanceof ApiError) return json({ error: { message: error.message } }, error.status);
      return json({ error: { message: 'Server temporarily unavailable.' } }, 503);
    }
  },
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const response = await env.SERVER_TRANSFER.getByName('instance').fetch('https://internal/__cleanup');
    if (!response.ok) throw new Error('Scheduled cleanup failed.');
  },
} satisfies ExportedHandler<Env>;
