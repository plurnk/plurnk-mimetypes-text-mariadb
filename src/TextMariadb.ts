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
        const decls = collectDescendants(ctx, "ColumnDeclarationContext");
        for (const d of decls) {
            const uid = (d as { uid?: () => unknown }).uid?.();
            const colName = sqlNameText(uid);
            if (colName) this.addSymbol("field", colName, ctx);
        }
        // Foreign keys are cross-table dependencies: this table USES the
        // referenced table. The referenced tableName lives under a distinct
        // referenceDefinition context (not the table's own tableName), so no
        // self-reference. The table's own name is also a TableNameContext, so
        // we scope the scan to referenceDefinition rather than the whole table.
        for (const fk of collectDescendants(ctx, "ReferenceDefinitionContext")) {
            for (const tn of collectDescendants(fk, "TableNameContext")) {
                const fkName = sqlNameText(tn);
                if (fkName) this.addRef("use", fkName, tn as never, { container: name });
            }
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
        // A view USES every table its SELECT reads — the core SQL graph edge
        // (view → use → source tables). container = the view being created.
        // The view's own name is a fullId, not a tableName, so no self-ref.
        if (name) this.refTableNames(ctx, name);
        return null;
    };

    visitCreateIndex = (ctx: any): null => {
        if (this.inBody) return null;
        const uid = ctx.uid?.();
        const name = sqlNameText(uid);
        if (name) this.addSymbol("field", name, ctx);
        // An index attaches to its ON table. The index name is a uid, not a
        // tableName, so the sole TableNameContext is the ON target.
        if (name) {
            const onTable = collectDescendants(ctx, "TableNameContext")[0];
            const onName = sqlNameText(onTable);
            if (onName) this.addRef("use", onName, onTable as never, { container: name });
        }
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
        // A trigger references its ON table and every table its body touches.
        // The trigger name is a fullId (handled above), distinct from the
        // TableNameContext nodes, so it never self-references.
        if (name) this.refTableNames(ctx, name);
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

    // Emit a `use` ref for every tableName descendant under `ctx`, owned by
    // the created object `container`. The created object's own name is a
    // fullId/uid (distinct context), so it never self-references; FK
    // references are handled in visitColumnCreateTable.
    private refTableNames(ctx: unknown, container: string): void {
        for (const tn of collectDescendants(ctx, "TableNameContext")) {
            const tableName = sqlNameText(tn);
            if (tableName) this.addRef("use", tableName, tn as never, { container });
        }
    }
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

// Recursive descendant collection by ANTLR context class name. The visitor
// prunes subtrees (CREATE handlers don't visitChildren), so refs are gathered
// by walking the parse tree directly — like the column collection, but deep.
function collectDescendants(ctx: unknown, className: string): unknown[] {
    const out: unknown[] = [];
    const walk = (node: unknown): void => {
        const children = (node as { children?: unknown[] }).children;
        if (!Array.isArray(children)) return;
        for (const child of children) {
            if ((child as { constructor?: { name?: string } })?.constructor?.name === className) {
                out.push(child);
            }
            walk(child);
        }
    };
    walk(ctx);
    return out;
}
