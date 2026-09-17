import test from "node:test";
import assert from "node:assert/strict";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = path.join(root, "src", "server.mjs");

function formatterPath() {
  const configured = process.env.MONKEYC_FMT;
  if (configured) {
    const absolute = path.resolve(configured);
    accessSync(absolute, constants.X_OK);
    return absolute;
  }
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const name of process.platform === "win32"
      ? ["monkeyc-fmt.exe", "monkeyc-fmt"]
      : ["monkeyc-fmt"]) {
      const candidate = path.resolve(directory || ".", name);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  throw new Error(
    "set MONKEYC_FMT to an absolute monkeyc-fmt binary, or put monkeyc-fmt on PATH",
  );
}

const formatter = formatterPath();

function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),
    body,
  ]);
}

class Client {
  constructor(options = {}) {
    this.child = spawn(process.execPath, [server, formatter], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.buffer = Buffer.alloc(0);
    this.messages = [];
    this.waiters = [];
    this.stderr = "";
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    this.child.stdout.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.#parse();
    });
    this.lineWidth = options.lineWidth;
  }

  #parse() {
    while (true) {
      const end = this.buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(
        this.buffer.subarray(0, end).toString("ascii"),
      );
      assert.ok(match, "server response has Content-Length");
      const length = Number(match[1]);
      const start = end + 4;
      if (this.buffer.length < start + length) return;
      const message = JSON.parse(
        this.buffer.subarray(start, start + length).toString("utf8"),
      );
      this.buffer = this.buffer.subarray(start + length);
      const waiter = this.waiters.find(({ predicate }) => predicate(message));
      if (waiter) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        this.messages.push(message);
      }
    }
  }

  send(...messages) {
    this.child.stdin.write(Buffer.concat(messages.map(frame)));
  }

  sendFragmented(message) {
    const bytes = frame(message);
    for (let offset = 0; offset < bytes.length; offset += 3) {
      this.child.stdin.write(bytes.subarray(offset, offset + 3));
    }
  }

  waitFor(predicate) {
    const existing = this.messages.find(predicate);
    if (existing) {
      this.messages.splice(this.messages.indexOf(existing), 1);
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(
          new Error(
            `timed out waiting for server message; stderr: ${this.stderr}`,
          ),
        );
      }, 10_000);
      this.waiters.push(waiter);
    });
  }

  response(id) {
    return this.waitFor((message) => message.id === id);
  }

  async initialize(id = 1) {
    this.send({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        capabilities: {},
        initializationOptions:
          this.lineWidth === undefined ? {} : { lineWidth: this.lineWidth },
      },
    });
    const response = await this.response(id);
    assert.equal(response.error, undefined);
    this.send({ jsonrpc: "2.0", method: "initialized", params: {} });
    return response;
  }

  async stop() {
    if (this.child.exitCode !== null) return;
    this.send(
      { jsonrpc: "2.0", id: 9000, method: "shutdown", params: null },
      { jsonrpc: "2.0", method: "exit", params: null },
    );
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.child.kill();
        reject(new Error(`server did not exit; stderr: ${this.stderr}`));
      }, 5_000);
      this.child.once("exit", (code) => {
        clearTimeout(timer);
        try {
          assert.equal(code, 0, this.stderr);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  }
}

function open(uri, text, version = 1) {
  return {
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: { uri, languageId: "monkeyc", version, text },
    },
  };
}

function change(uri, text, version) {
  return {
    jsonrpc: "2.0",
    method: "textDocument/didChange",
    params: {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    },
  };
}

function formatting(id, uri, options = { tabSize: 4, insertSpaces: true }) {
  return {
    jsonrpc: "2.0",
    id,
    method: "textDocument/formatting",
    params: {
      textDocument: { uri },
      options,
    },
  };
}

test("initializes with only the formatting and full-sync capabilities", async (t) => {
  const client = new Client();
  t.after(() => client.stop());
  const response = await client.initialize();
  assert.deepEqual(response.result.capabilities, {
    positionEncoding: "utf-16",
    textDocumentSync: { openClose: true, change: 1 },
    documentFormattingProvider: true,
  });

  client.send({
    jsonrpc: "2.0",
    id: 2,
    method: "workspace/executeCommand",
    params: {},
  });
  assert.equal((await client.response(2)).error.code, -32601);
});

test("formats Unicode and CRLF from the unsaved buffer with a UTF-16 whole-document edit", async (t) => {
  const client = new Client();
  t.after(() => client.stop());
  await client.initialize();
  const uri = "file:///never-read-from-disk.mc";
  const original = 'var emoji="😀";\r\nfunction f(){return "😀";}';
  client.send(
    open(uri, "var stale=0;"),
    change(uri, original, 2),
    formatting(2, uri),
  );
  const response = await client.response(2);
  assert.equal(response.error, undefined);
  assert.deepEqual(response.result, [
    {
      range: {
        start: { line: 0, character: 0 },
        end: { line: 1, character: 26 },
      },
      newText: 'var emoji = "😀";\nfunction f() {\n    return "😀";\n}\n',
    },
  ]);
});

