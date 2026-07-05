import {
  Check,
  Clock3,
  LogOut,
  NotebookPen,
  Pin,
  Plus,
  Search,
  Tag,
  Trash2,
  X
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LoginResponse, Note, NoteInput, NotesResponse } from "../shared/types";

type SaveState = "idle" | "saving" | "saved" | "error";

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

export function App() {
  const [token, setToken] = useState(() => localStorage.getItem(tokenKey) ?? "");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [notes, setNotes] = useState<Note[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<NoteInput>(emptyDraft);
  const [query, setQuery] = useState("");
  const [tagText, setTagText] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [appError, setAppError] = useState("");
  const saveTimer = useRef<number | null>(null);
  const isNewDraft = selectedId === "new";

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

  const loadNotes = useCallback(async () => {
    if (!token) {
      return;
    }
    try {
      const data = await api<NotesResponse>("/api/notes", {}, token);
      setNotes(data.notes);
      setSelectedId((current) => current ?? data.notes[0]?.id ?? "new");
      setAppError("");
    } catch (error) {
      setAppError(error instanceof Error ? error.message : "无法加载笔记");
      if (error instanceof Error && error.message === "Unauthorized.") {
        localStorage.removeItem(tokenKey);
        setToken("");
      }
    }
  }, [token]);

  useEffect(() => {
    void loadNotes();
  }, [loadNotes]);

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
          return [note, ...without].sort((a, b) => Number(b.pinned) - Number(a.pinned) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
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
          <p>进入你的个人笔记工作台</p>
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
    <main className="workspace">
      <aside className="sidebar">
        <header className="sidebar-header">
          <div>
            <span className="eyebrow">Stockpulse</span>
            <h1>个人笔记</h1>
          </div>
          <button className="icon-button" onClick={logout} title="退出登录">
            <LogOut size={18} />
          </button>
        </header>

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
        {appError ? <div className="banner-error">{appError}</div> : null}
        <div className="editor-toolbar">
          <button
            className={`toggle-button ${draft.pinned ? "active" : ""}`}
            onClick={() => setDraft((current) => ({ ...current, pinned: !current.pinned }))}
            title="置顶"
          >
            <Pin size={17} />
            置顶
          </button>
          <button className="icon-button danger" onClick={deleteSelected} title="删除笔记">
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
    </main>
  );
}
