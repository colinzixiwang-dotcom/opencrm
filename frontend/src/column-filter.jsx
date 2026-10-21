import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./components";
import { tr } from "./i18n";

// Shared column filter: the portal escapes scroll containers and narrow table cells.
export function ColumnFilter({ label, accessibleLabel, value, summary, options, onChange }) {
  const id = useId(), trigger = useRef(null), menu = useRef(null);
  const [open, setOpen] = useState(false), [active, setActive] = useState(0), [position, setPosition] = useState({});
  const close = (restoreFocus = false) => { setOpen(false); if (restoreFocus) trigger.current?.focus(); };
  const show = () => { setActive(Math.max(0, options.findIndex(option => option.value === value))); setOpen(true); };
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current.getBoundingClientRect(), width = Math.min(232, window.innerWidth - 24);
      const height = Math.min(options.length * 38 + 46, 310);
      const below = rect.bottom + 8;
      setPosition({ width, left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), top: below + height <= window.innerHeight - 12 ? below : Math.max(12, rect.top - height - 8), maxHeight: Math.min(310, window.innerHeight - 24) });
    };
    place(); window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, options.length]);
  useEffect(() => { if (open) menu.current?.querySelectorAll('[role="option"]')[active]?.focus(); }, [open, active]);
  useEffect(() => {
    if (!open) return;
    const outside = event => { if (!trigger.current?.contains(event.target) && !menu.current?.contains(event.target)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const navigate = event => {
    if (event.key === "Escape") { event.preventDefault(); close(true); }
    else if (event.key === "Tab") close(true);
    else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault(); setActive(index => event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
    }
  };
  return <>
    <button type="button" ref={trigger} className={"ticket-column-filter" + (open ? " is-open" : "")} aria-label={tr(accessibleLabel)} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined} data-value={value} onClick={() => open ? close() : show()} onKeyDown={event => { if (["ArrowDown", "ArrowUp"].includes(event.key)) {event.preventDefault(); show();} }}>
      <span className="ticket-column-label">{tr(label)}</span>
      {summary && <span className="ticket-column-value" title={tr(options.find(option => option.value === value)?.label || summary)}>{tr(summary)}</span>}
      <Icon name="filter" />
    </button>
    {open && createPortal(<div ref={menu} className="column-filter-menu" style={position} onKeyDown={navigate}>
      <div className="column-filter-menu-label" id={id + "-label"}>{tr(label)}</div>
      <div role="listbox" id={id} aria-labelledby={id + "-label"}>
        {options.map((option, index) => <button type="button" role="option" data-value={option.value} aria-selected={option.value === value} tabIndex={index === active ? 0 : -1} key={option.value} className={"column-filter-option" + (option.value === value ? " is-selected" : "")} onClick={() => {close(true); if (option.value !== value) onChange(option.value);}}>
          <span>{tr(option.label)}</span>{option.value === value && <Icon name="check" />}
        </button>)}
      </div>
    </div>, document.body)}
  </>;
}
