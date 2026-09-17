#!/usr/bin/env node

import path from "node:path";
import { spawn } from "node:child_process";

// Public bridge contract: argv[2] is an absolute monkeyc-fmt executable. The
// only server configuration is initializationOptions.lineWidth (integer >= 20).
const formatterPath = process.argv[2];
if (!formatterPath || !path.isAbsolute(formatterPath)) {
  console.error(
    "monkeyc-fmt LSP: expected an absolute formatter path in argv[2]",
  );
  process.exit(2);
}

const documents = new Map();
const requests = new Map();
let input = Buffer.alloc(0);
let lineWidth = 100;
let initialized = false;
let shutdownRequested = false;
let writeChain = Promise.resolve();

const ErrorCode = Object.freeze({
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  ServerNotInitialized: -32002,
  RequestCancelled: -32800,
  ContentModified: -32801,
});

function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const frame = Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
    body,
  ]);
  writeChain = writeChain
    .then(
      () =>
        new Promise((resolve, reject) => {
          process.stdout.write(frame, (error) =>
            error ? reject(error) : resolve(),
          );
        }),
    )
    .catch((error) =>
      console.error(`monkeyc-fmt LSP: stdout write failed: ${error.message}`),
    );
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function fail(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  send({ jsonrpc: "2.0", id, error });
}

function validId(id) {
  return (
    typeof id === "string" ||
    (typeof id === "number" && Number.isFinite(id)) ||
    id === null
  );
}

function parseFrames() {
  while (true) {
    const headerEnd = input.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const header = input.subarray(0, headerEnd).toString("ascii");
    let length;
    for (const line of header.split("\r\n")) {
      const match = /^content-length\s*:\s*(\d+)\s*$/i.exec(line);
      if (match) length = Number(match[1]);
    }
    if (!Number.isSafeInteger(length)) {
      console.error("monkeyc-fmt LSP: malformed frame without Content-Length");
      process.exitCode = 1;
      process.stdin.destroy();
      return;
    }
    const bodyStart = headerEnd + 4;
    if (input.length < bodyStart + length) return;
    const body = input.subarray(bodyStart, bodyStart + length);
    input = input.subarray(bodyStart + length);
    let message;
    try {
      message = JSON.parse(body.toString("utf8"));
    } catch (error) {
      send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: `Parse error: ${error.message}` },
      });
      continue;
    }
    dispatch(message);
  }
}

function paramsObject(message) {
  return message.params !== undefined &&
    (message.params === null ||
      typeof message.params !== "object" ||
      Array.isArray(message.params))
    ? null
    : (message.params ?? {});
}

function initialize(message) {
  const params = paramsObject(message);
  if (!params)
    return fail(
      message.id,
      ErrorCode.InvalidParams,
      "initialize params must be an object",
    );
  const options = params.initializationOptions ?? {};
  if (
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options)
  ) {
    return fail(
      message.id,
      ErrorCode.InvalidParams,
      "initializationOptions must be an object",
    );
  }
  if (options.lineWidth !== undefined) {
    if (!Number.isSafeInteger(options.lineWidth) || options.lineWidth < 20) {
      return fail(
        message.id,
        ErrorCode.InvalidParams,
        "initializationOptions.lineWidth must be a safe integer >= 20",
      );
    }
    lineWidth = options.lineWidth;
  }
  initialized = true;
  result(message.id, {
    capabilities: {
      positionEncoding: "utf-16",
      textDocumentSync: { openClose: true, change: 1 },
      documentFormattingProvider: true,
    },
    serverInfo: { name: "monkeyc-fmt" },
  });
}

function didOpen(message) {
  const document = paramsObject(message)?.textDocument;
  if (
    !document ||
    typeof document.uri !== "string" ||
    typeof document.text !== "string" ||
    !Number.isInteger(document.version)
  ) {
    console.error("monkeyc-fmt LSP: ignoring malformed didOpen notification");
    return;
  }
  cancelForUri(
    document.uri,
    ErrorCode.ContentModified,
    "Document was reopened",
  );
  documents.set(document.uri, {
    text: document.text,
    version: document.version,
  });
}

