/**
 * Projects (services/Projects.ts): create one, write its instructions, see its
 * chats and open one. Works signed out; with an account it syncs.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { FolderOpen, MessageSquare, Plus, Trash2, X } from "lucide-react";
import { MAX_INSTRUCTIONS, MAX_PROJECT_CHATS, Projects, PROJECTS_EVENT, type Project, type ProjectChat } from "../services/Projects";
import { isAccountSession } from "../services/api";

type Props = {
  open: boolean;
  onClose: () => void;
  currentProjectId: string | null;
  /** Put the open chat in this project (null: take it out). */
  onMoveCurrent: (projectId: string | null) => void;
  /** Open a saved chat. */
  onOpenChat: (chat: ProjectChat) => void;
  /** Start a new chat in this project. */
  onNewChat: (projectId: string) => void;
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : "Something went wrong.");

export default function ProjectsPanel({ open, onClose, currentProjectId, onMoveCurrent, onOpenChat, onNewChat }: Props) {
  const [projects, setProjects] = useState<Project[]>(() => Projects.list());
  const [chats, setChats] = useState<ProjectChat[]>(() => Projects.chats());
  const [selectedId, setSelectedId] = useState<string | null>(currentProjectId);
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [newName, setNewName] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    const refresh = () => { setProjects(Projects.list()); setChats(Projects.chats()); };
    window.addEventListener(PROJECTS_EVENT, refresh);
    return () => window.removeEventListener(PROJECTS_EVENT, refresh);
  }, []);
  useEffect(() => {
    if (!open) return;
    setProjects(Projects.list());
    setChats(Projects.chats());
    setSelectedId(currentProjectId ?? Projects.list()[0]?.id ?? null);
    setError("");
    setNote("");
  }, [open, currentProjectId]);
  const selected = projects.find((project) => project.id === selectedId) ?? null;
  useEffect(() => {
    setName(selected?.name ?? "");
    setInstructions(selected?.instructions ?? "");
  }, [selected?.id, selected?.name, selected?.instructions]);

  if (!open) return null;
  const projectChats = selected ? chats.filter((chat) => chat.projectId === selected.id) : [];
  const run = (action: () => void, done = "") => {
    setError("");
    setNote("");
    try { action(); if (done) setNote(done); } catch (actionError) { setError(errorText(actionError)); }
  };

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center overflow-y-auto bg-ink/60 p-4 backdrop-blur-md" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="projects-title" className="relative my-auto w-full max-w-2xl rounded-3xl border border-slate-200 bg-white shadow-soft-lg" data-testid="projects-panel">
        <div className="p-5 sm:p-7">
          <button type="button" aria-label="Close projects" onClick={onClose} className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50"><X size={15} /></button>
          <h2 id="projects-title" className="flex items-center gap-2 font-['Manrope'] text-xl font-semibold text-ink"><FolderOpen size={18} className="text-brand-600" /> Projects</h2>
          <p className="mt-2 text-[13px] leading-6 text-slate-600">
            Group chats and give them shared instructions, which HANNAH follows in every chat of that project. Kept on this device{isAccountSession() ? " and synced with your account" : "; sign in to sync them"}. Up to {MAX_PROJECT_CHATS} project chats are kept, newest first.
          </p>

          <form className="mt-4 flex gap-2" onSubmit={(event) => { event.preventDefault(); run(() => { const made = Projects.create({ name: newName }); setNewName(""); setSelectedId(made.id); }); }}>
            <input value={newName} onChange={(event) => setNewName(event.target.value)} maxLength={80} placeholder="New project name" aria-label="New project name" className="min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-2 text-[13px]" />
            <button type="submit" className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-[13px] font-semibold text-white"><Plus size={14} /> Create</button>
          </form>

          {projects.length > 0 && (
            <div className="mt-4 grid gap-4 sm:grid-cols-[180px_1fr]">
              <ul className="space-y-1" aria-label="Your projects">
                {projects.map((project) => (
                  <li key={project.id}>
                    <button type="button" onClick={() => setSelectedId(project.id)} aria-current={project.id === selectedId} className={`w-full truncate rounded-lg px-3 py-2 text-left text-[13px] ${project.id === selectedId ? "bg-brand-50 font-semibold text-brand-800" : "text-slate-700 hover:bg-slate-50"}`}>
                      {project.name}{project.id === currentProjectId ? " · open" : ""}
                    </button>
                  </li>
                ))}
              </ul>
              {selected && (
                <div className="min-w-0 space-y-3">
                  <label className="block text-[13px] font-medium text-ink">
                    Name
                    <input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-[13px]" />
                  </label>
                  <label className="block text-[13px] font-medium text-ink">
                    Instructions for every chat in this project
                    <textarea value={instructions} maxLength={MAX_INSTRUCTIONS} rows={5} onChange={(event) => setInstructions(event.target.value)} placeholder="For example: I'm writing a thesis on urban water use. Use British English and keep answers under 300 words." className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-[13px]" />
                    <span className="text-[11.5px] font-normal text-slate-500">{instructions.length.toLocaleString()} / {MAX_INSTRUCTIONS.toLocaleString()}. Sent with each request from these chats, to whichever model answers. They can't change HANNAH's safety rules or approvals.</span>
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => run(() => Projects.update(selected.id, { name, instructions }), "Saved.")} className="rounded-lg bg-brand-600 px-3 py-2 text-[13px] font-semibold text-white">Save</button>
                    {selected.id !== currentProjectId
                      ? <button type="button" onClick={() => run(() => onMoveCurrent(selected.id), "The open chat is now in this project.")} className="rounded-lg border border-slate-200 px-3 py-2 text-[13px] text-slate-700 hover:bg-slate-50">Move the open chat here</button>
                      : <button type="button" onClick={() => run(() => onMoveCurrent(null), "The open chat is no longer in a project.")} className="rounded-lg border border-slate-200 px-3 py-2 text-[13px] text-slate-700 hover:bg-slate-50">Take the open chat out</button>}
                    <button type="button" onClick={() => { onNewChat(selected.id); onClose(); }} className="rounded-lg border border-slate-200 px-3 py-2 text-[13px] text-slate-700 hover:bg-slate-50">New chat in this project</button>
                    <button type="button" onClick={() => { if (window.confirm(`Delete the project “${selected.name}” and its ${projectChats.length} saved chat${projectChats.length === 1 ? "" : "s"}? The open chat stays open.`)) run(() => Projects.remove(selected.id)); }} className="inline-flex items-center gap-1 rounded-lg border border-rose-200 px-3 py-2 text-[13px] text-rose-700 hover:bg-rose-50"><Trash2 size={13} /> Delete project</button>
                  </div>
                  <div>
                    <h3 className="text-[12px] font-bold uppercase tracking-[0.15em] text-slate-500">Chats</h3>
                    {projectChats.length === 0 ? <p className="mt-1 text-[13px] text-slate-500">No chats yet. Start one, or move the open chat here.</p> : (
                      <ul className="mt-1 space-y-1">
                        {projectChats.map((chat) => (
                          <li key={chat.id} className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-[13px]">
                            <button type="button" onClick={() => { onOpenChat(chat); onClose(); }} className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-slate-700 hover:text-brand-700"><MessageSquare size={13} className="shrink-0" /><span className="truncate">{chat.title}</span></button>
                            <span className="shrink-0 text-[11.5px] text-slate-500">{new Date(chat.updatedAt).toLocaleDateString()}</span>
                            <button type="button" aria-label={`Delete the chat ${chat.title}`} onClick={() => { if (window.confirm(`Delete the chat “${chat.title}” from this project?`)) run(() => Projects.removeChat(chat.id)); }} className="shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-rose-600"><Trash2 size={13} /></button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
          {error && <p role="alert" className="mt-3 text-[13px] text-rose-700">{error}</p>}
          {note && <p className="mt-3 text-[13px] text-emerald-700">{note}</p>}
        </div>
      </section>
    </div>,
    document.body,
  );
}
