import React, { useEffect, useId, useRef, useState } from "react";
import { sourceUrl, type ReportItem } from "../util/reports";
import "./ItemList.css";

export interface ContentsItem {
  title: string;
  anchor: string;
  source: ReportItem;
}

export default function ItemList({ items }: { items: ContentsItem[] }) {
  if (!items.length) return null;
  return (
    <nav className="article-contents" aria-label="Article contents">
      <ol className="contents-list">
        {items.map(item => <Item key={item.anchor} item={item} />)}
      </ol>
    </nav>
  );
}

type Note = "why" | "background" | "source";
type OpenNote = { note: Note; trigger: "hover" | "focus" | "click" };

function Item({ item: { title, anchor, source } }: { item: ContentsItem }) {
  const [openNote, setOpenNote] = useState<OpenNote | null>(null);
  const sourceRef = useRef<HTMLAnchorElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const pointerFocus = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const popoverId = useId();
  const url = sourceUrl(source.url);
  const notes = [
    { key: "why" as const, label: "Why read this", content: source.why },
    { key: "background" as const, label: "Background", content: source.context },
    { key: "source" as const, label: "Source", content: url ? source.title : "" },
  ].filter(note => note.content);
  const active = notes.find(note => note.key === openNote?.note);

  const cancelClose = () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const dismiss = () => { cancelClose(); setOpenNote(null); };
  const leaveHover = () => {
    cancelClose();
    // Allow the pointer to travel from either control into its reading panel.
    closeTimer.current = setTimeout(() => {
      setOpenNote(current => current?.trigger === "hover" ? null : current);
    }, 150);
  };

  useEffect(() => () => cancelClose(), []);
  useEffect(() => {
    if (!openNote) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!actionsRef.current?.contains(target) && !sourceRef.current?.contains(target) &&
          !popoverRef.current?.contains(target)) dismiss();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (popoverRef.current?.contains(document.activeElement)) {
        if (openNote.note === "source") sourceRef.current?.focus();
        else actionsRef.current?.querySelector<HTMLButtonElement>('[aria-expanded="true"]')?.focus();
      }
      dismiss();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [openNote]);

  return (
    <li className="contents-item">
      <div className="contents-primary">
        <div className="contents-heading">
          <a className="contents-title" href={`#${anchor}`} onClick={dismiss}>{title}</a>
          {url && (
            <a
              className="contents-source-link"
              href={url}
              ref={sourceRef}
              aria-describedby={active?.key === "source" ? popoverId : undefined}
              onPointerEnter={event => {
                if (event.pointerType !== "mouse") return;
                cancelClose();
                setOpenNote({ note: "source", trigger: "hover" });
              }}
              onPointerLeave={event => { if (event.pointerType === "mouse") leaveHover(); }}
              onFocus={() => { cancelClose(); setOpenNote({ note: "source", trigger: "focus" }); }}
              onBlur={event => {
                if (!popoverRef.current?.contains(event.relatedTarget as Node | null)) dismiss();
              }}
              aria-label={`Source: ${source.title}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={dismiss}
            >(source)</a>
          )}
        </div>
        <div className="contents-actions" ref={actionsRef}>
          {notes.filter(note => note.key !== "source").map(note => (
            <button
              key={note.key}
              type="button"
              className="contents-action"
              aria-label={`${note.label}: ${title}`}
              aria-expanded={active?.key === note.key}
              aria-controls={active?.key === note.key ? popoverId : undefined}
              onPointerEnter={event => {
                if (event.pointerType !== "mouse") return;
                cancelClose();
                setOpenNote(current => current?.note === note.key ? current : { note: note.key, trigger: "hover" });
              }}
              onPointerLeave={event => { if (event.pointerType === "mouse") leaveHover(); }}
              onPointerDown={() => { pointerFocus.current = true; }}
              onPointerCancel={() => { pointerFocus.current = false; }}
              onFocus={() => {
                cancelClose();
                // A tap focuses before clicking; let the click toggle only once.
                if (!pointerFocus.current) setOpenNote({ note: note.key, trigger: "focus" });
              }}
              onBlur={event => {
                pointerFocus.current = false;
                if (!popoverRef.current?.contains(event.relatedTarget as Node | null)) dismiss();
              }}
              onClick={() => {
                pointerFocus.current = false;
                cancelClose();
                setOpenNote(current => current?.note === note.key && current.trigger === "click"
                  ? null : { note: note.key, trigger: "click" });
              }}
            >
              {note.label}
              <svg className="contents-action-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <path d="m2 3.5 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.2" />
              </svg>
            </button>
          ))}
        </div>
        {active && (
          <div
            id={popoverId}
            className={`contents-popover${active.key === "source" ? " contents-source-popover" : ""}`}
            ref={popoverRef}
            role="region"
            aria-labelledby={`${popoverId}-label`}
            tabIndex={0}
            onPointerEnter={cancelClose}
            onPointerLeave={event => { if (event.pointerType === "mouse") leaveHover(); }}
            onFocus={() => {
              cancelClose();
              setOpenNote(current => current && current.trigger !== "click" ? { ...current, trigger: "focus" } : current);
            }}
            onBlur={event => {
              if (!actionsRef.current?.contains(event.relatedTarget as Node | null) &&
                  event.relatedTarget !== sourceRef.current) dismiss();
            }}
          >
            <span id={`${popoverId}-label`} className="contents-popover-label">{active.label}</span>
            <p>{active.content}</p>
          </div>
        )}
      </div>
    </li>
  );
}
