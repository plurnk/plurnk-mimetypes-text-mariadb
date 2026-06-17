import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertHandlerConformance } from "@plurnk/plurnk-mimetypes/conformance";
import TextMariadb from "./TextMariadb.ts";

const h = () =>
    new TextMariadb({ mimetype: "text/x-mariadb-sql", glyph: "🐬", extensions: [".sql"] as const });

const SQL = `-- CommentDecoy: not a table
CREATE TABLE users (
  id INT PRIMARY KEY,
  name VARCHAR(64) DEFAULT 'StringDecoy'
);
CREATE TABLE orders (
  id INT PRIMARY KEY,
  user_id INT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE VIEW active_orders AS
  SELECT o.id, u.name
  FROM orders o
  JOIN users u ON u.id = o.user_id;
CREATE INDEX idx_user ON orders (user_id);
CREATE TRIGGER trg_audit AFTER INSERT ON orders
  FOR EACH ROW INSERT INTO audit_log VALUES (NEW.id);
`;

describe("text/x-mariadb-sql references (ANTLR refs grind)", () => {
    it("emits the SQL dependency graph with conformance invariants", async () => {
        const handler = h();
        const symbols = await handler.extractRaw(SQL);
        const refs = await handler.references(SQL);
        const defNames = new Set(symbols.map((s) => s.name));

        assert.ok(refs.length > 0, "produces refs");
        // Invariants (mirror the framework conformance harness).
        for (const r of refs) {
            assert.ok(r.line >= 1 && r.column >= 1, `1-indexed: ${r.name}`);
            assert.equal(typeof r.endColumn, "number");
            assert.equal(r.kind, "use", "SQL refs are declared dependencies");
            // No string-literal / comment leakage.
            assert.notEqual(r.name, "StringDecoy");
            assert.notEqual(r.name, "CommentDecoy");
        }

        // The graph edges, by container (the created object) → used table.
        const edge = (container: string, name: string) =>
            refs.some((r) => r.container === container && r.name === name);

        // View reads its source tables.
        assert.ok(edge("active_orders", "orders"), "view → orders");
        assert.ok(edge("active_orders", "users"), "view → users");
        // FK dependency.
        assert.ok(edge("orders", "users"), "orders FK → users");
        // Index attaches to its table.
        assert.ok(edge("idx_user", "orders"), "index → orders");
        // Trigger references its ON table + body tables.
        assert.ok(edge("trg_audit", "orders"), "trigger → orders");
        assert.ok(edge("trg_audit", "audit_log"), "trigger body → audit_log");

        // Join proof: the view/FK edges resolve to local table defs.
        assert.ok(defNames.has("users") && defNames.has("orders"));
        // A def's own name never appears as a ref (no self-reference).
        assert.ok(!refs.some((r) => r.name === r.container));
    });

    it("strips backtick-quoted identifiers consistently across defs and refs", async () => {
        const handler = h();
        const sql = "CREATE TABLE `the orders` (id INT);\n"
            + "CREATE VIEW v AS SELECT id FROM `the orders`;";
        const symbols = await handler.extractRaw(sql);
        const refs = await handler.references(sql);
        const defNames = new Set(symbols.map((s) => s.name));
        assert.ok(defNames.has("the orders"), "def name unquoted");
        assert.ok(
            refs.some((r) => r.container === "v" && r.name === "the orders"),
            "ref name unquoted to match the def",
        );
    });

    it("passes the SPEC §16 conformance harness", async () => {
        await assertHandlerConformance(h(), {
            source: SQL,
            decoyNames: ["StringDecoy", "CommentDecoy"],
            expectJoins: [
                { refName: "users", container: "active_orders" },
                { refName: "orders", container: "active_orders" },
                { refName: "users", container: "orders" },
            ],
            expectRefs: [
                { name: "users", kind: "use" },
                { name: "orders", kind: "use" },
                { name: "audit_log", kind: "use" },
            ],
        });
    });
});
