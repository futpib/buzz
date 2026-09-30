"use client";

import {
  Children,
  isValidElement,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

function elements(children: ReactNode) {
  return Children.toArray(children).filter(
    isValidElement<{ children?: ReactNode }>,
  );
}

function TableCards({ children }: { children: ReactNode }) {
  const sections = elements(children);
  const head = sections.find((section) => section.type === "thead");
  const header = elements(elements(head?.props.children)[0]?.props.children);
  const rows = sections
    .filter((section) => section.type === "tbody")
    .flatMap((section) => elements(section.props.children));
  return (
    <div className="message-table-cards">
      {rows.length === 0 ? <p>No rows</p> : null}
      {rows.map((row, index) => (
        <section
          aria-label={`Row ${index + 1}`}
          className="message-table-card"
          key={row.key}
        >
          <dl>
            {elements(row.props.children).map((cell, column) => (
              <div key={cell.key}>
                <dt>
                  {header[column]?.props.children || `Column ${column + 1}`}
                </dt>
                <dd>{cell.props.children}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}

function TableScroller({
  children,
  frozen = false,
}: {
  children: ReactNode;
  frozen?: boolean;
}) {
  const scroll = useRef<HTMLElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const update = () =>
      setEdges({
        left: element.scrollLeft > 1,
        right:
          element.scrollLeft + element.clientWidth < element.scrollWidth - 1,
      });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    element.addEventListener("scroll", update, { passive: true });
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", update);
    };
  }, []);
  return (
    <div
      className="message-table-frame"
      data-left={edges.left}
      data-right={edges.right}
    >
      <section
        aria-label="Scrollable table"
        className={`message-table-scroll${frozen ? " message-table-frozen" : ""}`}
        ref={scroll}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable tables need keyboard focus.
        tabIndex={0}
      >
        <table>{children}</table>
      </section>
    </div>
  );
}

export function MessageTablePreview({ children }: { children?: ReactNode }) {
  return <TableScroller>{children}</TableScroller>;
}

function TableViewControls({
  view,
  setView,
}: {
  view: "table" | "cards";
  setView: (view: "table" | "cards") => void;
}) {
  return (
    <fieldset aria-label="Table view" className="message-table-views">
      <button
        aria-pressed={view === "table"}
        onClick={() => setView("table")}
        type="button"
      >
        Table
      </button>
      <button
        aria-pressed={view === "cards"}
        onClick={() => setView("cards")}
        type="button"
      >
        Cards
      </button>
    </fieldset>
  );
}

export function MessageTable({ children }: { children?: ReactNode }) {
  const [view, setView] = useState<"table" | "cards">("table");
  const [readerView, setReaderView] = useState<"table" | "cards">("table");
  const [expanded, setExpanded] = useState(false);
  const [frozen, setFrozen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const expand = useRef<HTMLButtonElement>(null);
  const restoreScroll = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (expanded) dialog.current?.showModal();
  }, [expanded]);

  return (
    <div className="message-table">
      <div className="message-table-toolbar">
        <TableViewControls view={view} setView={setView} />
        <button
          aria-label="Expand table"
          onClick={() => {
            const positions: {
              element: HTMLElement;
              top: number;
              left: number;
            }[] = [];
            for (
              let element = expand.current?.parentElement;
              element;
              element = element.parentElement
            ) {
              positions.push({
                element,
                top: element.scrollTop,
                left: element.scrollLeft,
              });
            }
            restoreScroll.current = () => {
              for (const { element, top, left } of positions) {
                element.scrollTop = top;
                element.scrollLeft = left;
              }
            };
            setReaderView(view);
            setExpanded(true);
          }}
          ref={expand}
          type="button"
        >
          Expand
        </button>
      </div>
      <div hidden={view !== "table"}>
        <TableScroller>{children}</TableScroller>
      </div>
      {view === "cards" ? <TableCards>{children}</TableCards> : null}
      {expanded
        ? createPortal(
            <dialog
              aria-label="Expanded table"
              className="message-body message-table-dialog"
              onClose={() => {
                setExpanded(false);
                expand.current?.focus({ preventScroll: true });
                restoreScroll.current?.();
                restoreScroll.current = null;
              }}
              ref={dialog}
            >
              {expanded ? (
                <>
                  <header className="message-table-toolbar">
                    <TableViewControls
                      view={readerView}
                      setView={setReaderView}
                    />
                    {readerView === "table" ? (
                      <button
                        aria-pressed={frozen}
                        onClick={() => setFrozen(!frozen)}
                        type="button"
                      >
                        Freeze first column
                      </button>
                    ) : null}
                    <button
                      aria-label="Close expanded table"
                      onClick={() => dialog.current?.close()}
                      type="button"
                    >
                      Close
                    </button>
                  </header>
                  {readerView === "table" ? (
                    <TableScroller frozen={frozen}>{children}</TableScroller>
                  ) : (
                    <div className="message-table-card-reader">
                      <TableCards>{children}</TableCards>
                    </div>
                  )}
                </>
              ) : null}
            </dialog>,
            document.body,
          )
        : null}
    </div>
  );
}
