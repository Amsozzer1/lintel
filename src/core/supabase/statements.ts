/**
 * Split SQL into statements and group them the way `supabase db push` applies a migration file.
 *
 * A port of supabase/cli v2.118.0 `pkg/parser` (state.go, token.go) and `pkg/migration/file.go`,
 * quirks included: the point is to split exactly where Supabase splits, not where a full SQL
 * parser would. Copyright (c) 2021 Supabase, Inc. and contributors, MIT License: see
 * THIRD_PARTY_NOTICES.md.
 */

export interface Statement {
  /** The statement as Supabase sends it: trailing `;` removed, then whitespace trimmed. */
  text: string;
  /** Offset of `text` in the source. */
  start: number;
}

/** A group of statements applied together: in one transaction, or (`alone`) outside any. */
export interface Batch {
  statements: Statement[];
  alone: boolean;
}

/** Statements as Supabase sends them (`parser.SplitAndTrim`). */
export function splitStatements(sql: string): Statement[] {
  const statements: Statement[] = [];
  for (const token of splitTokens(sql)) {
    const raw = token.text.replace(/;+$/, "");
    const text = raw.trim();
    if (text) statements.push({ text, start: token.start + raw.indexOf(text) });
  }
  return statements;
}

/** Raw tokens, each ending at its separator (`parser.Split`). */
export function splitTokens(sql: string): Statement[] {
  const tokens: Statement[] = [];
  let start = 0;
  let state: State = new Ready();
  for (let i = 0; i < sql.length; i++) {
    const next = state.next(sql[i] as string, new Data(sql, start, i + 1));
    if (next) state = next;
    else {
      tokens.push({ text: sql.slice(start, i + 1), start });
      start = i + 1;
      state = new Ready();
    }
  }
  if (start < sql.length) tokens.push({ text: sql.slice(start), start });
  return tokens;
}