function didChange(message) {
  const params = paramsObject(message);
  const identity = params?.textDocument;
  const changes = params?.contentChanges;
  const current = identity && documents.get(identity.uri);
  if (!current) return;
  if (Number.isInteger(identity.version) && identity.version <= current.version)
    return;
  cancelForUri(
    identity.uri,
    ErrorCode.ContentModified,
    "Document changed while formatting",
  );
  if (
    !Number.isInteger(identity.version) ||
    !Array.isArray(changes) ||
    changes.length === 0 ||
    changes.some(
      (change) =>
        !change ||
        typeof change.text !== "string" ||
        change.range !== undefined ||
        change.rangeLength !== undefined,
    )
  ) {
    // Never format the old snapshot after receiving an update we cannot apply.
    documents.set(identity.uri, {
      text: null,
      version: Number.isInteger(identity.version)
        ? identity.version
        : current.version,
    });
    console.error(
      "monkeyc-fmt LSP: document is unsynchronized; expected a full-text didChange",
    );
    return;
  }
  documents.set(identity.uri, {
    text: changes.at(-1).text,
    version: identity.version,
  });
}

function didClose(message) {
  const identity = paramsObject(message)?.textDocument;
  if (!identity || typeof identity.uri !== "string") {
    console.error("monkeyc-fmt LSP: ignoring malformed didClose notification");
    return;
  }
  cancelForUri(
    identity.uri,
    ErrorCode.ContentModified,
    "Document closed while formatting",
  );
  documents.delete(identity.uri);
}

function validateFormatting(message) {
  const params = paramsObject(message);
  if (
    !params ||
    !params.textDocument ||
    typeof params.textDocument.uri !== "string" ||
    !params.options ||
    typeof params.options !== "object" ||
    Array.isArray(params.options)
  ) {
    return "formatting requires textDocument.uri and options";
  }
  if (
    !Number.isInteger(params.options.tabSize) ||
    params.options.tabSize < 1 ||
    params.options.tabSize > 16
  ) {
    return "options.tabSize must be an integer from 1 through 16";
  }
  if (params.options.insertSpaces !== true) {
    return "options.insertSpaces must be true; monkeyc-fmt does not support tabs";
  }
  return null;
}

function eofPosition(text) {
  let line = 0;
  let character = 0;
  for (let index = 0; index < text.length; ) {
    const code = text.charCodeAt(index);
    if (code === 13) {
      if (text.charCodeAt(index + 1) === 10) index++;
      line++;
      character = 0;
    } else if (code === 10) {
      line++;
      character = 0;
    } else {
      character++;
    }
    index++;
  }
  return { line, character };
}

function formatDocument(message) {
  const validationError = validateFormatting(message);
  if (validationError)
    return fail(message.id, ErrorCode.InvalidParams, validationError);
  const uri = message.params.textDocument.uri;
  const document = documents.get(uri);
  if (!document)
    return fail(
      message.id,
      ErrorCode.InvalidParams,
      `document is not open: ${uri}`,
    );
  if (document.text === null)
    return fail(
      message.id,
      ErrorCode.ContentModified,
      "Document is not synchronized; send a full-text update",
    );

  const child = spawn(
    formatterPath,
    [
      "--indent-width",
      String(message.params.options.tabSize),
      "--line-width",
      String(lineWidth),
      "-",
    ],
    { shell: false, stdio: ["pipe", "pipe", "pipe"] },
  );
  const pending = {
    id: message.id,
    uri,
    version: document.version,
    child,
    settled: false,
  };
  requests.set(message.id, pending);
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.on("error", (error) =>
    settleFailure(
      pending,
      ErrorCode.InternalError,
      `could not start formatter: ${error.message}`,
    ),
  );
  child.on("close", (code, signal) => {
    if (pending.settled) return;
    requests.delete(pending.id);
    pending.settled = true;
    const latest = documents.get(uri);
    if (
      !latest ||
      latest.version !== pending.version ||
      latest.text !== document.text
    ) {
      return fail(
        pending.id,
        ErrorCode.ContentModified,
        "Document changed while formatting",
      );
    }
    const diagnostic = Buffer.concat(stderr).toString("utf8").trim();
    if (code !== 0) {
      const detail =
        diagnostic ||
        (signal ? `terminated by ${signal}` : `exited with status ${code}`);
      return fail(
        pending.id,
        ErrorCode.InternalError,
        `monkeyc-fmt failed: ${detail}`,
      );
    }
    const formatted = Buffer.concat(stdout).toString("utf8");
    if (formatted === document.text) return result(pending.id, []);
    result(pending.id, [
      {
        range: {
          start: { line: 0, character: 0 },
          end: eofPosition(document.text),
        },
        newText: formatted,
      },
    ]);
  });
  child.stdin.on("error", (error) => {
    if (error.code !== "EPIPE")
      settleFailure(
        pending,
        ErrorCode.InternalError,
        `formatter stdin failed: ${error.message}`,
      );
  });
  child.stdin.end(document.text);
}

