"use client";

import { useEffect, useMemo, useState, type ComponentProps } from "react";
import { defaultRehypePlugins, Streamdown } from "streamdown";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";

import { cn } from "@/lib/utils";

import { CopyableMarkdownLink, SessionAwareInlineCode } from "./markdown-links";

export { CopyableMarkdownLink } from "./markdown-links";

type StreamdownPlugins = NonNullable<ComponentProps<typeof Streamdown>["plugins"]>;

// agentbox (08-11-2026): math en mermaid apart laden. Samen in één Promise.all
// haalde elke chat met een "\(" of een regel die met "graph"/"pie"/"timeline"
// begint ook de mermaid-chunk binnen (download + ~50 ms parse op de testbox),
// terwijl Streamdown alleen een ```mermaid-blok als diagram tekent.
type Extra = "math" | "mermaid";
const extraLoaded: Partial<StreamdownPlugins> = {};
const extraPromises: Partial<Record<Extra, Promise<void>>> = {};
const extraPluginsListeners = new Set<() => void>();

function neededExtras(value: unknown): Extra[] {
  if (typeof value !== "string") return [];
  const out: Extra[] = [];
  if (/(^|[^\\])(\$\$|\\\(|\\\[)/.test(value)) out.push("math");
  if (/```mermaid\b/i.test(value)) out.push("mermaid");
  return out;
}

function loadExtra(name: Extra): Promise<void> {
  if (!extraPromises[name]) {
    const imp = name === "math"
      ? import("@streamdown/math").then((m) => { extraLoaded.math = m.math; })
      : import("@streamdown/mermaid").then((m) => { extraLoaded.mermaid = m.mermaid; });
    extraPromises[name] = imp
      .then(() => { for (const notify of extraPluginsListeners) notify(); })
      .catch(() => { delete extraPromises[name]; });
  }
  return extraPromises[name]!;
}

function pickExtras(names: Extra[]): Partial<StreamdownPlugins> | null {
  const out: Partial<StreamdownPlugins> = {};
  let any = false;
  for (const n of names) if (extraLoaded[n]) { (out as Record<string, unknown>)[n] = extraLoaded[n]; any = true; }
  return any ? out : null;
}

function useStreamdownPlugins(children: unknown): StreamdownPlugins {
  const names = neededExtras(children);
  const sleutel = names.join(",");
  const [extra, setExtra] = useState<Partial<StreamdownPlugins> | null>(() => pickExtras(names));
  useEffect(() => {
    const lijst = sleutel ? (sleutel.split(",") as Extra[]) : [];
    if (!lijst.length) {
      setExtra(null);
      return;
    }
    const notify = () => setExtra(pickExtras(lijst));
    if (lijst.every((n) => extraLoaded[n])) {
      notify();
      return;
    }
    extraPluginsListeners.add(notify);
    for (const n of lijst) void loadExtra(n);
    return () => {
      extraPluginsListeners.delete(notify);
    };
  }, [sleutel]);
  return { cjk, code, ...(extra ?? {}) };
}

/**
 * Streamdown's default rehype chain (raw, sanitize, harden) with one change:
 * the sanitizer also keeps `omg:` hrefs. Without it a `#session` reference
 * renders as "[blocked]". `CopyableMarkdownLink` renders only the
 * `omg:session_` form as a link; any other `omg:` href stays plain text.
 */
type SanitizeTuple = [unknown, { protocols?: Record<string, string[]> } & Record<string, unknown>];
const [sanitizePlugin, sanitizeSchema] = defaultRehypePlugins.sanitize as unknown as SanitizeTuple;
const REHYPE_PLUGINS = [
  defaultRehypePlugins.raw,
  [
    sanitizePlugin,
    {
      ...sanitizeSchema,
      protocols: {
        ...sanitizeSchema.protocols,
        href: [...(sanitizeSchema.protocols?.href ?? []), "omg"],
      },
    },
  ],
  defaultRehypePlugins.harden,
] as unknown as NonNullable<StreamdownResponseProps["rehypePlugins"]>;

export type StreamdownResponseProps = ComponentProps<typeof Streamdown>;
type StreamdownComponents = NonNullable<StreamdownResponseProps["components"]>;

export function StreamdownResponse({ className, mode = "static", children, components, ...props }: StreamdownResponseProps) {
  const plugins = useStreamdownPlugins(children);
  const markdownComponents = useMemo<StreamdownComponents>(
    () => ({ a: CopyableMarkdownLink, inlineCode: SessionAwareInlineCode, ...components }) as StreamdownComponents,
    [components],
  );
  return (
    <Streamdown
      className={cn("markdown msg-text size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", className)}
      components={markdownComponents}
      mode={mode}
      plugins={plugins}
      rehypePlugins={REHYPE_PLUGINS}
      // Streamdown 2.6 caps fenced code at 400px and tables at 300px by
      // default. The transcript height model treats those blocks as full
      // height, so a silent cap would leave empty space on unmounted rows.
      // Infinity keeps the previous unbounded layout. Callers can still
      // override through props.
      codeBlockMaxHeight={Infinity}
      tableMaxHeight={Infinity}
      // agentbox: geen regelnummers; de meeste blokken zijn tekst om te plakken.
      lineNumbers={false}
      {...props}
    >
      {children}
    </Streamdown>
  );
}
