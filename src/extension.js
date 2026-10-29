"use strict";

const vscode = require("vscode");
const { parseScg } = require("./scg-parser");
const { parseEtl } = require("./etl-parser");
const { parseEcl } = require("./ecl-parser");

// IDs must match contributes.languages in package.json.
const PARSERS = Object.freeze({
  "snomed-scg": { parse: parseScg, source: "SNOMED SCG" },
  "snomed-etl": { parse: parseEtl, source: "SNOMED ETL" },
  "snomed-ecl": { parse: parseEcl, source: "SNOMED ECL" }
});

function activate(context) {
  const diagnostics = vscode.languages.createDiagnosticCollection("snomed");
  const timers = new Map();
  const DEBOUNCE_MS = 250;

  context.subscriptions.push(diagnostics);

  function keyFor(document) {
    return document.uri.toString();
  }

  function clearTimer(document) {
    const key = keyFor(document);
    clearTimeout(timers.get(key));
    timers.delete(key);
  }

  function validate(document) {
    const config = PARSERS[document.languageId];
    if (!config) {
      diagnostics.delete(document.uri);
      return;
    }

    const version = document.version;
    const text = document.getText();
    let errors;
    try {
      errors = config.parse(text);
      if (!Array.isArray(errors)) throw new TypeError("Parser must return an array of errors");
    } catch (error) {
      // Don't produce misleading user diagnostics for extension bugs.
      console.error(`${config.source} parser failed`, error);
      diagnostics.delete(document.uri);
      return;
    }

    // Check before publishing: a future async parser could also use the
    // same document.version guard after its awaited work completes.
    if (document.isClosed || document.version !== version) return;

    const items = errors.map(error => {
      const bounded = value => Math.max(0, Math.min(text.length, value));
      let start = bounded(Number.isFinite(error.offset) ? error.offset : 0);
      let end = bounded(Number.isFinite(error.end) ? error.end : start);
      if (end < start) end = start;
      if (start === end) {
        if (start < text.length) end = start + 1;
        else if (start > 0) start--;
      }

      const range = new vscode.Range(
        document.positionAt(start),
        document.positionAt(end)
      );
      const diagnostic = new vscode.Diagnostic(
        range,
        String(error.message ?? "Invalid syntax"),
        error.severity === "warning"
          ? vscode.DiagnosticSeverity.Warning
          : vscode.DiagnosticSeverity.Error
      );
      diagnostic.source = config.source;
      return diagnostic;
    });

    diagnostics.set(document.uri, items);
  }

  function schedule(document) {
    clearTimer(document);
    if (!PARSERS[document.languageId]) {
      diagnostics.delete(document.uri);
      return;
    }
    timers.set(keyFor(document), setTimeout(() => {
      timers.delete(keyFor(document));
      if (!document.isClosed) validate(document);
    }, DEBOUNCE_MS));
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(validate),
    vscode.workspace.onDidChangeTextDocument(event => schedule(event.document)),
    vscode.workspace.onDidSaveTextDocument(document => {
      clearTimer(document);
      validate(document);
    }),
    vscode.workspace.onDidCloseTextDocument(document => {
      clearTimer(document);
      diagnostics.delete(document.uri);
    }),
    { dispose() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    } }
  );

  for (const document of vscode.workspace.textDocuments) validate(document);
}

function deactivate() {}

module.exports = { activate, deactivate };
