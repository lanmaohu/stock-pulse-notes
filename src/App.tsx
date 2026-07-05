import {
  BookOpenText,
  Bot,
  Check,
  Clock3,
  FileText,
  Lightbulb,
  LogOut,
  MessageSquareText,
  NotebookPen,
  Pin,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  Tag,
  Trash2,
  X
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatMessage,
  ChatMessagesResponse,
  DailySummariesResponse,
  DailySummary,
  LoginResponse,
  Note,
  NoteInput,
  NotesResponse,
  ResearchSuggestion,
  ResearchSuggestionsResponse
} from "../shared/types";

type SaveState = "idle" | "saving" | "saved" | "error";
type Tab = "overview" | "notes" | "chat" | "summaries" | "suggestions";

const tokenKey = "stockpulse.token";
const emptyDraft: NoteInput = { title: "", content: "", tags: [], pinned: false };

async function api<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers
    }
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "请求失败");
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function todayShanghai() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function parseTags(value: string) {
  return Array.from(
    new Set(
      value
        .split(/[,，\s]+/)
        .map((tag) => tag.trim())
        .filter(Boolean)
    )
  );
}

function TextList({ items, empty }: { items: string[]; empty: string }) {
  if (!items.length) {
    return <p className="muted">{empty}</p>;
  }
  return (
    <ul className="text-list">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

export function App() {
  const [token, setToken] = useState(() => localStorage.getItem(tokenKey) ?? "");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [tab, setTab] = useState<Tab>("overview");
  const [notes, setNotes] = useState<Note[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [summaries, setSummaries] = useState<DailySummary[]>([]);
  const [suggestions, setSuggestions] = useState<ResearchSuggestion[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<NoteInput>(emptyDraft);
  const [query, setQuery] = useState("");
  const [tagText, setTagText] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [appError, setAppError] = useState("");
  const [summaryDate, setSummaryDate] = useState(todayShanghai());
  const [summaryBusy, setSummaryBusy] = useState(false);
  const saveTimer = useRef<number | null>(null);
  const isNewDraft = selectedId === "new";

  const latestSummary = summaries[0];
  const selectedNote = useMemo(() => notes.find((note) => note.id === selectedId) ?? null, [notes, selectedId]);

  const filteredNotes = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) {
      return notes;
    }
    return notes.filter((note) => {
      const haystack = [note.title, note.content, ...note.tags].join(" ").toLowerCase();
      return haystack.includes(term);
    });
  }, [notes, query]);

  const loadWorkspace = useCallback(async () => {
    if (!token) {
      return;
    }
    try {
      const [notesData, messagesData, summariesData, suggestionsData] = await Promise.all([
        api<NotesResponse>("/api/notes", {}, token),
        api<ChatMessagesResponse>("/api/chat-messages", {}, token),
        api<DailySummariesResponse>("/api/daily-summaries", {}, token),
        api<ResearchSuggestionsResponse>("/api/research-suggestions", {}, token)
      ]);
      setNotes(notesData.notes);
      setMessages(messagesData.messages);
      setSummaries(summariesData.summaries);
      setSuggestions(suggestionsData.suggestions);
      setSelectedId((current) => current ?? notesData.notes[0]?.id ?? "new");
      setAppError("");
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法加载工作台";
      setAppError(message);
      if (message === "Unauthorized.") {
        localStorage.removeItem(tokenKey);
        setToken("");
      }
    }
  }, [token]);

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  useEffect(() => {
    if (selectedNote) {
      setDraft({
        title: selectedNote.title,
        content: selectedNote.content,
        tags: selectedNote.tags,
        pinned: selectedNote.pinned
      });
      setTagText(selectedNote.tags.join(", "));
      setSaveState("idle");
      return;
    }

    if (isNewDraft) {
      setDraft(emptyDraft);
      setTagText("");
      setSaveState("idle");
    }
  }, [isNewDraft, selectedNote]);

  useEffect(() => {
    if (!token || !selectedId || saveState === "saving") {
      return;
    }

    if (!isNewDraft && !selectedNote) {
      return;
    }

    const title = draft.title?.trim() ?? "";
    const content = draft.content ?? "";
    const hasContent = Boolean(title || content || draft.tags?.length);
    if (isNewDraft && !hasContent) {
      return;
    }

    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
    }

    setSaveState("saving");
    saveTimer.current = window.setTimeout(async () => {
      try {
        const payload = {
          ...draft,
          tags: parseTags(tagText)
        };
        const note = isNewDraft
          ? await api<Note>("/api/notes", { method: "POST", body: JSON.stringify(payload) }, token)
          : await api<Note>(`/api/notes/${selectedId}`, { method: "PUT", body: JSON.stringify(payload) }, token);

        setNotes((current) => {
          const without = current.filter((item) => item.id !== note.id);
          return [note, ...without].sort(
            (a, b) => Number(b.pinned) - Number(a.pinned) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
          );
        });
        if (isNewDraft) {
          setSelectedId(note.id);
        }
        setSaveState("saved");
      } catch (error) {
        setSaveState("error");
        setAppError(error instanceof Error ? error.message : "保存失败");
      }
    }, 650);

    return () => {
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current);
      }
    };
  }, [draft, isNewDraft, saveState, selectedId, selectedNote, tagText, token]);

  async function handleLogin(event: FormEvent) {
    event.preventDefault();
    setLoginError("");
    try {
      const result = await api<LoginResponse>("/api/login", {
        method: "POST",
        body: JSON.stringify({ password })
      });
      localStorage.setItem(tokenKey, result.token);
      setToken(result.token);
      setPassword("");
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "登录失败");
    }
  }

  async function deleteSelected() {
    if (!selectedId || selectedId === "new") {
      setSelectedId(notes[0]?.id ?? "new");
      return;
    }
    const note = notes.find((item) => item.id === selectedId);
    if (!note || !confirm(`删除「${note.title}」？`)) {
      return;
    }
    await api<void>(`/api/notes/${selectedId}`, { method: "DELETE" }, token);
    const next = notes.filter((item) => item.id !== selectedId);
    setNotes(next);
    setSelectedId(next[0]?.id ?? "new");
  }

  async function triggerSummary() {
    setSummaryBusy(true);
    setAppError("");
    try {
      await api<DailySummary>(`/api/ai/summarize/${summaryDate}?regenerate=true`, { method: "POST" }, token);
      await loadWorkspace();
      setTab("summaries");
    } catch (error) {
      setAppError(error instanceof Error ? error.message : "总结失败");
    } finally {
      setSummaryBusy(false);
    }
  }

  function logout() {
    localStorage.removeItem(tokenKey);
    setToken("");
    setNotes([]);
    setSelectedId(null);
  }

  if (!token) {
    return (
      <main className="login-shell">
        <section className="login-panel">
          <div className="brand-mark">
            <NotebookPen size={26} />
          </div>
          <h1>Stockpulse</h1>
          <p>进入你的个人投研日志工作台</p>
          <form onSubmit={handleLogin}>
            <label htmlFor="password">访问密码</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoFocus
              placeholder="输入密码"
            />
            {loginError ? <div className="error-text">{loginError}</div> : null}
            <button className="primary-button" type="submit">
              登录
            </button>
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="research-shell">
      <header className="topbar">
        <div>
          <span className="eyebrow">Stockpulse</span>
          <h1>投资研究日志</h1>
        </div>
        <div className="topbar-actions">
          <button className="ghost-button" onClick={() => void loadWorkspace()}>
            <RefreshCw size={17} />
            刷新
          </button>
          <button className="icon-button" onClick={logout} title="退出登录">
            <LogOut size={18} />
          </button>
        </div>
      </header>

      {appError ? <div className="banner-error">{appError}</div> : null}

      <nav className="tabs">
        <button className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}>
          <BookOpenText size={17} />
          总览
        </button>
        <button className={tab === "notes" ? "active" : ""} onClick={() => setTab("notes")}>
          <FileText size={17} />
          笔记
        </button>
        <button className={tab === "chat" ? "active" : ""} onClick={() => setTab("chat")}>
          <MessageSquareText size={17} />
          聊天归档
        </button>
        <button className={tab === "summaries" ? "active" : ""} onClick={() => setTab("summaries")}>
          <Sparkles size={17} />
          每日洞察
        </button>
        <button className={tab === "suggestions" ? "active" : ""} onClick={() => setTab("suggestions")}>
          <Lightbulb size={17} />
          研究建议
        </button>
      </nav>

      {tab === "overview" ? (
        <section className="overview-grid">
          <article className="summary-panel">
            <div className="panel-title">
              <Sparkles size={19} />
              最近每日洞察
            </div>
            {latestSummary ? (
              <>
                <div className="summary-date">{latestSummary.date}</div>
                <TextList items={latestSummary.coreViews} empty="暂无核心观点" />
                <div className="disclaimer">
                  <ShieldAlert size={16} />
                  {latestSummary.disclaimer}
                </div>
              </>
            ) : (
              <p className="muted">还没有每日洞察。可以先同步聊天记录，或手动触发一次总结。</p>
            )}
          </article>

          <article className="summary-panel">
            <div className="panel-title">
              <Bot size={19} />
              手动总结
            </div>
            <div className="summary-trigger">
              <input type="date" value={summaryDate} onChange={(event) => setSummaryDate(event.target.value)} />
              <button className="primary-button compact" onClick={() => void triggerSummary()} disabled={summaryBusy}>
                {summaryBusy ? "总结中" : "生成洞察"}
              </button>
            </div>
            <p className="muted">定时任务默认每天凌晨 01:00 自动总结当天聊天和笔记。</p>
          </article>

          <article className="metric-strip">
            <div>
              <strong>{notes.length}</strong>
              <span>笔记</span>
            </div>
            <div>
              <strong>{messages.length}</strong>
              <span>聊天</span>
            </div>
            <div>
              <strong>{summaries.length}</strong>
              <span>总结</span>
            </div>
            <div>
              <strong>{suggestions.length}</strong>
              <span>建议</span>
            </div>
          </article>
        </section>
      ) : null}

      {tab === "notes" ? (
        <section className="notes-workspace">
          <aside className="note-sidebar">
            <div className="search-box">
              <Search size={17} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、正文或标签" />
              {query ? (
                <button className="clear-button" onClick={() => setQuery("")} title="清空搜索">
                  <X size={16} />
                </button>
              ) : null}
            </div>
            <button className="new-button" onClick={() => setSelectedId("new")}>
              <Plus size={18} />
              新建笔记
            </button>
            <div className="note-list">
              {filteredNotes.map((note) => (
                <button
                  className={`note-item ${note.id === selectedId ? "active" : ""}`}
                  key={note.id}
                  onClick={() => setSelectedId(note.id)}
                >
                  <div className="note-row">
                    <strong>{note.title}</strong>
                    {note.pinned ? <Pin size={14} /> : null}
                  </div>
                  <p>{note.content || "无正文"}</p>
                  <div className="note-meta">
                    <Clock3 size={13} />
                    {formatDate(note.updatedAt)}
                  </div>
                </button>
              ))}
              {!filteredNotes.length ? <div className="empty-list">没有匹配的笔记</div> : null}
            </div>
          </aside>

          <section className="editor">
            <div className="editor-toolbar">
              <button
                className={`toggle-button ${draft.pinned ? "active" : ""}`}
                onClick={() => setDraft((current) => ({ ...current, pinned: !current.pinned }))}
                title="置顶"
              >
                <Pin size={17} />
                置顶
              </button>
              <button className="icon-button danger" onClick={() => void deleteSelected()} title="删除笔记">
                <Trash2 size={18} />
              </button>
              <span className={`save-state ${saveState}`}>
                {saveState === "saving" ? "保存中" : saveState === "saved" ? "已保存" : saveState === "error" ? "保存失败" : "就绪"}
                {saveState === "saved" ? <Check size={15} /> : null}
              </span>
            </div>
            <input
              className="title-input"
              value={draft.title ?? ""}
              onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
              placeholder="笔记标题"
            />
            <div className="tag-input">
              <Tag size={17} />
              <input
                value={tagText}
                onChange={(event) => {
                  setTagText(event.target.value);
                  setDraft((current) => ({ ...current, tags: parseTags(event.target.value) }));
                }}
                placeholder="标签，用空格或逗号分隔"
              />
            </div>
            <textarea
              className="content-input"
              value={draft.content ?? ""}
              onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))}
              placeholder="写下市场观察、交易复盘、想法或待办..."
            />
          </section>
        </section>
      ) : null}

      {tab === "chat" ? (
        <section className="feed-list">
          {messages.map((message) => (
            <article className="feed-item" key={message.id}>
              <div className="feed-meta">
                <strong>{message.sender}</strong>
                <span>{message.source}</span>
                <span>{formatDate(message.messageAt)}</span>
              </div>
              <p>{message.content}</p>
            </article>
          ))}
          {!messages.length ? <p className="muted">还没有 Hermes/Clawbot 聊天归档。</p> : null}
        </section>
      ) : null}

      {tab === "summaries" ? (
        <section className="card-list">
          {summaries.map((summary) => (
            <article className="summary-card" key={summary.id}>
              <div className="card-header">
                <h2>{summary.date}</h2>
                <span>{summary.model}</span>
              </div>
              <h3>核心观点</h3>
              <TextList items={summary.coreViews} empty="暂无核心观点" />
              <h3>Insights</h3>
              <TextList items={summary.insights} empty="暂无 insights" />
              <h3>风险与反方观点</h3>
              <TextList items={summary.risks} empty="暂无风险记录" />
              <h3>待验证问题</h3>
              <TextList items={summary.questions} empty="暂无待验证问题" />
              <div className="disclaimer">
                <ShieldAlert size={16} />
                {summary.disclaimer}
              </div>
            </article>
          ))}
          {!summaries.length ? <p className="muted">还没有每日洞察。</p> : null}
        </section>
      ) : null}

      {tab === "suggestions" ? (
        <section className="card-list">
          {suggestions.map((suggestion) => (
            <article className="summary-card" key={suggestion.id}>
              <div className="card-header">
                <h2>{suggestion.title}</h2>
                <span>{suggestion.date}</span>
              </div>
              <p className="thesis">{suggestion.thesis}</p>
              <h3>依据</h3>
              <p>{suggestion.rationale}</p>
              <h3>风险</h3>
              <TextList items={suggestion.risks} empty="暂无风险记录" />
              <h3>验证步骤</h3>
              <TextList items={suggestion.validationSteps} empty="暂无验证步骤" />
              <div className="disclaimer">
                <ShieldAlert size={16} />
                研究建议仅用于学习和复盘，不构成买卖指令。
              </div>
            </article>
          ))}
          {!suggestions.length ? <p className="muted">还没有研究建议。</p> : null}
        </section>
      ) : null}
    </main>
  );
}
