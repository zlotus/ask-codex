import { Check, Copy, WrapText } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import hljs from "highlight.js/lib/core";
import type { LanguageFn } from "highlight.js";

const DEFAULT_MAX_DISPLAY_CHARACTERS = 120_000;
const MAX_HIGHLIGHT_CHARACTERS = 60_000;

type LanguageModule = { default: LanguageFn };

const LANGUAGE_LOADERS: Record<string, () => Promise<LanguageModule>> = {
  bash: () => import("highlight.js/lib/languages/bash"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  css: () => import("highlight.js/lib/languages/css"),
  diff: () => import("highlight.js/lib/languages/diff"),
  go: () => import("highlight.js/lib/languages/go"),
  java: () => import("highlight.js/lib/languages/java"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  json: () => import("highlight.js/lib/languages/json"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  python: () => import("highlight.js/lib/languages/python"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  rust: () => import("highlight.js/lib/languages/rust"),
  sql: () => import("highlight.js/lib/languages/sql"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  xml: () => import("highlight.js/lib/languages/xml"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
};

const loadingLanguages = new Map<string, Promise<boolean>>();

function ensureLanguage(language: string): Promise<boolean> {
  if (hljs.getLanguage(language)) return Promise.resolve(true);
  const existing = loadingLanguages.get(language);
  if (existing) return existing;
  const loader = LANGUAGE_LOADERS[language];
  if (!loader) return Promise.resolve(false);
  const loading = loader()
    .then((module) => {
      hljs.registerLanguage(language, module.default);
      return true;
    })
    .catch(() => false);
  loadingLanguages.set(language, loading);
  return loading;
}

const LANGUAGE_ALIASES: Record<string, string> = {
  c: "cpp",
  "c++": "cpp",
  cxx: "cpp",
  h: "cpp",
  hpp: "cpp",
  html: "xml",
  js: "javascript",
  jsx: "javascript",
  md: "markdown",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  ts: "typescript",
  tsx: "typescript",
  yml: "yaml",
};

interface DisplaySlice {
  text: string;
  omitted: number;
}

export interface CodeBlockProps {
  code: string;
  language?: string;
  label?: string;
  maxDisplayCharacters?: number;
  truncate?: "end" | "middle";
  wrapInitially?: boolean;
  showWrap?: boolean;
  tone?: "code" | "terminal";
}

function normalizedLanguage(language?: string): string | undefined {
  const value = language?.trim().toLowerCase().replace(/^language-/, "");
  if (!value || value === "text" || value === "plaintext" || value === "ansi") return undefined;
  return LANGUAGE_ALIASES[value] ?? value;
}

function sliceForDisplay(
  code: string,
  maximum: number,
  truncate: "end" | "middle",
): DisplaySlice {
  if (code.length <= maximum) return { text: code, omitted: 0 };
  if (truncate === "end") {
    return { text: code.slice(0, maximum), omitted: code.length - maximum };
  }
  const headLength = Math.floor(maximum * 0.7);
  const tailLength = maximum - headLength;
  return {
    text: `${code.slice(0, headLength)}\n\n... output omitted ...\n\n${code.slice(-tailLength)}`,
    omitted: code.length - maximum,
  };
}

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand?.("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard access is unavailable");
}

export function CopyTextButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
  }, []);

  return (
    <button
      type="button"
      className="code-action"
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      onClick={() => {
        void writeClipboard(text).then(() => {
          setCopied(true);
          if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
          resetTimerRef.current = window.setTimeout(() => setCopied(false), 1_600);
        }).catch(() => setCopied(false));
      }}
    >
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
    </button>
  );
}

export function CodeBlock({
  code,
  language,
  label,
  maxDisplayCharacters = DEFAULT_MAX_DISPLAY_CHARACTERS,
  truncate = "end",
  wrapInitially = false,
  showWrap = true,
  tone = "code",
}: CodeBlockProps) {
  const [wrap, setWrap] = useState(wrapInitially);
  const [loadedLanguage, setLoadedLanguage] = useState<string | null>(null);
  const display = useMemo(
    () => sliceForDisplay(code, Math.max(1_000, maxDisplayCharacters), truncate),
    [code, maxDisplayCharacters, truncate],
  );
  const syntax = normalizedLanguage(language);

  useEffect(() => {
    if (!syntax || display.text.length > MAX_HIGHLIGHT_CHARACTERS || hljs.getLanguage(syntax)) return;
    let active = true;
    void ensureLanguage(syntax).then((loaded) => {
      if (active && loaded) setLoadedLanguage(syntax);
    });
    return () => {
      active = false;
    };
  }, [display.text.length, syntax]);

  const languageReady = Boolean(syntax && (loadedLanguage === syntax || hljs.getLanguage(syntax)));
  const highlighted = useMemo(() => {
    if (!syntax || !languageReady || display.text.length > MAX_HIGHLIGHT_CHARACTERS) {
      return null;
    }
    return hljs.highlight(display.text, { language: syntax, ignoreIllegals: true }).value;
  }, [display.text, languageReady, syntax]);
  const displayLabel = label ?? language?.trim() ?? "Text";

  return (
    <section className={`code-block code-block--${tone}${wrap ? " code-block--wrap" : ""}`}>
      <header className="code-block-toolbar">
        <span className="code-block-label">{displayLabel}</span>
        <div className="code-block-actions">
          {showWrap && (
            <button
              type="button"
              className={`code-action${wrap ? " code-action--active" : ""}`}
              aria-label={wrap ? "Disable line wrapping" : "Wrap long lines"}
              aria-pressed={wrap}
              title={wrap ? "Disable line wrapping" : "Wrap long lines"}
              onClick={() => setWrap((current) => !current)}
            >
              <WrapText size={14} aria-hidden="true" />
            </button>
          )}
          <CopyTextButton text={code} label={`Copy ${displayLabel.toLowerCase()}`} />
        </div>
      </header>
      <pre className="code-block-content" data-truncated={display.omitted > 0 || undefined}>
        {highlighted === null ? (
          <code>{display.text}</code>
        ) : (
          <code className={`hljs language-${syntax}`} dangerouslySetInnerHTML={{ __html: highlighted }} />
        )}
      </pre>
      {display.omitted > 0 && (
        <div className="code-block-truncation" role="status">
          {display.omitted.toLocaleString()} characters omitted from display
        </div>
      )}
    </section>
  );
}
