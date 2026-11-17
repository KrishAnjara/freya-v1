"use client";

import { isValidElement, memo, useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { copyTextToClipboard } from "@/lib/clipboard";

type CodeBlockProps = {
  children: ReactNode;
  language?: string;
};

function CodeBlock({ children, language }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const code = getTextContent(children);

  async function copyCode() {
    const success = await copyTextToClipboard(code);
    setCopied(success);
    setCopyFailed(!success);
    window.setTimeout(() => {
      setCopied(false);
      setCopyFailed(false);
    }, success ? 1600 : 2200);
  }

  return (
    <div className="code-frame">
      <div className="code-toolbar">
        <span>{language || "CODE"}</span>
        <button type="button" onClick={() => void copyCode()} aria-label={copied ? "Code copied" : copyFailed ? "Code copy failed" : "Copy code block"}>
          {copied ? "COPIED" : copyFailed ? "COPY FAILED" : "COPY"}
        </button>
        <span className="sr-only" role="status" aria-live="polite">{copied ? "Code copied to clipboard." : copyFailed ? "Could not copy code to clipboard." : ""}</span>
      </div>
      <pre><code className={language ? `language-${language}` : undefined}>{children}</code></pre>
    </div>
  );
}

const FILE_TYPES: Record<string, string> = {
  md: "text/markdown", txt: "text/plain", csv: "text/csv", json: "application/json", html: "text/html",
  css: "text/css", js: "text/javascript", ts: "text/plain", py: "text/x-python", svg: "image/svg+xml", xml: "application/xml",
};

function downloadText(name: string, text: string) {
  const extension = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  const url = URL.createObjectURL(new Blob([text], { type: `${FILE_TYPES[extension] ?? "text/plain"};charset=utf-8` }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * An SVG FREYA drew. Rendered through <img>, where SVG cannot run scripts or fetch anything,
 * so model-written markup is safe to show.
 */
function SvgImage({ source, name }: { source: string; name: string }) {
  const [showSource, setShowSource] = useState(false);
  const valid = /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(source) && /<\/svg>\s*$/i.test(source);
  if (!valid) return <CodeBlock language="svg">{source}</CodeBlock>;
  return (
    <figure className="freya-drawing">
      {/* eslint-disable-next-line @next/next/no-img-element -- a data URL; <img> is what sandboxes the SVG */}
      <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`} alt={`Drawing: ${name}`}/>
      <figcaption>
        <span>{name}</span>
        <button type="button" onClick={() => setShowSource((open) => !open)}>{showSource ? "HIDE SVG" : "VIEW SVG"}</button>
        <button type="button" onClick={() => downloadText(name, source)}>DOWNLOAD</button>
      </figcaption>
      {showSource && <CodeBlock language="svg">{source}</CodeBlock>}
    </figure>
  );
}

/** A file FREYA sent: a card with its name and size, a download, and an optional preview. */
function FileCard({ name, source }: { name: string; source: string }) {
  const [open, setOpen] = useState(false);
  const extension = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  if (extension === "svg") return <SvgImage source={source} name={name}/>;
  const bytes = new TextEncoder().encode(source).length;
  return (
    <div className="freya-file">
      <div className="freya-file-head">
        <span className="attachment-glyph" aria-hidden="true">{(extension || "file").slice(0, 4).toUpperCase()}</span>
        <span className="freya-file-name">{name}</span>
        <span className="freya-file-size">{bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`}</span>
        <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>{open ? "HIDE" : "PREVIEW"}</button>
        <button type="button" onClick={() => downloadText(name, source)}>DOWNLOAD</button>
      </div>
      {open && <CodeBlock language={extension}>{source}</CodeBlock>}
    </div>
  );
}

/** The name a whole file goes by, from its language (or a name in its first line). */
const FILE_NAMES: Record<string, string> = {
  html: "index.html", htm: "index.html", css: "styles.css", js: "script.js", javascript: "script.js", mjs: "script.mjs", jsx: "App.jsx",
  ts: "main.ts", typescript: "main.ts", tsx: "App.tsx", py: "main.py", python: "main.py", json: "data.json", java: "Main.java",
  c: "main.c", cpp: "main.cpp", "c++": "main.cpp", cs: "Program.cs", go: "main.go", rs: "main.rs", rust: "main.rs", php: "index.php",
  rb: "main.rb", ruby: "main.rb", kt: "Main.kt", swift: "main.swift", sh: "script.sh", bash: "script.sh", sql: "query.sql",
  yaml: "config.yaml", yml: "config.yaml", xml: "data.xml", vue: "App.vue", svelte: "App.svelte",
};

/**
 * Whether a code block is a whole file rather than a snippet: a complete web page, or 30 lines or
 * more in a language that's written as files. Those arrive as a file to download, not an inline wall.
 */
export function wholeFileName(language: string | undefined, source: string): string | null {
  const lang = (language ?? "").toLowerCase();
  const named = source.match(/^\s*(?:\/\/|#|<!--|\/\*)\s*([\w.-]+\.[a-z0-9]{1,6})\b/i)?.[1];
  const page = /^\s*(<!doctype html|<html[\s>])/i.test(source);
  if (page) return named ?? "index.html";
  if (!FILE_NAMES[lang]) return null;
  return source.split("\n").length >= 30 ? named ?? FILE_NAMES[lang] : null;
}

const markdownComponents: Components = {
  pre({ children }) {
    const codeChild = isCodeElement(children)
      ? children
      : Array.isArray(children) && children.length === 1 && isCodeElement(children[0])
        ? children[0]
        : null;
    if (codeChild) {
      const codeElement = codeChild;
      const className = codeElement.props.className ?? "";
      const language = className.match(/language-(\S+)/)?.[1];
      // A file name is only a label; path separators are flattened so it cannot imply a location.
      const fileName = language?.match(/^file:(.+)$/)?.[1]?.replace(/[\\/]/g, "-").slice(0, 120);
      if (fileName) return <FileCard name={fileName} source={getTextContent(codeElement.props.children).replace(/\n$/, "")}/>;
      if (language === "svg") return <SvgImage name="drawing.svg" source={getTextContent(codeElement.props.children).trim()}/>;
      const source = getTextContent(codeElement.props.children).replace(/\n$/, "");
      const whole = wholeFileName(language, source);
      if (whole) return <FileCard name={whole} source={source}/>;
      return <CodeBlock language={language}>{codeElement.props.children}</CodeBlock>;
    }
    return <pre>{children}</pre>;
  },
  table({ children }) {
    return <div className="table-scroll"><table>{children}</table></div>;
  },
  a({ href, children, ...props }) {
    const external = typeof href === "string" && /^https?:\/\//i.test(href);
    return <a href={href} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})} {...props}>{children}</a>;
  },
};

function isCodeElement(value: ReactNode): value is ReactElement<{ className?: string; children?: ReactNode }> {
  return isValidElement(value);
}

function getTextContent(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(getTextContent).join("");
  if (isValidElement<{ children?: ReactNode }>(value)) return getTextContent(value.props.children);
  return "";
}

type Highlighter = typeof import("rehype-highlight").default;

/**
 * highlight.js is ~93 kB gzipped and was the largest file on first load, yet most replies
 * contain no code. It now loads the first time a code fence appears, and is shared after that.
 * Until it arrives, code renders unhighlighted, so nothing waits on it.
 */
let highlighter: Highlighter | null = null;
let loadingHighlighter: Promise<Highlighter> | null = null;
function loadHighlighter() {
  loadingHighlighter ??= import("rehype-highlight").then((module) => (highlighter = module.default));
  return loadingHighlighter;
}

function useHighlighter(needed: boolean) {
  // Wrapped: handed a function directly, useState calls it as an initializer and stores the
  // result, which made react-markdown run a transformer as a plugin ("expected node").
  const [plugin, setPlugin] = useState<Highlighter | null>(() => highlighter);
  useEffect(() => {
    if (!needed || plugin) return;
    let active = true;
    void loadHighlighter().then((loaded) => { if (active) setPlugin(() => loaded); });
    return () => { active = false; };
  }, [needed, plugin]);
  return plugin;
}

/** Made once: a new plugin array on every render made react-markdown parse the whole message again. */
const REMARK_PLUGINS = [remarkGfm];
const NO_REHYPE: [] = [];

/**
 * Memoized on its text: the chat re-renders often (her face, the typing dots), and each message
 * used to be parsed again every time. Now a message is parsed when its text changes, and only then.
 */
const MarkdownContent = memo(function MarkdownContent({ content }: { content: string }) {
  const highlight = useHighlighter(content.includes("```"));
  const rehype = useMemo(() => highlight ? [highlight] : NO_REHYPE, [highlight]);
  return (
    <div className="markdown-content">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={rehype} components={markdownComponents}>
        {content}
      </ReactMarkdown>
    </div>
  );
});
export default MarkdownContent;
