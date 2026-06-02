import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TextMariadb from "./TextMariadb.ts";

const metadata = {
    mimetype: "text/x-mariadb-sql",
    glyph: "🐬",
    extensions: [".sql"] as const,
};

describe("TextMariadb — instantiation", () => {
    it("instantiates with metadata", () => {
        const h = new TextMariadb(metadata);
        assert.equal(h.mimetype, "text/x-mariadb-sql");
        assert.equal(h.glyph, "🐬");
    });
});

describe("TextMariadb — extract", () => {
    it("extracts CREATE TABLE + columns", () => {
        const h = new TextMariadb(metadata);
        const src = [
            "CREATE TABLE users (",
            "    id INT AUTO_INCREMENT PRIMARY KEY,",
            "    name VARCHAR(255) NOT NULL,",
            "    email VARCHAR(255) UNIQUE,",
            "    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
            ");",
        ].join("\n");
        const syms = h.extractRaw(src);
        const t = syms.find((s) => s.name === "users" && s.kind === "class");
        assert.ok(t);
        assert.ok(syms.find((s) => s.name === "id"));
        assert.ok(syms.find((s) => s.name === "name"));
        assert.ok(syms.find((s) => s.name === "email"));
        assert.ok(syms.find((s) => s.name === "created_at"));
    });

    it("extracts CREATE VIEW", () => {
        const h = new TextMariadb(metadata);
        const src = "CREATE VIEW active_users AS SELECT * FROM users WHERE deleted_at IS NULL;";
        const syms = h.extractRaw(src);
        const v = syms.find((s) => s.name === "active_users");
        assert.ok(v);
        assert.equal(v.kind, "class");
    });

    it("extracts CREATE INDEX", () => {
        const h = new TextMariadb(metadata);
        const src = "CREATE INDEX idx_users_email ON users (email);";
        const syms = h.extractRaw(src);
        const i = syms.find((s) => s.name === "idx_users_email");
        assert.ok(i);
        assert.equal(i.kind, "field");
    });

    it("extracts CREATE PROCEDURE", () => {
        const h = new TextMariadb(metadata);
        const src = [
            "CREATE PROCEDURE refresh_stats()",
            "BEGIN",
            "    ANALYZE TABLE users;",
            "END;",
        ].join("\n");
        const syms = h.extractRaw(src);
        const p = syms.find((s) => s.name === "refresh_stats");
        assert.ok(p);
        assert.equal(p.kind, "function");
    });

    it("extracts CREATE FUNCTION", () => {
        const h = new TextMariadb(metadata);
        const src = [
            "CREATE FUNCTION add_one(x INT) RETURNS INT",
            "RETURN x + 1;",
        ].join("\n");
        const syms = h.extractRaw(src);
        const f = syms.find((s) => s.name === "add_one");
        assert.ok(f);
        assert.equal(f.kind, "function");
    });

    it("extracts CREATE DATABASE / SCHEMA as module", () => {
        const h = new TextMariadb(metadata);
        const src = [
            "CREATE DATABASE app_db;",
            "CREATE SCHEMA app_schema;",
        ].join("\n");
        const syms = h.extractRaw(src);
        const d = syms.find((s) => s.name === "app_db");
        assert.ok(d);
        assert.equal(d.kind, "module");
        const sc = syms.find((s) => s.name === "app_schema");
        assert.ok(sc);
        assert.equal(sc.kind, "module");
    });

    it("extracts CREATE TRIGGER", () => {
        const h = new TextMariadb(metadata);
        const src = [
            "CREATE TRIGGER touch_updated_at",
            "BEFORE UPDATE ON users",
            "FOR EACH ROW",
            "SET NEW.updated_at = NOW();",
        ].join("\n");
        const syms = h.extractRaw(src);
        const t = syms.find((s) => s.name === "touch_updated_at");
        assert.ok(t);
        assert.equal(t.kind, "method");
    });

    it("excludes DML statements", () => {
        const h = new TextMariadb(metadata);
        const src = [
            "INSERT INTO users (id, name) VALUES (1, 'a');",
            "UPDATE users SET name = 'b' WHERE id = 1;",
            "SELECT * FROM users;",
            "DELETE FROM users;",
            "CREATE TABLE t (id INT);",
        ].join("\n");
        const syms = h.extractRaw(src);
        const names = syms.map((s) => s.name);
        assert.deepEqual(names.toSorted(), ["id", "t"]);
    });

    it("returns empty array for empty input", () => {
        const h = new TextMariadb(metadata);
        assert.deepEqual(h.extractRaw(""), []);
    });

    it("does not throw on malformed source (graceful)", () => {
        const h = new TextMariadb(metadata);
        assert.doesNotThrow(() => h.extractRaw("CREATE TABLE ( broken"));
        assert.doesNotThrow(() => h.extractRaw("@@ totally bogus"));
    });

    it("handles backtick-quoted identifiers", () => {
        const h = new TextMariadb(metadata);
        const src = "CREATE TABLE `users-2024` (`id` INT, `first name` VARCHAR(255));";
        const syms = h.extractRaw(src);
        assert.ok(syms.find((s) => s.name === "users-2024"));
        assert.ok(syms.find((s) => s.name === "id"));
        assert.ok(syms.find((s) => s.name === "first name"));
    });
});

