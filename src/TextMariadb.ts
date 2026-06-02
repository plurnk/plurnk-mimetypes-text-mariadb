import { AntlrExtractor, withExtractor } from "@plurnk/plurnk-mimetypes";
import type { ExtractionVisitor } from "@plurnk/plurnk-mimetypes";
import { CharStream, CommonTokenStream } from "antlr4ng";
import { MariaDBLexer } from "./generated/MariaDBLexer.ts";
import { MariaDBParser } from "./generated/MariaDBParser.ts";
import { MariaDBParserVisitor } from "./generated/MariaDBParserVisitor.ts";

// text/x-mariadb-sql handler. ANTLR grammar from grammars-v4/sql/mariadb.
// Mostly MySQL-compatible (MariaDB is a MySQL fork).
//
// Parser entry rule: root.
export default class TextMariadb extends AntlrExtractor {
    protected parseTree(content: string): unknown {
        const lexer = new MariaDBLexer(CharStream.fromString(content));
        const tokens = new CommonTokenStream(lexer);
        const parser = new MariaDBParser(tokens);
        parser.removeErrorListeners();
        return parser.root();
    }

    protected createVisitor(): ExtractionVisitor {
        return new TextMariadbVisitor() as unknown as ExtractionVisitor;
    }
}

// SPEC §3 mapping:
//   CREATE TABLE name (cols)         → class; each columnDeclaration → field
//   CREATE VIEW name AS              → class
//   CREATE INDEX name ON table       → field
//   CREATE TRIGGER name              → method
//   CREATE FUNCTION name (args)      → function
//   CREATE PROCEDURE name (args)     → function
//   CREATE DATABASE/SCHEMA name      → module
//   CREATE EVENT name                → method (scheduled job)
//   DML statements                   → excluded
class TextMariadbVisitor extends withExtractor(MariaDBParserVisitor) {
    // The MariaDB grammar splits `createTable` into THREE labeled alternatives:
    //   # columnCreateTable  (the normal CREATE TABLE name (cols))
    //   # copyCreateTable    (CREATE TABLE name LIKE other)
    //   # queryCreateTable   (CREATE TABLE name AS SELECT ...)
    // ANTLR generates a distinct context class + visitor method per label,
    // so there is no `visitCreateTable` — we hook each alt by name.
    visitColumnCreateTable = (ctx: any): null => {
        if (this.inBody) return null;
        const tn = collectChildren(ctx, "tableName")[0];
        const name = sqlNameText(tn);
        if (!name) return null;
        this.addSymbol("class", name, ctx);
        const decls = findDescendants(ctx, "ColumnDeclarationContext");
        for (const d of decls) {
            const uid = (d as { uid?: () => unknown }).uid?.();
            const colName = sqlNameText(uid);
            if (colName) this.addSymbol("field", colName, ctx);
        }
        return null;
    };

    visitCopyCreateTable = (ctx: any): null => {
        if (this.inBody) return null;
        const tns = collectChildren(ctx, "tableName");
        const name = sqlNameText(tns[0]);
        if (name) this.addSymbol("class", name, ctx);
        return null;
    };

    visitQueryCreateTable = (ctx: any): null => {
        if (this.inBody) return null;
        const tn = collectChildren(ctx, "tableName")[0];
        const name = sqlNameText(tn);
        if (name) this.addSymbol("class", name, ctx);
        return null;
    };

    visitCreateView = (ctx: any): null => {
        if (this.inBody) return null;
        const fid = ctx.fullId?.();
        const name = sqlNameText(fid);
        if (name) this.addSymbol("class", name, ctx);
        return null;
    };

    visitCreateIndex = (ctx: any): null => {
        if (this.inBody) return null;
        const uid = ctx.uid?.();
        const name = sqlNameText(uid);
        if (name) this.addSymbol("field", name, ctx);
        return null;
    };

    visitCreateTrigger = (ctx: any): null => {
        if (this.inBody) return null;
        // The grammar names the trigger via the label `thisTrigger = fullId`.
        // ANTLR exposes it on the underscore-prefixed private field; there
        // are two FullIdContext children (`thisTrigger` for the trigger
        // name and `otherTrigger` for the FOLLOWS/PRECEDES target), so
        // calling `fullId()` returns whichever depending on overload.
        const fid = ctx._thisTrigger ?? collectChildren(ctx, "fullId")[0];
        const name = sqlNameText(fid);
        if (name) this.addSymbol("method", name, ctx);
        return null;
    };

    visitCreateProcedure = (ctx: any): null => {
        if (this.inBody) return null;
        const fid = ctx.fullId?.();
        const name = sqlNameText(fid);
        if (name) this.addSymbol("function", name, ctx);
        return null;
    };

    visitCreateFunction = (ctx: any): null => {
        if (this.inBody) return null;
        const fid = ctx.fullId?.();
        const name = sqlNameText(fid);
        if (name) this.addSymbol("function", name, ctx);
        return null;
    };

    visitCreateDatabase = (ctx: any): null => {
        if (this.inBody) return null;
        const uid = ctx.uid?.();
        const name = sqlNameText(uid);
        if (name) this.addSymbol("module", name, ctx);
        return null;
    };

    visitCreateEvent = (ctx: any): null => {
        if (this.inBody) return null;
        const fid = ctx.fullId?.();
        const name = sqlNameText(fid);
        if (name) this.addSymbol("method", name, ctx);
        return null;
    };
}

function sqlNameText(ctx: unknown): string | null {
    if (!ctx) return null;
    const raw = (ctx as { getText?: () => string }).getText?.();
    if (!raw) return null;
    return unquoteSqlIdentifier(raw);
}

function unquoteSqlIdentifier(s: string): string {
    if (s.length >= 2) {
        const first = s[0];
        const last = s[s.length - 1];
        if (first === "`" && last === "`") return s.slice(1, -1).replace(/``/g, "`");
        if (first === '"' && last === '"') return s.slice(1, -1).replace(/""/g, '"');
    }
    return s;
}

function collectChildren(ctx: unknown, methodName: string): unknown[] {
    const node = ctx as Record<string, unknown>;
    const accessor = node[methodName] as ((...args: unknown[]) => unknown) | undefined;
    if (typeof accessor !== "function") return [];
    const raw = accessor.call(node);
    if (Array.isArray(raw)) return raw;
    return raw ? [raw] : [];
}

function findDescendants(root: unknown, ctxName: string): unknown[] {
    const out: unknown[] = [];
    const stack: unknown[] = [root];
    while (stack.length > 0) {
        const node = stack.pop() as {
            constructor?: { name?: string };
            getChildCount?: () => number;
            getChild?: (i: number) => unknown;
        };
        if (!node) continue;
        if (node.constructor?.name === ctxName) out.push(node);
        const count = node.getChildCount?.() ?? 0;
        for (let i = 0; i < count; i += 1) stack.push(node.getChild?.(i));
    }
    return out;
}