function settleFailure(pending, code, message) {
  if (pending.settled) return;
  pending.settled = true;
  requests.delete(pending.id);
  pending.child.kill();
  fail(pending.id, code, message);
}

function cancelForUri(uri, code, message) {
  for (const pending of requests.values()) {
    if (pending.uri === uri) settleFailure(pending, code, message);
  }
}

function cancelRequest(message) {
  const id = paramsObject(message)?.id;
  const pending = requests.get(id);
  if (pending)
    settleFailure(pending, ErrorCode.RequestCancelled, "Request cancelled");
}

function dispatch(message) {
  if (
    !message ||
    typeof message !== "object" ||
    Array.isArray(message) ||
    message.jsonrpc !== "2.0" ||
    typeof message.method !== "string"
  ) {
    fail(
      validId(message?.id) ? message.id : null,
      ErrorCode.InvalidRequest,
      "Invalid Request",
    );
    return;
  }
  const isRequest = Object.hasOwn(message, "id");
  if (isRequest && !validId(message.id))
    return fail(null, ErrorCode.InvalidRequest, "Invalid request id");
  if (message.method !== "exit") {
    if (shutdownRequested) {
      if (isRequest)
        fail(message.id, ErrorCode.InvalidRequest, "Server has shut down");
      return;
    }
    if (!initialized && message.method !== "initialize") {
      if (isRequest)
        fail(
          message.id,
          ErrorCode.ServerNotInitialized,
          "Server is not initialized",
        );
      return;
    }
    if (initialized && message.method === "initialize") {
      if (isRequest)
        fail(
          message.id,
          ErrorCode.InvalidRequest,
          "Server is already initialized",
        );
      return;
    }
    if (isRequest && requests.has(message.id)) {
      return fail(
        message.id,
        ErrorCode.InvalidRequest,
        "Request id is already in use",
      );
    }
  }

  switch (message.method) {
    case "initialize":
      if (isRequest) initialize(message);
      break;
    case "initialized":
      break;
    case "textDocument/didOpen":
      didOpen(message);
      break;
    case "textDocument/didChange":
      didChange(message);
      break;
    case "textDocument/didClose":
      didClose(message);
      break;
    case "textDocument/formatting":
      if (isRequest) formatDocument(message);
      break;
    case "$/cancelRequest":
      cancelRequest(message);
      break;
    case "shutdown":
      if (isRequest) {
        shutdownRequested = true;
        for (const pending of requests.values()) {
          settleFailure(
            pending,
            ErrorCode.RequestCancelled,
            "Server is shutting down",
          );
        }
        result(message.id, null);
      }
      break;
    case "exit": {
      for (const pending of requests.values()) pending.child.kill();
      const code = shutdownRequested ? 0 : 1;
      process.stdin.pause();
      writeChain.finally(() => process.exit(code));
      break;
    }
    default:
      if (isRequest)
        fail(
          message.id,
          ErrorCode.MethodNotFound,
          `Method not found: ${message.method}`,
        );
  }
}

process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  parseFrames();
});
process.stdin.on("error", (error) => {
  console.error(`monkeyc-fmt LSP: stdin failed: ${error.message}`);
  process.exitCode = 1;
});
process.stdin.on("end", () => {
  for (const pending of requests.values()) pending.child.kill();
});
process.stdin.resume();
