import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv } from "./csv.js";

test("parseCsv: basic header + rows", () => {
  const rows = parseCsv("a,b,c\n1,2,3\n4,5,6\n");
  assert.deepEqual(rows, [{ a: "1", b: "2", c: "3" }, { a: "4", b: "5", c: "6" }]);
});

test("parseCsv: quoted field with embedded comma and escaped quote", () => {
  const rows = parseCsv('name,note\n"Smith, John","he said ""hi"""\n');
  assert.deepEqual(rows, [{ name: "Smith, John", note: 'he said "hi"' }]);
});

test("parseCsv: handles real MoneyPuck-style numeric rows (no trailing newline)", () => {
  const text = "playerId,name,xGoals,goals\n8480843,Lukas Dostal,0.412,0.0";
  const rows = parseCsv(text);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Lukas Dostal");
  assert.equal(rows[0].xGoals, "0.412");
});

test("parseCsv: empty input returns empty array", () => {
  assert.deepEqual(parseCsv(""), []);
});