// supabase/cli pkg/migration/file.go: these can't run inside the per-file batch.
const PIPELINE_INCOMPATIBLE = [
  /^CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY(\s|$)/,
  /^DROP\s+INDEX\s+CONCURRENTLY(\s|$)/,
  /^REINDEX(\s|\().*\sCONCURRENTLY(\s|$)/,
  /^VACUUM(\s|\(|$)/,
  /^ALTER\s+SYSTEM(\s|$)/,
  /^CLUSTER(\s|$)/,
];

export function isPipelineIncompatible(statement: string): boolean {
  const upper = trimLeadingComments(statement).toUpperCase();
  return PIPELINE_INCOMPATIBLE.some((re) => re.test(upper));
}

/** Migration files: one transaction per run of statements, with pipeline-incompatible ones alone. */
export function migrationBatches(sql: string): Batch[] {
  const batches: Batch[] = [];
  let current: Statement[] = [];
  for (const s of splitStatements(sql)) {
    if (!isPipelineIncompatible(s.text)) {
      current.push(s);
      continue;
    }
    if (current.length) batches.push({ statements: current, alone: false });
    current = [];
    batches.push({ statements: [s], alone: true });
  }
  if (current.length) batches.push({ statements: current, alone: false });
  return batches;
}

/** seed.sql is sent as a single batch, with no statements split out (`SeedFile.ExecBatchWithCache`). */
export function seedBatches(sql: string): Batch[] {
  const statements = splitStatements(sql);
  return statements.length ? [{ statements, alone: false }] : [];
}

/** `sql` without leading whitespace and comments. */
export function trimLeadingComments(sql: string): string {
  let s = sql.replace(/^[﻿ \t\n\r]+/, "");
  for (;;) {
    if (s.startsWith("--")) {
      const nl = s.indexOf("\n");
      if (nl < 0) return "";
      s = s.slice(nl + 1).replace(/^[ \t\n\r]+/, "");
    } else if (s.startsWith("/*")) {
      const end = s.indexOf("*/");
      if (end < 0) return "";
      s = s.slice(end + 2).replace(/^[ \t\n\r]+/, "");
    } else return s;
  }
}

// ---- The tokenizer's state machine (pkg/parser/state.go). ----

/** The current token so far: `sql[start, end)`. Mirrors Go's `data []byte`. */
class Data {
  readonly sql: string;
  readonly start: number;
  readonly end: number;
  constructor(sql: string, start: number, end: number) {
    this.sql = sql;
    this.start = start;
    this.end = end;
  }
  slice(from: number, to = this.end): string {
    return this.sql.slice(from, to);
  }
  hasIdentifierBefore(offset: number): boolean {
    return offset > this.start && isIdentifierChar(this.sql[offset - 1] as string);
  }
  endsWithKeyword(keyword: string, end = this.end): boolean {
    const offset = end - keyword.length;
    if (offset < this.start) return false;
    // Go compares bytes: only ASCII letters can match (`atomıc` upper-cases to ATOMIC in JS).
    const word = this.sql.slice(offset, end);
    return (
      /^[A-Za-z]+$/.test(word) &&
      word.toUpperCase() === keyword &&
      !this.hasIdentifierBefore(offset)
    );
  }
  isBeginAtomic(): boolean {
    if (!this.endsWithKeyword("ATOMIC")) return false;
    let end = this.end - "ATOMIC".length;
    while (end > this.start && SQL_WHITESPACE.includes(this.sql[end - 1] as string)) end--;
    return this.endsWithKeyword("BEGIN", end);
  }
}

interface State {
  /** The next state, or null when `ch` ends a statement. */
  next(ch: string, data: Data): State | null;
}

const SQL_WHITESPACE = " \t\n\r\f\v";

function isIdentifierChar(ch: string): boolean {
  return ch.charCodeAt(0) >= 0x80 || /[\p{L}\p{N}_$]/u.test(ch);
}

class Ready implements State {
  next(ch: string, data: Data): State | null {
    switch (ch) {
      case "$": {
        const offset = data.end - 1;
        return data.hasIdentifierBefore(offset) ? this : new Tag(offset);
      }
      case "'":
      case '"':
        return new Quote(ch);
      case "-":
        return new Comment();
      case "/":
        return new Block();
      case "\\":
        return new Escape();
      case ";":
        return null;
      case "(":
        return new Paren(this);
      case "c":
      case "C":
        if (data.isBeginAtomic()) return new Atomic(this, data.end);
    }
    return this;
  }
}

class Comment implements State {
  next(ch: string, data: Data): State | null {
    return ch === "-" ? new Dollar("\n") : new Ready().next(ch, data);
  }
}

class Block implements State {
  private depth = 0;
  next(ch: string, data: Data): State | null {
    const window = data.slice(data.end - 2);
    if (window === "/*") {
      this.depth++;
      return this;
    }
    if (this.depth === 0) return new Ready().next(ch, data);
    if (window === "*/" && --this.depth === 0) return new Ready();
    return this;
  }
}

class Quote implements State {
  private escape = false;
  private readonly delimiter: string;
  constructor(delimiter: string) {
    this.delimiter = delimiter;
  }
  next(ch: string, data: Data): State | null {
    if (this.escape) {
      if (ch === this.delimiter) {
        this.escape = false;
        return this;
      }
      return new Ready().next(ch, data);
    }
    if (ch === this.delimiter) this.escape = true;
    return this;
  }
}

class Dollar implements State {
  private readonly delimiter: string;
  constructor(delimiter: string) {
    this.delimiter = delimiter;
  }
  next(_ch: string, data: Data): State | null {
    return data.slice(data.end - this.delimiter.length) === this.delimiter ? new Ready() : this;
  }
}

class Tag implements State {
  private readonly offset: number;
  constructor(offset: number) {
    this.offset = offset;
  }
  next(ch: string, data: Data): State | null {
    if (ch === "$") return new Dollar(data.slice(this.offset));
    if (isIdentifierChar(ch)) return this;
    return new Ready().next(ch, data);
  }
}

class Escape implements State {
  next(): State | null {
    return new Ready();
  }
}

class Paren implements State {
  private prev: State;
  constructor(prev: State) {
    this.prev = prev;
  }
  next(ch: string, data: Data): State | null {
    const curr = this.prev.next(ch, data);
    if (curr === null) {
      this.prev = new Ready();
      return this;
    }
    this.prev = curr;
    if (!(this.prev instanceof Ready)) return this;
    return ch === ")" ? new Ready() : this;
  }
}

class Atomic implements State {
  private pendingEnd = false;
  private hasContent = false;
  private prev: State;
  private statementStart: number;
  constructor(prev: State, statementStart: number) {
    this.prev = prev;
    this.statementStart = statementStart;
  }
  next(ch: string, data: Data): State | null {
    const pendingEnd = this.pendingEnd;
    this.pendingEnd = false;
    if (pendingEnd && !isIdentifierChar(ch)) return new Ready().next(ch, data);
    const curr = this.prev.next(ch, data);
    if (curr === null) {
      this.prev = new Ready();
      this.statementStart = data.end;
      this.hasContent = false;
      return this;
    }
    this.prev = curr;
    if (!(this.prev instanceof Ready)) return this;
    if (!this.hasContent && data.endsWithKeyword("END")) {
      if (isCommentsAndWhitespace(data.slice(this.statementStart, data.end - 3))) {
        this.pendingEnd = true;
      } else this.hasContent = true;
    }
    return this;
  }
}

function isCommentsAndWhitespace(text: string): boolean {
  let i = 0;
  while (i < text.length) {
    if (SQL_WHITESPACE.includes(text[i] as string)) i++;
    else if (text.startsWith("--", i)) {
      const nl = text.indexOf("\n", i + 2);
      if (nl < 0) return true;
      i = nl + 1;
    } else if (text.startsWith("/*", i)) {
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        if (text.startsWith("/*", i - 1)) depth++;
        else if (text.startsWith("*/", i - 1)) depth--;
        i++;
      }
      if (depth > 0) return true;
    } else return false;
  }
  return true;
}
