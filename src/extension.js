
const vscode = require("vscode");

const { parseScg } = require("./scg-parser");
const { parseEtl } = require("./etl-parser");

function activate(context) {
  const diagnostics =
    vscode.languages.createDiagnosticCollection("snomed");

  const timers = new Map();

  const supportedLanguages = new Set([
    "snomed-scg",
    "snomed-etl"
  ]);

  // Choose the appropriate parser.
  function getParser(document) {
    switch (document.languageId) {
      case "snomed-scg":
        return parseScg;

      case "snomed-etl":
        return parseEtl;

      default:
        return null;
    }
  }

  // Validate the current document.
  function validate(document) {
    const parser = getParser(document);

    if (!parser) {
      diagnostics.delete(document.uri);
      return;
    }

    const text = document.getText();
    let errors;

    try {
      errors = parser(text);
    } catch (error) {
      console.error("SNOMED parser failed:", error);
      diagnostics.delete(document.uri);
      return;
    }

    const items = errors.map(error => {
      const offset = Math.max(
        0,
        Math.min(error.offset ?? 0, text.length)
      );

      let start = offset;
      let end = Math.max(
        offset,
        Math.min(error.end ?? offset, text.length)
      );

      // Make zero-width errors visible, including at EOF.
      if (start === end) {
        if (end < text.length) {
          end++;
        } else if (start > 0) {
          start--;
        }
      }

      const range = new vscode.Range(
        document.positionAt(start),
        document.positionAt(end)
      );

      const diagnostic = new vscode.Diagnostic(
        range,
        error.message,
        vscode.DiagnosticSeverity.Error
      );

      diagnostic.source =
        document.languageId === "snomed-etl"
          ? "SNOMED ETL"
          : "SNOMED SCG";

      return diagnostic;
    });

    diagnostics.set(document.uri, items);
  }

  // Debounce validation while typing.
  function scheduleValidation(document) {
    if (!supportedLanguages.has(document.languageId)) {
      diagnostics.delete(document.uri);
      return;
    }

    const key = document.uri.toString();
    clearTimeout(timers.get(key));

    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        validate(document);
      }, 200)
    );
  }

  context.subscriptions.push(
    diagnostics,

    vscode.workspace.onDidOpenTextDocument(document => {
      validate(document);
    }),

    vscode.workspace.onDidChangeTextDocument(event => {
      scheduleValidation(event.document);
    }),

    vscode.workspace.onDidSaveTextDocument(document => {
      validate(document);
    }),

    vscode.workspace.onDidCloseTextDocument(document => {
      const key = document.uri.toString();

      clearTimeout(timers.get(key));
      timers.delete(key);
      diagnostics.delete(document.uri);
    }),

    {
      dispose() {
        for (const timer of timers.values()) {
          clearTimeout(timer);
        }
        timers.clear();
      }
    }
  );

  // Validate documents already open.
  for (const document of vscode.workspace.textDocuments) {
    validate(document);
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