describe("TextMariadb — framework integration", () => {
    it("renders extracted hierarchy via format()", () => {
        const h = new TextMariadb(metadata);
        const out = h.symbolsRaw("CREATE TABLE answers (id INT);");
        assert.ok(out.includes("class answers"));
    });

    it("inherits jsonpath query against the symbol outline", async () => {
        const h = new TextMariadb(metadata);
        const src = "CREATE TABLE users (id INT);";
        const t = await h.query(src, "jsonpath", "$.users");
        assert.equal(t.length, 1);
    });
});

// Real-world smoke against a representative MariaDB/MySQL migration.
describe("TextMariadb — real-world smoke (migration-shape)", () => {
    const SRC = [
        "CREATE DATABASE app_db;",
        "USE app_db;",
        "",
        "CREATE TABLE users (",
        "    id INT AUTO_INCREMENT PRIMARY KEY,",
        "    email VARCHAR(255) NOT NULL UNIQUE,",
        "    name VARCHAR(255) NOT NULL,",
        "    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
        ");",
        "",
        "CREATE INDEX idx_users_email ON users (email);",
        "",
        "CREATE TABLE posts (",
        "    id INT AUTO_INCREMENT PRIMARY KEY,",
        "    user_id INT NOT NULL,",
        "    title VARCHAR(255) NOT NULL,",
        "    body TEXT,",
        "    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE",
        ");",
        "",
        "CREATE INDEX idx_posts_user_id ON posts (user_id);",
        "",
        "CREATE VIEW active_posts AS",
        "    SELECT p.* FROM posts p WHERE p.published_at IS NOT NULL;",
        "",
        "CREATE PROCEDURE refresh_stats()",
        "BEGIN",
        "    ANALYZE TABLE users, posts;",
        "END;",
        "",
        "CREATE TRIGGER touch_users_updated_at",
        "BEFORE UPDATE ON users",
        "FOR EACH ROW",
        "SET NEW.updated_at = NOW();",
    ].join("\n");

    it("surfaces database + tables + columns + indexes + view + procedure + trigger", () => {
        const h = new TextMariadb(metadata);
        const syms = h.extractRaw(SRC);
        const names = new Set(syms.map((s) => s.name));

        assert.ok(names.has("app_db"));
        assert.ok(names.has("users"));
        assert.ok(names.has("posts"));
        assert.ok(names.has("active_posts"));

        assert.ok(names.has("email"));
        assert.ok(names.has("title"));
        assert.ok(names.has("user_id"));

        assert.ok(names.has("idx_users_email"));
        assert.ok(names.has("idx_posts_user_id"));

        assert.ok(names.has("refresh_stats"));
        assert.ok(names.has("touch_users_updated_at"));
    });

    it("kind discrimination", () => {
        const h = new TextMariadb(metadata);
        const syms = h.extractRaw(SRC);
        const byNameKind = new Map(syms.map((s) => [`${s.name}:${s.kind}`, s]));
        assert.ok(byNameKind.has("app_db:module"));
        assert.ok(byNameKind.has("users:class"));
        assert.ok(byNameKind.has("active_posts:class"));
        assert.ok(byNameKind.has("refresh_stats:function"));
        assert.ok(byNameKind.has("touch_users_updated_at:method"));
    });
});
