// todo-fold.test.ts
import { describe, expect, test } from "bun:test";
import { TODO_EPOCH_MS, eligible, foldTodos, parseMarker } from "./todo-fold";

const T = TODO_EPOCH_MS + 1_000_000;
const post = (seq: number, text: string, extra: object = {}) =>
  ({ seq, ts: T + seq, type: "post", text, handle: "reagan", ...extra });

describe("parseMarker", () => {
  test("create with title and description", () =>
    expect(parseMarker("!todo Fix reset button\nGreyed out after failed upload")).toEqual({
      op: "todo", title: "Fix reset button", description: "Greyed out after failed upload" }));
  test("bare lifecycle ops exact-match only", () => {
    expect(parseMarker("!done")).toEqual({ op: "done" });
    expect(parseMarker("!done thanks")).toBeNull();
  });
  test("assign takes exactly one @handle, lowercased", () => {
    expect(parseMarker("!assign @Nicholas")).toEqual({ op: "assign", targetHandle: "nicholas" });
    expect(parseMarker("!assign nicholas")).toBeNull();
    expect(parseMarker("!assign @a @b")).toBeNull();
  });
  test("ordinary text is not a marker", () => expect(parseMarker("fixed it!")).toBeNull());
});

describe("foldTodos", () => {
  test("create opens an eligible todo", () => {
    const board = foldTodos([post(10, "!todo Emoji burst lags")]);
    expect(board.get(10)).toMatchObject({ status: "open", holders: [], title: "Emoji burst lags" });
    expect(eligible(board).map(t => t.seq)).toEqual([10]);
  });
  test("claim then release returns to eligible", () => {
    const entries = [post(10, "!todo X"), post(11, "!claim", { handle: "nicholas", inReplyTo: 10 })];
    expect(eligible(foldTodos(entries))).toHaveLength(0);
    entries.push(post(12, "!release", { handle: "nicholas", inReplyTo: 10 }));
    expect(eligible(foldTodos(entries))).toHaveLength(1);
  });
  test("assign holds it; unassign of that handle frees it", () => {
    const entries = [post(10, "!todo X"), post(11, "!assign @elven", { inReplyTo: 10 })];
    expect(eligible(foldTodos(entries))).toHaveLength(0);
    entries.push(post(12, "!unassign @elven", { inReplyTo: 10 }));
    expect(eligible(foldTodos(entries))).toHaveLength(1);
  });
  test("done and cancel close; reopen reopens unheld", () => {
    const entries = [post(10, "!todo X"), post(11, "!done", { inReplyTo: 10 })];
    expect(foldTodos(entries).get(10)!.status).toBe("done");
    entries.push(post(12, "!reopen", { inReplyTo: 10 }));
    expect(eligible(foldTodos(entries))).toHaveLength(1);
  });
  test("todoCurrent wins over parsed text; edit updates content", () => {
    const board = foldTodos([
      post(10, "!todo Old title", { todoCurrent: { title: "New title" } })]);
    expect(board.get(10)!.title).toBe("New title");
    const edited = foldTodos([post(10, "!todo Old"), post(11, "!edit Newer", { inReplyTo: 10 })]);
    expect(edited.get(10)!.title).toBe("Newer");
  });
  test("pre-epoch and non-post entries never fold", () => {
    const board = foldTodos([
      { seq: 1, ts: TODO_EPOCH_MS - 1, type: "post", text: "!todo Ancient", handle: "x" },
      { seq: 2, ts: T, type: "system", text: "!todo Systemish", handle: "x" }]);
    expect(board.size).toBe(0);
  });
  test("lifecycle op replying to a non-todo is ignored", () => {
    const board = foldTodos([post(10, "hello"), post(11, "!done", { inReplyTo: 10 })]);
    expect(board.size).toBe(0);
  });
});