test("returns no edits for unchanged text and rejects closed or invalid documents", async (t) => {
  const client = new Client();
  t.after(() => client.stop());
  await client.initialize();
  const uri = "file:///clean.mc";
  client.send(open(uri, "var x = 1;\n"), formatting(2, uri));
  assert.deepEqual((await client.response(2)).result, []);

  client.send(
    {
      jsonrpc: "2.0",
      method: "textDocument/didClose",
      params: { textDocument: { uri } },
    },
    formatting(3, uri),
  );
  assert.equal((await client.response(3)).error.code, -32602);

  const broken = "file:///broken.mc";
  client.send(open(broken, "function broken( {"), formatting(4, broken));
  const failure = await client.response(4);
  assert.equal(failure.error.code, -32603);
  assert.equal(failure.result, undefined);
});

test("uses line width and indentation, accepts standard hints, and rejects tabs", async (t) => {
  const narrow = new Client({ lineWidth: 20 });
  const wide = new Client({ lineWidth: 120 });
  t.after(async () => {
    await Promise.all([narrow.stop(), wide.stop()]);
  });
  await Promise.all([narrow.initialize(), wide.initialize()]);
  const uri = "file:///options.mc";
  const source =
    "function f(){var descriptiveName=someFunction(firstArgument,secondArgument,thirdArgument);}";
  narrow.send(
    open(uri, source),
    formatting(2, uri, { tabSize: 2, insertSpaces: true }),
  );
  wide.send(
    open(uri, source),
    formatting(2, uri, { tabSize: 2, insertSpaces: true }),
  );
  const [narrowResult, wideResult] = await Promise.all([
    narrow.response(2),
    wide.response(2),
  ]);
  assert.notEqual(narrowResult.result[0].newText, wideResult.result[0].newText);
  assert.match(narrowResult.result[0].newText, /\n  var descriptiveName/);

  narrow.send(formatting(3, uri, { tabSize: 4, insertSpaces: false }));
  assert.equal((await narrow.response(3)).error.code, -32602);
  narrow.send(
    formatting(4, uri, {
      tabSize: 2,
      insertSpaces: true,
      trimFinalNewlines: true,
      insertFinalNewline: true,
    }),
  );
  assert.deepEqual((await narrow.response(4)).result, narrowResult.result);
  narrow.send(formatting(5, uri, { tabSize: 17, insertSpaces: true }));
  assert.equal((await narrow.response(5)).error.code, -32602);
});

test("accepts fragmented and coalesced frames and deterministically cancels stale work", async (t) => {
  const client = new Client();
  t.after(() => client.stop());
  client.sendFragmented({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { capabilities: {} },
  });
  assert.equal((await client.response(1)).error, undefined);
  const uri = "file:///race.mc";
  client.send(open(uri, "function f(){return 1;}"), formatting(2, uri), {
    jsonrpc: "2.0",
    method: "$/cancelRequest",
    params: { id: 2 },
  });
  assert.equal((await client.response(2)).error.code, -32800);

  client.send(formatting(3, uri), change(uri, "function f(){return 2;}", 2));
  assert.equal((await client.response(3)).error.code, -32801);

  client.send(formatting(4, uri));
  assert.match((await client.response(4)).result[0].newText, /return 2;/);
});

test("enforces initialization and shutdown request boundaries", async (t) => {
  const client = new Client();
  t.after(() => client.stop());
  client.send(formatting(0, "file:///not-initialized.mc"));
  assert.equal((await client.response(0)).error.code, -32002);
  await client.initialize();
  client.send({ jsonrpc: "2.0", id: 2, method: "shutdown", params: null });
  assert.deepEqual((await client.response(2)).result, null);
  client.send(formatting(3, "file:///already-shut-down.mc"));
  assert.equal((await client.response(3)).error.code, -32600);
  client.send({ jsonrpc: "2.0", method: "exit", params: null });
  const code = await new Promise((resolve) =>
    client.child.once("exit", resolve),
  );
  assert.equal(code, 0, client.stderr);
});

test("rejects unsynchronized text instead of returning stale edits and can resynchronize", async (t) => {
  const client = new Client();
  t.after(() => client.stop());
  await client.initialize();
  const uri = "file:///unsynchronized.mc";
  client.send(
    open(uri, "var x=1;"),
    {
      jsonrpc: "2.0",
      method: "textDocument/didChange",
      params: {
        textDocument: { uri, version: 2 },
        contentChanges: [
          {
            range: {
              start: { line: 0, character: 6 },
              end: { line: 0, character: 7 },
            },
            text: "2",
          },
        ],
      },
    },
    formatting(2, uri),
  );
  assert.equal((await client.response(2)).error.code, -32801);
  client.send(change(uri, "var x=3;", 3), formatting(3, uri));
  assert.equal((await client.response(3)).result[0].newText, "var x = 3;\n");
});
