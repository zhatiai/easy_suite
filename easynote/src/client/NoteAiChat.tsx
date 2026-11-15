import { memo, useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Send, Sparkles, Square, UserRound, X } from 'lucide-react';
import { askLlm, type LlmMessage } from './api';
import { loadLlmConfig } from './drafts';
import { Preview } from './Editor';
import { t } from './i18n';

interface Props {
  userId: string;
  text: string;
  context?: string;
  dark?: boolean;
  onClose(): void;
  onConfigure(): void;
}

const ignoreImage = () => {};
const Answer = memo(function Answer({ content, streaming, dark }: { content: string; streaming: boolean; dark: boolean }) {
  return <Preview content={content} streaming={streaming} embedDocuments={false} dark={dark} onImage={ignoreImage} />;
});

export function NoteAiChat({ userId, text, context, dark = false, onClose, onConfigure }: Props) {
  const [messages, setMessages] = useState<LlmMessage[]>([]);
  const [question, setQuestion] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [composerCollapsed, setComposerCollapsed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stopped, setStopped] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const controller = useRef<AbortController | null>(null);
  const retry = useRef<{ history: LlmMessage[]; context: string } | null>(null);
  const followOutput = useRef(true);
  const output = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const keyboardHintId = useId();
  const composerId = useId();
  const fullNote = context === undefined;
  const config = loadLlmConfig(userId);
  const configured = !!(config.baseURL && config.model && config.apiKey);

  async function send(history: LlmMessage[], noteContext: string) {
    if (controller.current || !navigator.onLine) return;
    const request = new AbortController();
    controller.current = request;
    retry.current = { history, context: noteContext };
    followOutput.current = true;
    setMessages(history);
    setBusy(true); setError(''); setStopped(false);
    let answer = '';
    let frame = 0;
    const publish = () => {
      frame = 0;
      if (controller.current === request && answer) setMessages([...history, { role: 'assistant', content: answer }]);
    };
    // Release the UI immediately even if the provider stream takes time to close.
    const stop = () => {
      cancelAnimationFrame(frame);
      if (controller.current !== request) return;
      publish();
      controller.current = null;
      setBusy(false); setStopped(true);
    };
    request.signal.addEventListener('abort', stop, { once: true });
    try {
      await askLlm(loadLlmConfig(userId), noteContext, history, request.signal, (value) => {
        if (controller.current !== request || request.signal.aborted) return;
        answer = value;
        if (!frame) frame = requestAnimationFrame(publish);
      });
    } catch (failure) {
      if (controller.current === request && !request.signal.aborted) setError(failure instanceof Error ? failure.message : t('llm_request_error'));
    } finally {
      cancelAnimationFrame(frame);
      request.signal.removeEventListener('abort', stop);
      if (controller.current === request) {
        publish();
        controller.current = null;
        setBusy(false);
        setStopped(request.signal.aborted);
      }
    }
  }

  function submit() {
    if (!question.trim() || busy || controller.current || !navigator.onLine) return;
    const history: LlmMessage[] = [...messages, { role: 'user', content: question.trim() }];
    setQuestion('');
    void send(history, expanded && context !== undefined ? context : text);
  }

  useEffect(() => () => {
    const request = controller.current;
    controller.current = null;
    request?.abort();
  }, []);
  useEffect(() => { if (configured) input.current?.focus({ preventScroll: true }); }, [configured]);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  useEffect(() => {
    if (followOutput.current) output.current?.scrollTo(0, output.current.scrollHeight);
  }, [messages, busy, error, stopped]);

  return <div className={`note-ai-chat ${fullNote ? 'full-note-chat' : 'inline-note-chat'}`} role="region" aria-label={t(fullNote ? 'llm_chat' : 'llm_selection_chat')}>
    <header><strong><Sparkles size={15} />{t(fullNote ? 'llm_chat' : 'llm_ask_short')}</strong>
      <button className="icon-button" aria-label={t('llm_close')} onClick={onClose}><X size={16} /></button></header>
    {!configured ? <div className="llm-empty"><p>{t('llm_not_configured')}</p><button onClick={onConfigure}>{t('llm_configure')}</button></div> : <>
      {fullNote ? <p className="llm-hint">{t('llm_full_hint')}</p>
        : <div className="llm-selection-preview" title={text}>{text}</div>}
      <div className="llm-messages" ref={output} role="log" aria-live="polite" aria-busy={busy} onScroll={(event) => {
        const element = event.currentTarget;
        followOutput.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
      }}>
        {!messages.length && <p className="llm-chat-empty">{t('llm_start_hint')}</p>}
        {messages.map((message, index) => <div className={`llm-message ${message.role}`} key={index}>
          <strong>{message.role === 'user' ? <UserRound size={13} /> : <Sparkles size={13} />}{t(message.role === 'user' ? 'llm_you' : 'llm_assistant')}</strong>
          {message.role === 'assistant'
            ? <div className="llm-answer"><Answer content={message.content} streaming={busy && index === messages.length - 1} dark={dark} /></div>
            : <div>{message.content}</div>}
        </div>)}
        {busy && <p className="llm-chat-status" role="status">{t('llm_thinking')}</p>}
        {stopped && <p className="llm-chat-status" role="status">{t('llm_stopped')}</p>}
      </div>
      {(error || stopped) && <div className={error ? 'llm-error' : 'llm-retry'} role={error ? 'alert' : undefined}>
        {error}<button type="button" disabled={busy || !online} onClick={() => {
          if (retry.current) void send(retry.current.history, retry.current.context);
        }}>{t(error ? 'retry' : 'llm_regenerate')}</button>
      </div>}
      <form className={composerCollapsed ? 'composer-collapsed' : undefined} onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <div className="llm-composer-toolbar">
          <button type="button" className="llm-composer-toggle" aria-expanded={!composerCollapsed} aria-controls={composerId}
            onClick={() => {
              setComposerCollapsed(!composerCollapsed);
              if (composerCollapsed) requestAnimationFrame(() => input.current?.focus({ preventScroll: true }));
            }}>
            {composerCollapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            {t(composerCollapsed ? 'llm_expand_input' : 'llm_collapse_input')}
          </button>
          {composerCollapsed && busy && <button type="button" className="icon-button" aria-label={t('llm_stop')}
            onClick={() => controller.current?.abort()}><Square size={15} /></button>}
        </div>
        <div id={composerId} className="llm-composer-body" hidden={composerCollapsed}>
        <div className="llm-composer">
          <textarea ref={input} aria-label={t('llm_question')} aria-describedby={keyboardHintId} placeholder={t(messages.length ? 'llm_followup' : 'llm_question')}
            rows={3} value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
                event.preventDefault(); submit();
              }
            }} />
          {busy
            ? <button key="stop" type="button" className="llm-send-button icon-button" aria-label={t('llm_stop')} title={t('llm_stop')}
                onClick={(event) => { event.preventDefault(); controller.current?.abort(); }}><Square size={17} /></button>
            : <button key="send" className="llm-send-button icon-button" type="submit" aria-label={t('llm_send')} title={t('llm_send')}
                disabled={!question.trim() || !online}><Send size={18} /></button>}
        </div>
        <p className="llm-hint" id={keyboardHintId}>{t('llm_keyboard_hint')}</p>
        {!fullNote && <label className="llm-context-toggle" title={t('llm_selection_hint')}>
          <input type="checkbox" checked={expanded} disabled={busy} onChange={(event) => setExpanded(event.target.checked)} />
          {t('llm_send_context')}
        </label>}
        {!online && <p role="status">{t('llm_offline')}</p>}
        </div>
      </form>
    </>}
  </div>;
}
